import { readFile } from "node:fs/promises";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({
  productionBroker: true,
  largeSidebar: true,
  historyCounts: { alpha: 20, beta: 20 },
});
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
  // Establish a cold target deterministically: let the actual label read own
  // the background slot before preferences release the roster warmer. Hold the
  // host decoder, not a reader slot; demand and all production owners stay real.
  const preferences = Promise.withResolvers();
  let preferencesPending = false;
  await page.route("**/sidebar-preferences", async (route) => {
    preferencesPending = true;
    await preferences.promise;
    await route.fallback();
  });
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
    expect(app.report.profileHolds.some((held) => held.pending)).toBe(true);
    await expect.poll(() => preferencesPending).toBe(true);
    const decoded = page.waitForResponse(
      (response) =>
        response.url().endsWith("/sidebar-preferences") && response.ok(),
    );
    preferences.resolve();
    await decoded;
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
                  `[role="textbox"][aria-label="Message #${name}"]`,
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
    preferences.resolve();
    app.relay.releaseEose("alpha");
    app.relay.releaseEose("beta");
    app.relay.releaseProfiles();
    await page.unrouteAll({ behavior: "wait" });
  }
});
