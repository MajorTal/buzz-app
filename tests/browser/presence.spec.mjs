import { test, expect } from "./fixture.mjs";
import { open, settle } from "./timeline.mjs";
test.use({ productionBroker: true, readState: true });

test("profile snapshot and same-socket renewal coexist with real chat while optional response is held", async ({
  page,
  app,
}) => {
  app.relay.holdPresence();
  await open(page, app);
  await expect.poll(() => app.relay.hasRoute("primary", "alpha")).toBe(true);
  await expect.poll(() => app.relay.hasRoute("primary", "beta")).toBe(true);
  await expect(
    page.getByRole("button", { name: "Retry live updates", exact: true }),
  ).toHaveCount(0);
  await settle(page);
  try {
    await page
      .getByRole("button", { name: "View Alice Fixture profile", exact: true })
      .first()
      .click();
    const profile = page.getByRole("region", { name: "Profile details" });
    await expect(profile).toBeVisible();
    await expect(
      profile.getByRole("img", { name: "Presence: unknown" }),
    ).toBeVisible();
    // Narrowing the timeline for the profile can demand an older page. This
    // fixture deliberately holds those pages; retire that foreground work first.
    await expect
      .poll(() => {
        for (const pending of app.pending.splice(0)) pending.release();
        return app.report.presenceSnapshots.some(
          (snapshot) => snapshot.pending,
        );
      })
      .toBe(true);
    const composer = page.getByRole("textbox", {
      name: "Message #Alpha",
      exact: true,
    });
    await composer.fill("Presence cannot hold this conversation");
    const start = performance.now();
    await composer.press("Enter");
    await expect
      .poll(() =>
        app.report.publications.some(
          ({ event }) =>
            event?.content === "Presence cannot hold this conversation",
        ),
      )
      .toBe(true);
    app.report.measurements.push({
      sendWhilePresenceHeldMs: performance.now() - start,
    });
    expect(
      app.report.presenceSnapshots.some((snapshot) => snapshot.pending),
    ).toBe(true);
    const live = app.append(
      "primary",
      "alpha",
      "Incoming while presence is held",
    );
    await expect(page.locator(`[data-message-id="${live.id}"]`)).toBeVisible();
    expect(
      app.report.presenceSnapshots.some((snapshot) => snapshot.pending),
    ).toBe(true);
    app.relay.releasePresence();
    await expect(
      profile.getByRole("img", { name: "Presence: online" }),
    ).toBeVisible();
    // Startup may skip busy setup. Keep real time: advancing only browser time
    // would expire its SSE heartbeat without advancing the broker's keepalive.
    await expect
      .poll(() => app.report.presencePublications.length, { timeout: 75000 })
      .toBeGreaterThan(0);
    expect(
      app.relay.requests.some(({ filter }) => filter.kinds.includes(20001)),
    ).toBe(false);
    await profile.screenshot({
      path: test.info().outputPath("presence-profile.png"),
    });
  } finally {
    app.relay.releasePresence();
  }
});

