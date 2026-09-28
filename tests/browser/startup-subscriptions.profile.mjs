import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { test, expect } from "./fixture.mjs";

// Explicit scale experiment, not a normal CI journey. Real built UI, broker,
// signing and session; modeled upstream quota/40ms EOSE, no deployed relay I/O.
const channels = [
  "alpha",
  "beta",
  ...Array.from(
    { length: 330 },
    (_, i) => `channel-${String(i).padStart(3, "0")}`,
  ),
];
test.use({
  productionBroker: true,
  actionProfile: true,
  threadUnread: true,
  channelIds: channels,
  historyCounts: Object.fromEntries(
    channels.map((id) => [id, id === "alpha" ? 2 : 1]),
  ),
});
for (const budget of [50, 100]) {
  test(`startup of 334 routes with ${budget} frames per five seconds`, async ({
    page,
    app,
  }) => {
    app.relay.startupQuota(budget);
    const start = performance.now();
    await page.goto(app.origin);
    await expect(
      page
        .locator('[aria-label="Channel message history"] [data-message-id]')
        .first(),
    ).toBeVisible();
    const historyVisibleMs = performance.now() - start;
    const draft = page.getByRole("textbox", {
      name: "Message #Alpha",
      exact: true,
    });
    await draft.fill("Message during startup");
    const receipt = page.waitForResponse(
      (response) =>
        response.url().endsWith("/publish") &&
        response.request().postDataJSON()?.kind === 9,
    );
    const sendAt = performance.now();
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    const response = await receipt;
    const receiptBody = await response.json();
    const sent = app.report.publications.find((p) => p.event.kind === 9);
    const messageOutcome = {
      status: response.status(),
      receipt: receiptBody,
      accepted: response.ok() && receiptBody.accepted === true,
    };
    const messageAcceptedMs = sent ? sent.at - sendAt : null;
    // Preserve a refused baseline as a measured outcome. Assert success after
    // recording full startup, not before collecting the rest of the evidence.
    // A lifecycle barrier for ALL routes, not merely visible Alpha or a stable
    // request count while the scheduler is waiting for its next admission.
    await expect
      .poll(
        () => {
          return app.relay.sockets.some((s, socket) => {
            const live = new Set(
              app.report.startupFrames
                .filter((f) => f.socket === socket && f.frame[0] === "EOSE")
                .map((f) => f.frame[1]),
            );
            return (
              s.readyState === 1 &&
              channels.every((channel) =>
                [...s.routes].some(
                  ([id, filters]) =>
                    filters.some((filter) => filter["#h"]?.includes(channel)) &&
                    live.has(id),
                ),
              ) &&
              [...s.routes.keys()].every((id) => live.has(id))
            );
          });
        },
        { timeout: 110000 },
      )
      .toBe(true);
    const completeMs = performance.now() - start;
    const requests = app.report.liveRequests.filter(
      (r) => r.community === "primary",
    );
    const frames = app.report.wsAdmissions.filter(
      (f) => f.community === "primary",
    );
    const first = requests[0].at;
    const peak = (events, ms) =>
      Math.max(
        ...events.map(
          (r) => events.filter((x) => x.at >= r.at && x.at < r.at + ms).length,
        ),
      );
    const selected = requests.find((r) => r.routes.includes("alpha"));
    const eos = app.report.startupFrames.filter((f) => f.frame[0] === "EOSE");
    const selectedEose = eos.find(
      (f) => f.socket === selected.socket && f.frame[1] === selected.id,
    );
    const hashes = {};
    for (const file of [
      "src/features/relay/live.ts",
      "tests/browser/policy-relay.mjs",
      "tests/browser/startup-subscriptions.profile.mjs",
    ]) {
      hashes[file] = createHash("sha256")
        .update(await readFile(file))
        .digest("hex");
    }
    app.report.startupProfile = {
      budget,
      channelRoutes: channels.length,
      globalRoutes: 2,
      observerRequests: requests.filter((r) => r.routes.includes("observer"))
        .length,
      historyVisibleMs,
      messageAcceptedMs,
      messageOutcome,
      completeMs,
      requests: requests.length,
      wsFilters: requests.reduce(
        (count, request) => count + request.filters.length,
        0,
      ),
      maxFiltersPerReq: Math.max(
        ...requests.map((request) => request.filters.length),
      ),
      quotaRefusals: frames.filter((f) => !f.accepted).length,
      publicationRefusals: frames.filter(
        (f) => f.kind === "EVENT" && !f.accepted,
      ).length,
      peakRollingSecond: peak(requests, 1000),
      peakRollingFiveSeconds: peak(requests, 5000),
      peakAllFramesFiveSeconds: peak(frames, 5000),
      selectedReqMs: selected.at - first,
      selectedEoseMs: selectedEose.at - first,
      lastEoseMs: eos.at(-1).at - first,
      setupSpanMs: requests.at(-1).at - first,
      upstreamQueryFiltersAtCoverage: app.report.queries.length,
      hashes,
    };
    // Smoke-test delivery through an established unselected channel and opening
    // it. The protocol lifecycle matrix belongs to the lower-layer tests.
    // Prove delivery through a non-first filter, not only the batch's first route.
    const shared = requests.find(
      (request) =>
        request.filters.length > 1 &&
        request.filters.every((filter) => filter["#h"]?.length === 1),
    );
    expect(shared).toBeDefined();
    const last = shared.filters.at(-1)["#h"][0];
    const event = app.append("primary", last, "After background establishment");
    expect(
      app.report.startupFrames.some(
        ({ socket, frame }) =>
          socket === shared.socket &&
          frame[0] === "EVENT" &&
          frame[1] === shared.id &&
          frame[2].id === event.id,
      ),
    ).toBe(true);
    await page.locator(`button[data-channel-id="${last}"]`).click();
    await expect(
      page.locator(
        `[aria-label="Channel message history"] [data-message-id="${event.id}"]`,
      ),
    ).toBeVisible();
    console.log(JSON.stringify(app.report.startupProfile));
    expect(
      messageOutcome.accepted,
      "startup must not starve the user publication",
    ).toBe(true);
  });
}
