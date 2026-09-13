import { readFile } from "node:fs/promises";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

const snapshots = (app) =>
  app.report.queries.filter(({ filter }) => filter.kinds?.includes(20001));
const ordinaryStarts = (app) =>
  app.report.queries.filter(({ filter }) => !filter.kinds?.includes(20001));
const headRequest = (request) =>
  new URL(request.url()).pathname.endsWith("/query") &&
  request
    .postDataJSON()
    ?.some(
      (f) =>
        f.kinds?.includes(9) &&
        f["#h"]?.[0] === "beta" &&
        f.top_level &&
        f.until === undefined,
    );

// Optimistic text alone is not delivery: only verified observation removes the
// exact event from the outbox. Keep this same criterion in the race controls.
export async function confirmedSend(page, event) {
  await expect(page.locator(`[data-message-id="${event.id}"]`)).toContainText(
    event.content,
  );
  await expect(
    page.locator("summary").filter({ hasText: /^Outbox ·/ }),
  ).toHaveText("Outbox · 0 items");
}

export function contentionTests(withoutPresence) {
  test.describe(
    withoutPresence ? "no-presence control" : "held presence",
    () => {
      for (const action of ["send", "open"]) {
        test(`presence contention: ${action} does not inherit optional HTTP pacing`, async ({
          page,
          app,
        }) => {
          await open(page, app);
          const composer = page.getByRole("textbox", {
            name: "Message #Alpha",
            exact: true,
          });
          if (action === "send")
            await composer.fill("Foreground contention probe");
          if (!withoutPresence) {
            await expect(
              page
                .locator(
                  '[aria-label="Channel message history"] [data-presence-status="online"]',
                )
                .first(),
            ).toBeVisible();
            expect(snapshots(app).length).toBeGreaterThan(0);
          } else {
            expect(snapshots(app)).toHaveLength(0);
            expect(app.report.presencePublications).toHaveLength(0);
          }
          // Compare the same idle ordinary lane, never a preloaded foreground lane
          // against an idle control. Presence must be the only new pacing input.
          await expect
            .poll(() => performance.now() - ordinaryStarts(app).at(-1).at)
            .toBeGreaterThan(550);
          const before = snapshots(app).length;
          let held;
          if (!withoutPresence) {
            const started = new Promise((resolve) =>
              app.relay.holdPresence(resolve),
            );
            app.presence("away"); // real signed conflict -> directory -> reader -> broker
            held = await started;
            expect(snapshots(app)).toHaveLength(before + 1);
            expect(held.pending).toBe(true);
          }
          const phaseAt = held?.at ?? performance.now();
          const requestMatch =
            action === "open"
              ? headRequest
              : (request) =>
                  new URL(request.url()).pathname.endsWith("/publish");
          // A verified live echo legitimately aborts an outstanding send ACK.
          // Reads still require the response; sends prove delivery independently.
          const response =
            action === "open"
              ? page.waitForResponse((response) =>
                  requestMatch(response.request()),
                )
              : undefined;
          let browserRequestObservedAt, browserRequestUrl;
          const browserOutcomes = [];
          const observe = (request) => {
            if (requestMatch(request)) {
              browserRequestObservedAt = performance.now();
              browserRequestUrl = request.url();
            }
          };
          const received = (reply) => {
            if (requestMatch(reply.request()))
              browserOutcomes.push({
                status: reply.status(),
                at: performance.now(),
              });
          };
          const failed = (request) => {
            if (requestMatch(request))
              browserOutcomes.push({
                error: request.failure()?.errorText,
                at: performance.now(),
              });
          };
          page.on("request", observe);
          page.on("response", received);
          page.on("requestfailed", failed);
          const priorBroker = app.report.brokerRequests.length;
          const priorPublications = app.report.publications.length;
          let sentEvent;
          try {
            if (action === "send") {
              await composer.evaluate((input) => {
                performance.mark("presence-foreground-intent");
                input.form.requestSubmit();
              });
            } else {
              expect(
                ordinaryStarts(app).filter(
                  ({ filter }) =>
                    filter.top_level && filter["#h"]?.[0] === "beta",
                ),
              ).toHaveLength(0);
              await page
                .getByRole("button", { name: "Beta", exact: true })
                .evaluate((button) => {
                  performance.mark("presence-foreground-intent");
                  button.click();
                });
            }
            const reply = await response;
            if (reply) expect(reply.status()).toBe(200);
            if (action === "send") {
              await expect
                .poll(() => app.report.publications.length)
                .toBe(priorPublications + 1);
              sentEvent = app.report.publications[priorPublications].event;
              await confirmedSend(page, sentEvent);
            }
            const candidates = app.report.brokerRequests
              .slice(priorBroker)
              .filter(({ url }) =>
                url.endsWith(action === "send" ? "/publish" : "/query"),
              );
            expect(
              candidates,
              "foreground host timing must be unambiguous",
            ).toHaveLength(1);
            const broker = candidates[0];
            const upstream =
              action === "send"
                ? app.report.publications.at(-1)
                : ordinaryStarts(app).find(
                    ({ filter, at }) =>
                      at >= phaseAt &&
                      filter.top_level &&
                      filter["#h"]?.[0] === "beta",
                  );
            // Host completion survives browser cancellation, without claiming
            // that a closed socket or an optimistic row means acceptance.
            await expect.poll(() => broker.finish?.finished).toBe(true);
            expect(broker.finish.status).toBe(200);
            const serverTiming = broker.finish.serverTiming;
            if (reply)
              expect(await reply.headerValue("server-timing")).toBe(
                serverTiming,
              );
            const admissionMs = Number(
              serverTiming?.match(/(?:^|,\s*)admission;dur=([\d.]+)/)?.[1],
            );
            const browserTiming = await page.evaluate(
              ({ url, received }) => {
                const intent = performance
                  .getEntriesByName("presence-foreground-intent")
                  .at(-1).startTime;
                const resource = performance.getEntriesByName(url).at(-1);
                return {
                  intent,
                  requestStart: resource?.startTime,
                  responseEnd: resource?.responseEnd,
                  intentToRequestMs: resource
                    ? resource.startTime - intent
                    : null,
                  intentToResponseMs:
                    received && resource ? resource.responseEnd - intent : null,
                };
              },
              {
                url: browserRequestUrl,
                received: browserOutcomes.some(
                  (outcome) => outcome.status === 200,
                ),
              },
            );
            app.report.measurements.push({
              action,
              withoutPresence,
              phaseAt,
              browserRequestObservedAt,
              note: "Browser request event observed on runner clock; not a hardware input or renderer timestamp",
              brokerAt: broker.at,
              upstreamAt: upstream.at,
              arrivalAfterSnapshotMs: broker.at - phaseAt,
              brokerToUpstreamMs: upstream.at - broker.at,
              admissionMs,
              serverTiming,
              browserTiming,
              browserOutcomes,
              hostResponse: { ...broker.finish },
              ...(sentEvent ? { confirmedEventId: sentEvent.id } : {}),
              held: held && { ...held },
            });
            // This phase check is crucial: arriving after 500 ms would make old code pass.
            expect(broker.at - phaseAt).toBeGreaterThanOrEqual(0);
            expect(broker.at - phaseAt).toBeLessThan(200);
            expect(Number.isFinite(admissionMs)).toBe(true);
            expect(admissionMs).toBeLessThan(100);
            expect(upstream.at - broker.at).toBeLessThan(150);
            if (held) {
              expect(held.pending || held.aborted).toBe(true);
              if (held.aborted)
                expect(held.completedAt).toBeGreaterThanOrEqual(phaseAt);
              // Sending must not depend on a snapshot completion/cancellation.
              if (action === "send") expect(held.pending).toBe(true);
            }
            if (action === "send") {
              await expect(
                page.getByText("Foreground contention probe", { exact: true }),
              ).toBeVisible();
              await expect(composer).toHaveValue("");
            } else {
              await expect(
                page.getByRole("textbox", {
                  name: "Message #Beta",
                  exact: true,
                }),
              ).toBeVisible();
              await expect(
                page.locator("[data-message-id]").first(),
              ).toBeVisible();
            }
            expect(app.report.quotaCharges.length).toBeGreaterThan(0);
            expect(
              app.report.quotaCharges.every((charge) => charge.accepted),
            ).toBe(true);
            expect(app.report.quotaRefusals).toEqual([]);
            // Existing production profiler records read.queue/fetch/verify and
            // write stages separately. Export after the timed action, not during it.
            await page
              .locator("summary")
              .filter({ hasText: /^Relay timings$/ })
              .evaluate((element) => {
                for (
                  let parent = element.parentElement;
                  parent;
                  parent = parent.parentElement
                )
                  if (parent.tagName === "DETAILS") parent.open = true;
              });
            const download = page.waitForEvent("download");
            await page.getByRole("button", { name: "Export timings" }).click();
            app.report.relayTimings = JSON.parse(
              await readFile(await (await download).path(), "utf8"),
            );
            if (sentEvent)
              expect(app.report.relayTimings).toContainEqual(
                expect.objectContaining({
                  id: sentEvent.id,
                  stage: "send.delivery",
                  outcome: "ok",
                }),
              );
            if (withoutPresence) {
              expect(snapshots(app)).toHaveLength(0);
              expect(app.report.presencePublications).toHaveLength(0);
              expect(
                app.report.liveRequests.filter(({ filter }) =>
                  filter.kinds.includes(20001),
                ),
              ).toHaveLength(0);
            }
          } finally {
            page.off("request", observe);
            page.off("response", received);
            page.off("requestfailed", failed);
            app.relay.releasePresence();
          }
        });
      }
    },
  );
}