test("foreground send and cold channel entry remain available during a profile snapshot", async ({
  page,
  app,
}) => {
  app.relay.holdPresence();
  await open(page, app);
  await expect.poll(() => app.relay.hasRoute("primary", "alpha")).toBe(true);
  await expect.poll(() => app.relay.hasRoute("primary", "beta")).toBe(true);
  await settle(page);
  try {
    await page
      .getByRole("button", { name: "View Alice Fixture profile", exact: true })
      .first()
      .click();
    const profile = page.getByRole("region", { name: "Profile details" });
    await expect(profile).toBeVisible();
    await expect
      .poll(() => {
        for (const pending of app.pending.splice(0)) pending.release();
        return app.report.presenceSnapshots.some(({ pending }) => pending);
      })
      .toBe(true);
    await settle(page);
    const composer = page.getByRole("textbox", {
      name: "Message #Alpha",
      exact: true,
    });
    await composer.fill("Measured foreground publication");
    const start = performance.now();
    await composer.press("Enter");
    await expect
      .poll(
        () =>
          app.report.publications.some(
            ({ event }) => event.content === "Measured foreground publication",
          ),
        { intervals: [10] },
      )
      .toBe(true);
    const sendMs = performance.now() - start;
    expect(app.report.presenceSnapshots.some(({ pending }) => pending)).toBe(
      true,
    );
    const betaHeads = () =>
      app.report.queries.filter(
        ({ filter }) =>
          filter.kinds?.includes(9) &&
          filter.top_level === true &&
          filter["#h"]?.includes("beta") &&
          filter.until === undefined,
      );
    expect(betaHeads()).toHaveLength(0);
    const visibleMs = await page
      .getByRole("button", { name: "Beta", exact: true })
      .evaluate(
        async (button, ids) => {
          const start = performance.now();
          button.click();
          await new Promise((resolve, reject) => {
            const deadline = setTimeout(
              () => reject(new Error("cold channel did not paint")),
              5000,
            );
            const check = () => {
              const history = document.querySelector(
                '[aria-label="Channel message history"]',
              );
              const bounds = history?.getBoundingClientRect();
              const visible =
                bounds &&
                [...history.querySelectorAll("[data-message-id]")].some(
                  (row) => {
                    const rect = row.getBoundingClientRect();
                    return (
                      ids.includes(row.dataset.messageId) &&
                      rect.height > 0 &&
                      rect.bottom > bounds.top &&
                      rect.top < bounds.bottom
                    );
                  },
                );
              if (
                !visible ||
                !document.querySelector('textarea[placeholder="Message #Beta"]')
              )
                return requestAnimationFrame(check);
              requestAnimationFrame(() => {
                clearTimeout(deadline);
                resolve();
              });
            };
            requestAnimationFrame(check);
          });
          return performance.now() - start;
        },
        app.histories.get("primary/beta").map(({ id }) => id),
      );
    expect(betaHeads().length).toBeGreaterThan(0);
    // Closing the contextual profile may abort optional work; do not require
    // an unnecessary snapshot to survive navigation just to satisfy this test.
    app.report.measurements.push({
      sendMs,
      coldVisibleMs: visibleMs,
      note: "send includes automation/polling; cold uses browser click-to-paint clock",
    });
  } finally {
    app.relay.releasePresence();
  }
});

