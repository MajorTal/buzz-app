import { readFile } from "node:fs/promises";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ productionBroker: true, largeSidebar: true });
const heads = (app, channel) =>
  app.report.queries.filter(
    ({ filter }) =>
      filter.kinds?.includes(9) &&
      filter.top_level === true &&
      filter["#h"]?.includes(channel) &&
      filter.until === undefined,
  );

test("cold opening bypasses held DM labels; warm switching paints within 100ms without a head read", {
  tag: "@local-webkit",
}, async ({ page, app }) => {
  const submittedHeads = [];
  page.on("request", (request) => {
    if (!new URL(request.url()).pathname.endsWith("/query")) return;
    for (const filter of request.postDataJSON() ?? [])
      if (
        filter.kinds?.includes(9) &&
        filter.top_level === true &&
        filter.until === undefined
      )
        submittedHeads.push(filter);
  });
  const labelReads = () =>
    app.report.queries.filter(
      ({ filter }) =>
        filter.kinds?.includes(0) &&
        filter.authors?.some((id) => app.participants.includes(id)),
    );
  app.relay.holdProfiles(app.participants);
  app.relay.holdEose("alpha");
  app.relay.holdEose("beta");
  // A visible pre-establishment head is not a warm, verified cache. A signed
  // missed message proves the catch-up reached the UI, not merely the broker.
  const establish = async (channel) => {
    expect(heads(app, channel)).toHaveLength(1);
    const missed = app.append(
      "primary",
      channel,
      "Startup catch-up marker",
      false,
    );
    app.relay.releaseEose(channel);
    await expect(
      page.locator(`[data-message-id="${missed.id}"]`),
    ).toBeVisible();
    expect(heads(app, channel)).toHaveLength(2);
  };
  try {
    await open(page, app);
    await establish("alpha");
    await expect.poll(() => labelReads().length).toBe(1);
    expect(labelReads()[0].filter.authors).toHaveLength(500);
    // The actual label hook has >1,000 missing participants. Keep its profile
    // response held through cold opening; do not bypass that production caller.
    expect(heads(app, "beta")).toHaveLength(0);
    await page
      .getByRole("button", { name: "Beta", exact: true })
      .evaluate((button) => {
        performance.mark("cold-beta-click");
        button.click();
      });
    await expect(
      page.getByRole("textbox", { name: "Message #Beta", exact: true }),
    ).toBeVisible();
    await expect(page.locator("[data-message-id]").first()).toBeVisible();
    app.report.measurements.push({
      name: "Beta",
      coldVisibleUpperBoundMs: await page.evaluate(
        () =>
          performance.now() -
          performance.getEntriesByName("cold-beta-click").at(-1).startTime,
      ),
      note: "Includes Playwright visibility assertion roundtrip; warm times use browser paint clock",
    });
    expect(heads(app, "beta").length).toBeGreaterThan(0);
    expect(app.report.profileHolds.some((held) => held.pending)).toBe(true);
    expect(app.report.profileHolds.some((held) => held.aborted)).toBe(false);
    await establish("beta");
    const before = submittedHeads.length;
    // Browser-clock click → first visible row → paint, excluding Playwright IPC.
    for (const name of ["Alpha", "Beta", "Alpha", "Beta"]) {
      const visibleMs = await page
        .getByRole("button", { name, exact: true })
        .evaluate(
          async (button, { name, ids }) => {
            const start = performance.now();
            button.click();
            await new Promise((resolve, reject) => {
              const deadline = setTimeout(
                () => reject(new Error("warm switch did not paint")),
                1000,
              );
              const check = () => {
                const composer = document.querySelector(
                  `textarea[placeholder="Message #${name}"]`,
                );
                const history = document.querySelector(
                  '[aria-label="Channel message history"]',
                );
                const rect = history?.getBoundingClientRect();
                const visible =
                  rect &&
                  [...history.querySelectorAll("[data-message-id]")].some(
                    (row) => {
                      const bounds = row.getBoundingClientRect();
                      return (
                        ids.includes(row.dataset.messageId) &&
                        bounds.height > 0 &&
                        bounds.bottom > rect.top &&
                        bounds.top < rect.bottom
                      );
                    },
                  );
                if (!visible || !composer) return requestAnimationFrame(check);
                requestAnimationFrame(() => {
                  clearTimeout(deadline);
                  resolve();
                });
              };
              requestAnimationFrame(check);
            });
            return performance.now() - start;
          },
          {
            name,
            ids: app.histories
              .get(`primary/${name.toLowerCase()}`)
              .map((event) => event.id),
          },
        );
      app.report.measurements.push({ name, warmVisibleMs: visibleMs });
      expect(visibleMs).toBeLessThan(100);
    }
    expect(submittedHeads).toHaveLength(before);
    const diagnostics = page
      .locator("summary")
      .filter({ hasText: /^Relay timings$/ });
    await diagnostics.evaluate((element) => {
      for (
        let parent = element.parentElement;
        parent;
        parent = parent.parentElement
      )
        if (parent.tagName === "DETAILS") parent.open = true;
    });
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export timings" }).click();
    const timings = await download;
    app.report.relayTimings = JSON.parse(
      await readFile(await timings.path(), "utf8"),
    );
    expect(app.report.profileHolds.some((held) => held.pending)).toBe(true);
    expect(app.report.profileHolds.some((held) => held.aborted)).toBe(false);
  } finally {
    app.relay.releaseEose("alpha");
    app.relay.releaseEose("beta");
    app.relay.releaseProfiles();
  }
});

test.describe("large thread opening", () => {
  test.use({
    readState: true,
    largeSidebar: false,
    threadUnread: true,
    presenceThreadAuthors: 300,
  });
  test("300-author thread opening retains bounded traversal and measures cold/reopened rendering", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const { root } = app.presenceThread;
    const trigger = page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ });
    const history = page.getByRole("region", {
      name: "Thread messages",
      exact: true,
    });
    for (const phase of ["cold", "reopened"]) {
      const timing = await trigger.evaluate(async (button) => {
        const start = performance.now();
        button.click();
        let firstPaint;
        await new Promise((resolve, reject) => {
          const deadline = setTimeout(
            () => reject(new Error("thread did not finish traversal")),
            10000,
          );
          const check = () => {
            const panel = document.querySelector(
              '[aria-label="Thread messages"]',
            );
            const rows = panel?.querySelectorAll("[data-message-id]");
            const rect = panel?.getBoundingClientRect();
            const visible =
              rect &&
              [...rows].some((row) => {
                const bounds = row.getBoundingClientRect();
                return (
                  bounds.height > 0 &&
                  bounds.bottom > rect.top &&
                  bounds.top < rect.bottom
                );
              });
            if (visible && firstPaint === undefined)
              firstPaint = performance.now() - start;
            if (
              !visible ||
              rows.length !== 301 ||
              panel.textContent.includes("Loading thread…")
            )
              return requestAnimationFrame(check);
            requestAnimationFrame(() => {
              clearTimeout(deadline);
              resolve();
            });
          };
          requestAnimationFrame(check);
        });
        return {
          firstVisibleMs: firstPaint,
          fullTraversalPaintMs: performance.now() - start,
        };
      });
      app.report.measurements.push({
        scenario: "300-author-thread",
        phase,
        ...timing,
      });
      await expect(history.locator("[data-message-id]")).toHaveCount(301);
      await expect(
        history.getByText("Distinct author reply 299", { exact: true }),
      ).toBeInViewport();
      await page
        .getByRole("button", { name: "Close thread", exact: true })
        .click();
      await expect(history).toHaveCount(0);
    }
  });
});
