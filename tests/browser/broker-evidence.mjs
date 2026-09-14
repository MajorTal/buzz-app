import assert from "node:assert/strict";

// Passive host evidence survives a browser abort/no-console response. No response
// is delayed, substituted or interpreted as delivery by this observer.
export function brokerEvidence(report, retiredStreams) {
  const publications = [];
  const retirements = new Map();
  report.presencePublicationResponses = publications;
  return {
    middleware(req, res, next) {
      if (!req.url?.startsWith("/api/relay/")) return next();
      const record = {
        url: req.url,
        at: performance.now(),
        priority: req.headers["x-buzz-read-priority"],
      };
      report.brokerRequests.push(record);
      const url = new URL(req.url, `http://${req.headers.host}`);
      const publishing = url.pathname.endsWith("/stream-presence-publish");
      const retiredAtArrival = publishing ? new Map(retirements) : undefined;
      const streaming = url.pathname.endsWith("/stream");
      let streamId;
      if (streaming) {
        const writeHead = res.writeHead;
        res.writeHead = function (...args) {
          // Direct writeHead headers are not retained by getHeader().
          streamId = args.at(-1)?.["X-Buzz-Live-ID"];
          return writeHead.apply(this, args);
        };
      }
      let body = "";
      if (publishing) {
        req.on("data", (chunk) => {
          if (body.length <= 256) body += chunk;
        });
        req.once("end", () => {
          try {
            record.streamId = JSON.parse(body).streamId;
          } catch {
            // Invalid/unreadable request evidence cannot classify an error.
          }
        });
        const end = res.end;
        res.end = function (chunk, ...args) {
          if (this.statusCode === 404 || this.statusCode === 503) {
            let value;
            try {
              value = JSON.parse(String(chunk));
            } catch {
              // Missing/malformed evidence remains unclassified and test-failing.
            }
            publications.push({
              url: url.href,
              streamId: record.streamId,
              at: performance.now(),
              status: this.statusCode,
              body: value ?? null,
              disposed:
                this.statusCode === 503 &&
                /^[0-9a-f]{32}$/.test(record.streamId ?? "") &&
                value?.error === "Presence publication unconfirmed" &&
                value?.code === "presence_owner_disposed" &&
                Object.keys(value).length === 2,
              // Retirement must precede arrival, not merely the eventual response
              // or fixture teardown. A different relay's stream cannot classify.
              retired:
                this.statusCode === 404 &&
                /^[0-9a-f]{32}$/.test(record.streamId ?? "") &&
                retiredAtArrival.get(record.streamId) ===
                  url.pathname.replace(
                    /\/stream-presence-publish$/,
                    "/stream",
                  ) &&
                value?.error === "Live stream no longer available" &&
                Object.keys(value).length === 1,
            });
          }
          return end.call(this, chunk, ...args);
        };
      }
      const snapshot = () => ({
        at: performance.now(),
        status: res.statusCode,
        serverTiming: res.getHeader("Server-Timing") ?? null,
        finished: res.writableFinished,
      });
      res.once("finish", () => {
        record.finish = snapshot();
      });
      res.once("close", () => {
        record.close = snapshot();
        if (streaming && /^[0-9a-f]{32}$/.test(streamId ?? "")) {
          retiredStreams.add(streamId);
          retirements.set(streamId, url.pathname);
        }
        // A destroyed/truncated error without end() remains unclassified.
        if (
          publishing &&
          [404, 503].includes(res.statusCode) &&
          !res.writableEnded
        )
          publications.push({
            url: url.href,
            streamId: record.streamId,
            status: res.statusCode,
            disposed: false,
            retired: false,
          });
      });
      next();
    },
    assertPublications() {
      assert.deepEqual(
        publications.filter((item) => !item.disposed && !item.retired),
        [],
        "Unclassified presence publication 404/503",
      );
    },
    consoleFilter() {
      // Each classified response permits at most one endpoint-qualified console
      // diagnostic. Independent publication validation prevents same-URL masking.
      const remaining = publications.filter(
        (item) => item.disposed || item.retired,
      );
      return (message, location) => {
        const match =
          /^Failed to load resource: the server responded with a status of (404|503)\b/.exec(
            message,
          );
        if (!match) return false;
        const index = remaining.findIndex(
          (item) => item.url === location && item.status === Number(match[1]),
        );
        if (index < 0) return false;
        remaining.splice(index, 1);
        return true;
      };
    },
  };
}