test.describe("mounted conversation demand", () => {
  test.use({ threadUnread: true });
  test("timeline and thread author indicators share one bounded snapshot", async ({
    page,
    app,
  }) => {
    app.relay.holdPresence();
    await open(page, app);
    const timeline = page.locator("[data-channel-timeline]");
    await expect(
      timeline.getByRole("img", { name: "Presence: unknown" }).first(),
    ).toBeVisible();
    await expect.poll(() => app.report.presenceSnapshots.length).toBe(1);
    app.relay.releasePresence();
    await expect(
      timeline.getByRole("img", { name: "Presence: online" }).first(),
    ).toBeVisible();
    const root = app.histories
      .get("primary/alpha")
      .find((row) => row.content === "Thread root 0");
    await timeline
      .locator(`[data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ })
      .click();
    const thread = page.getByRole("region", {
      name: "Thread messages",
      exact: true,
    });
    await expect(
      thread.getByText("Unread reply 0", { exact: true }),
    ).toBeVisible();
    await expect(
      thread.getByRole("img", { name: "Presence: online" }).last(),
    ).toBeVisible();
    expect(app.report.presenceSnapshots).toHaveLength(1);
    expect(app.report.presenceSnapshots[0].filter.authors).toHaveLength(1);
    expect(
      app.relay.requests.some(({ filter }) => filter.kinds.includes(20001)),
    ).toBe(false);
  });
});

test.describe("large mounted thread", () => {
  test.use({ threadUnread: true, presenceThreadAuthors: 300 });
  test("distinct thread authors stay bounded through loading, scrolling and unmount", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const { root, replies } = app.presenceThread;
    const trigger = page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ });
    const thread = page.getByRole("region", {
      name: "Thread messages",
      exact: true,
    });
    const start = performance.now();
    await trigger.click();
    await expect(
      thread.getByText("300 replies shown", { exact: true }),
    ).toBeVisible();
    await expect(
      thread.getByText("Loading thread…", { exact: true }),
    ).toHaveCount(0);
    await expect(thread.locator("[data-message-id]")).toHaveCount(301);
    app.report.measurements.push({
      threadLoadUpperBoundMs: performance.now() - start,
      distinctAuthors: 300,
    });
    // Query starts, rather than UI row counts, prove the actual transport cap.
    await expect
      .poll(() =>
        app.report.presenceSnapshots.some(
          ({ filter }) => filter.authors.length === 256,
        ),
      )
      .toBe(true);
    await expect(
      thread.locator('[title="Presence demand limit reached"]'),
    ).toHaveCount(45);
    await expect(
      thread.getByRole("img", { name: "Presence: online", exact: true }),
    ).toHaveCount(256);
    const first = thread.locator(`[data-message-id="${replies[0].id}"]`);
    const last = thread.locator(`[data-message-id="${replies.at(-1).id}"]`);
    await expect(last).toBeInViewport();
    await thread.focus();
    await page.keyboard.press("Control+Home");
    // Use actual input; native key handling differs by engine/platform.
    await first.scrollIntoViewIfNeeded();
    await expect(first).toBeInViewport();
    await thread.hover();
    const before = await thread.evaluate((el) => el.scrollTop);
    await page.mouse.wheel(0, 500);
    await expect
      .poll(() => thread.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(before);
    const count = app.report.presenceSnapshots.length;
    await page
      .getByRole("button", { name: "Close thread", exact: true })
      .click();
    await expect(thread).toHaveCount(0);
    // Hold the replacement read: eventual Online alone cannot prove old evidence
    // was absent between remounting and response completion.
    app.relay.holdPresence();
    try {
      const reopen = performance.now();
      await trigger.click();
      await expect(
        thread.getByText("300 replies shown", { exact: true }),
      ).toBeVisible();
      await expect(
        thread.getByText("Loading thread…", { exact: true }),
      ).toHaveCount(0);
      app.report.measurements.push({
        threadReopenUpperBoundMs: performance.now() - reopen,
      });
      await expect
        .poll(() => app.report.presenceSnapshots.length)
        .toBeGreaterThan(count);
      expect(app.report.presenceSnapshots.at(-1).pending).toBe(true);
      // The root remains mounted in the timeline; all 300 distinct reply authors
      // were released, so only the root may retain its existing Online value.
      await expect(
        thread
          .locator("ol")
          .getByRole("img", { name: "Presence: unknown", exact: true }),
      ).toHaveCount(300);
    } finally {
      app.relay.releasePresence();
    }
    await expect(
      thread.getByRole("img", { name: "Presence: online", exact: true }),
    ).toHaveCount(256);
    for (const { filter } of app.report.presenceSnapshots) {
      expect(filter.authors.length).toBeLessThanOrEqual(256);
      expect(new Set(filter.authors).size).toBe(filter.authors.length);
    }
    const starts = app.report.queries.filter(({ filter }) =>
      filter.kinds?.includes(20001),
    );
    for (let i = 1; i < starts.length; i++)
      expect(starts[i].at - starts[i - 1].at).toBeGreaterThanOrEqual(4990);
    expect(
      app.relay.requests.some(({ filter }) => filter.kinds.includes(20001)),
    ).toBe(false);
  });
});

test("real same-origin windows queue one publisher and transfer its Web Lock on close", async ({
  page,
  context,
  app,
}) => {
  await open(page, app);
  const presenceLocks = (target) =>
    target.evaluate(async () => {
      const locks = await navigator.locks.query();
      const select = (entries) =>
        entries.filter(({ name }) => name.startsWith("buzz-presence:"));
      return { held: select(locks.held), pending: select(locks.pending) };
    });
  await expect
    .poll(async () => (await presenceLocks(page)).held.length)
    .toBe(1);
  const owner = (await presenceLocks(page)).held[0];
  const second = await context.newPage();
  const errors = [];
  second.on("pageerror", (error) => errors.push(error.message));
  second.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  try {
    await open(second, app);
    await expect
      .poll(async () => (await presenceLocks(second)).pending.length)
      .toBe(1);
    const both = await presenceLocks(second);
    expect(both.held).toHaveLength(1);
    expect(both.held[0].clientId).toBe(owner.clientId);
    expect(both.pending[0].name).toBe(owner.name);
    const successor = both.pending[0].clientId;
    await page.close();
    await expect
      .poll(async () => (await presenceLocks(second)).held[0]?.clientId)
      .toBe(successor);
    expect((await presenceLocks(second)).pending).toHaveLength(0);
    const before = app.report.presencePublications.length;
    await expect
      .poll(() => app.report.presencePublications.length, { timeout: 75000 })
      .toBeGreaterThan(before);
    expect(errors).toEqual([]);
    app.report.measurements.push({
      publisherLockHandoff: { owner: owner.clientId, successor },
    });
  } finally {
    await second.close();
  }
});
