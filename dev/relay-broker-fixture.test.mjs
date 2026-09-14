import { test, expect, vi } from "vitest";
import { connectBrokerTransport } from "../src/features/relay/transport.ts";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { browserFixtures } from "../tests/browser/fixture.mjs";
import { brokerEvidence } from "../tests/browser/broker-evidence.mjs";

async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(10);
  }
  throw new Error("Broker fixture did not reach expected state");
}

// Execute the actual browser fixture's server, instrumentation, teardown and
// final assertions. Only the unused browser shell is inert; HTTP/broker/WS policy
// and the 503 are real. No browser engine, live identity, or frontend build needed.
async function fixture(use, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "presence-fixture-check-"));
  await writeFile(join(directory, "index.html"), "<!doctype html>");
  const page = new EventEmitter();
  page.addInitScript = async () => {};
  page.close = async () => {};
  const options = Object.fromEntries(
    Object.entries(browserFixtures)
      .filter(([, value]) => Array.isArray(value))
      .map(([key, value]) => [key, value[0]]),
  );
  try {
    await browserFixtures.app(
      {
        ...options,
        ...overrides,
        page,
        context: { route: async () => {}, routeWebSocket: async () => {} },
        browserName: "chromium",
        browser: { version: () => "HTTP-only fixture wiring check" },
        productionBroker: true,
        // HTTP-only assertions need distinct retained records, not 1,440 signed rows.
        compactHistory: true,
        compiledApp: {
          durationMs: 0,
          config: {
            configFile: false,
            envFile: false,
            logLevel: "silent",
            build: { outDir: directory },
          },
        },
      },
      (app) => use(app, page),
      {
        workerIndex: 0,
        project: { use: {} },
        outputPath: (file) => join(directory, file),
        attach: async () => {},
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function publication(app, dispose) {
  const { origin, relay, report } = app;
  relay.holdEose("profiles");
  relay.holdEose("membership");
  const controller = new AbortController();
  const request = new AbortController();
  let pending;
  try {
    const headers = { Origin: origin, "Content-Type": "application/json" };
    const response = await fetch(`${origin}/api/relay/primary/stream`, {
      method: "POST",
      headers,
      body: JSON.stringify({ channels: [] }),
      signal: controller.signal,
    });
    const streamId = response.headers.get("x-buzz-live-id");
    const socket = relay.sockets.at(-1);
    await until(() => socket.authenticated);
    const endpoint = `${origin}/api/relay/primary/stream-presence-publish`;
    pending = fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ streamId, status: "online" }),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(3000)]),
    });
    // Observe rejection immediately, even if setup fails before the awaited receipt.
    void pending.catch(() => {});
    await until(() =>
      report.brokerRequests.some((record) => record.streamId === streamId),
    );
    // Allow the real middleware's body continuation to install the publication.
    await new Promise((resolve) => setImmediate(resolve));
    if (dispose) controller.abort();
    else {
      // Reset is an actual failure; later retirement must not classify it.
      socket.onclose();
    }
    const failed = await pending;
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({
      error: "Presence publication unconfirmed",
      ...(dispose ? { code: "presence_owner_disposed" } : {}),
    });
    return endpoint;
  } finally {
    controller.abort();
    request.abort();
    await pending?.catch(() => {});
  }
}

const console503 = (page, url) =>
  page.emit("console", {
    type: () => "error",
    text: () =>
      "Failed to load resource: the server responded with a status of 503 (Service Unavailable)",
    location: () => ({ url }),
  });

test.each(["stream", "stream-presence-publish"])(
  "%s failure is observed and closes its stream before fixture teardown",
  async (route) => {
    await fixture(async (app) => {
      const realFetch = globalThis.fetch;
      const failure = new Error("Fixture publication dispatch failed");
      let wire;
      vi.stubGlobal("fetch", (url, init) => {
        if (!String(url).endsWith(`/${route}`)) return realFetch(url, init);
        if (route === "stream")
          return realFetch(url, init).then(() => {
            throw failure;
          });
        // Dispatch through the real host so until() still waits for real evidence.
        // Reject before that boundary to exercise immediate rejection ownership.
        wire = realFetch(url, init).catch(() => {});
        return Promise.reject(failure);
      });
      try {
        await expect(publication(app, true)).rejects.toBe(failure);
        await wire;
        await until(() =>
          app.relay.sockets.every((socket) => socket.readyState === 3),
        );
      } finally {
        vi.unstubAllGlobals();
      }
    });
  },
);

test("actual fixture accounts disposal 503 without relying on browser response or console", async () => {
  await fixture(async (app) => {
    await publication(app, true);
    expect(app.report.presencePublicationResponses).toHaveLength(1);
    const record = app.report.brokerRequests.find((item) => item.streamId);
    await until(() => record.close);
    expect(record.finish).toMatchObject({
      status: 503,
      finished: true,
      serverTiming: null,
    });
    expect(record.close).toMatchObject({ status: 503, finished: true });
    expect(record.close.at).toBeGreaterThanOrEqual(record.finish.at);
  });
});

test("actual fixture fails an unclassified 503 even with no console event", async () => {
  await expect(
    fixture(async (app) => {
      await publication(app, false);
    }),
  ).rejects.toThrow("Unclassified presence publication 404/503");
});

test("same endpoint disposal console cannot hide a separate unclassified response", async () => {
  await expect(
    fixture(async (app, page) => {
      console503(page, await publication(app, true));
      await publication(app, false);
    }),
  ).rejects.toThrow("Unclassified presence publication 404/503");
});

test("one classified response permits one console diagnostic", async () => {
  await fixture(async (app, page) =>
    console503(page, await publication(app, true)),
  );
});

test("classified response is not a blanket endpoint exemption", async () => {
  await expect(
    fixture(async (app, page) => {
      const url = await publication(app, true);
      console503(page, url);
      console503(page, url);
    }),
  ).rejects.toThrow();
});

test.each([
  undefined,
  "not-json",
  JSON.stringify({ error: "Presence publication unconfirmed" }),
  JSON.stringify({
    error: "Presence publication unconfirmed",
    code: "unknown",
  }),
  JSON.stringify({
    error: "Presence publication unconfirmed",
    code: "presence_owner_disposed",
    accepted: true,
  }),
])("missing/malformed classification fails closed (%s)", (body) => {
  const report = { brokerRequests: [] };
  const evidence = brokerEvidence(report, new Set());
  const req = new EventEmitter();
  req.url = "/api/relay/primary/stream-presence-publish";
  req.headers = { host: "127.0.0.1:1234" };
  const res = new EventEmitter();
  res.statusCode = 503;
  res.end = () => {};
  evidence.middleware(req, res, () => {});
  req.emit("data", JSON.stringify({ streamId: "a".repeat(32) }));
  req.emit("end");
  res.end(body);
  expect(() => evidence.assertPublications()).toThrow(
    "Unclassified presence publication 404/503",
  );
});

async function retiredPublication(app, community = "primary") {
  const headers = { Origin: app.origin, "Content-Type": "application/json" };
  const controller = new AbortController();
  let streamId;
  try {
    const response = await fetch(`${app.origin}/api/relay/primary/stream`, {
      method: "POST",
      headers,
      body: JSON.stringify({ channels: [] }),
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    streamId = response.headers.get("x-buzz-live-id");
  } finally {
    controller.abort();
  }
  await until(() =>
    app.report.brokerRequests.some(
      (record) => record.url.endsWith("/stream") && record.close,
    ),
  );
  const endpoint = `${app.origin}/api/relay/${community}/stream-presence-publish`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ streamId, status: "online" }),
    signal: AbortSignal.timeout(3000),
  });
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    error: "Live stream no longer available",
  });
  expect(app.report.presencePublications).toEqual([]);
  return { endpoint, streamId };
}

const console404 = (page, url) =>
  page.emit("console", {
    type: () => "error",
    text: () =>
      "Failed to load resource: the server responded with a status of 404 (Not Found)",
    location: () => ({ url }),
  });

test.each([false, true])(
  "actual fixture accounts an already-retired publication 404 (console %s)",
  async (console) => {
    await fixture(async (app, page) => {
      const { endpoint, streamId } = await retiredPublication(app);
      expect(app.report.presencePublicationResponses).toEqual([
        expect.objectContaining({
          url: endpoint,
          streamId,
          status: 404,
          disposed: false,
          retired: true,
          body: { error: "Live stream no longer available" },
        }),
      ]);
      if (console) console404(page, endpoint);
    });
  },
);

test("retirement in another community cannot classify a real publication 404", async () => {
  await expect(
    fixture(async (app) => {
      await retiredPublication(app, "secondary");
    }),
  ).rejects.toThrow("Unclassified presence publication 404/503");
});

test.each([404, 503])(
  "retired 404 console cannot hide an unclassified %s at the same endpoint",
  async (status) => {
    await expect(
      fixture(async (app, page) => {
        const { endpoint } = await retiredPublication(app);
        console404(page, endpoint);
        if (status === 503) await publication(app, false);
        else {
          const response = await fetch(endpoint, {
            method: "POST",
            headers: { Origin: app.origin, "Content-Type": "application/json" },
            body: JSON.stringify({
              streamId: "0".repeat(32),
              status: "online",
            }),
          });
          expect(response.status).toBe(404);
          await response.text();
        }
      }),
    ).rejects.toThrow("Unclassified presence publication 404/503");
  },
);

test.each(["duplicate", "wrong status", "wrong endpoint"])(
  "retired publication accounting rejects %s console evidence",
  async (failure) => {
    await expect(
      fixture(async (app, page) => {
        const { endpoint } = await retiredPublication(app);
        if (failure === "duplicate") {
          console404(page, endpoint);
          console404(page, endpoint);
        } else if (failure === "wrong status") console503(page, endpoint);
        else console404(page, `${endpoint}/other`);
      }),
    ).rejects.toThrow();
  },
);

// The real fixture tests above prove production wiring. These controlled response
// boundaries cover impossible/malformed evidence without altering broker behavior.
test.each([
  { name: "current stream", retirement: "never" },
  { name: "unknown stream", requestId: "b".repeat(32) },
  { name: "malformed stream ID", requestId: "bad", streamId: "bad" },
  { name: "different relay", streamPath: "/api/relay/secondary/stream" },
  { name: "retirement during upload", retirement: "after arrival" },
  { name: "retirement after response", retirement: "after response" },
  { name: "missing body", body: undefined },
  { name: "malformed JSON", body: "not-json" },
  { name: "wrong error", body: JSON.stringify({ error: "other" }) },
  {
    name: "extra field",
    body: JSON.stringify({
      error: "Live stream no longer available",
      accepted: true,
    }),
  },
  { name: "truncated response", truncated: true },
])("publication 404 fails closed for $name", (options) => {
  const report = { brokerRequests: [] };
  const evidence = brokerEvidence(report, new Set());
  const streamId = options.streamId ?? "a".repeat(32);
  const request = (url) => {
    const req = new EventEmitter();
    req.url = url;
    req.headers = { host: "127.0.0.1:1234" };
    return req;
  };
  const response = () => {
    const res = new EventEmitter();
    res.statusCode = 200;
    res.writeHead = () => {};
    res.end = () => {};
    res.getHeader = () => undefined;
    return res;
  };
  const stream = response();
  evidence.middleware(
    request(options.streamPath ?? "/api/relay/primary/stream"),
    stream,
    () => {},
  );
  stream.writeHead(200, { "X-Buzz-Live-ID": streamId });
  const retirement = options.retirement ?? "before arrival";
  if (retirement === "before arrival") stream.emit("close");
  const req = request("/api/relay/primary/stream-presence-publish");
  const res = response();
  evidence.middleware(req, res, () => {});
  if (retirement === "after arrival") stream.emit("close");
  req.emit("data", JSON.stringify({ streamId: options.requestId ?? streamId }));
  req.emit("end");
  res.statusCode = 404;
  if (options.truncated) res.emit("close");
  else
    res.end(
      Object.hasOwn(options, "body")
        ? options.body
        : JSON.stringify({ error: "Live stream no longer available" }),
    );
  if (retirement === "after response") stream.emit("close");
  expect(report.presencePublicationResponses).toHaveLength(1);
  expect(() => evidence.assertPublications()).toThrow(
    "Unclassified presence publication 404/503",
  );
  expect(
    evidence.consoleFilter()(
      "Failed to load resource: the server responded with a status of 404 (Not Found)",
      "http://127.0.0.1:1234/api/relay/primary/stream-presence-publish",
    ),
  ).toBe(false);
});

test("passive completion evidence preserves Server-Timing and distinguishes an unfinished close", async () => {
  const report = { brokerRequests: [] };
  const evidence = brokerEvidence(report, new Set());
  const server = createServer((req, res) =>
    evidence.middleware(req, res, () => {
      res.setHeader("Server-Timing", "admission;dur=12, upstream;dur=3");
      res.writeHead(200, { "Content-Type": "text/plain" });
      if (req.url.endsWith("/complete")) res.end("accepted");
      else res.write("pending");
    }),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/relay`;
  try {
    expect(await (await fetch(`${base}/complete`)).text()).toBe("accepted");
    const controller = new AbortController();
    await fetch(`${base}/pending`, { signal: controller.signal });
    controller.abort();
    await until(() => report.brokerRequests.every((record) => record.close));
    const [complete, pending] = report.brokerRequests;
    expect(complete.finish).toMatchObject({
      status: 200,
      finished: true,
      serverTiming: "admission;dur=12, upstream;dur=3",
    });
    expect(complete.close.finished).toBe(true);
    expect(pending.finish).toBeUndefined();
    expect(pending.close).toMatchObject({
      status: 200,
      finished: false,
      serverTiming: "admission;dur=12, upstream;dur=3",
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("composer reconciliation returns only retained events from the queried community", async () => {
  await fixture(
    async (app) => {
      const records = [...app.histories.values()];
      expect(records.map((rows) => rows.length)).toEqual([1, 1, 1, 1]);
      expect(new Set(records.flat().map((event) => event.id)).size).toBe(4);
      const retained = app.histories.get("primary/alpha")[0];
      const lookup = async (community, id) => {
        const response = await fetch(
          `${app.origin}/api/relay/${community}/query`,
          {
            method: "POST",
            headers: { Origin: app.origin, "Content-Type": "application/json" },
            body: JSON.stringify([{ ids: [id], limit: 1 }]),
          },
        );
        expect(response.status).toBe(200);
        return response.json();
      };
      expect(await lookup("primary", retained.id)).toEqual([
        JSON.parse(JSON.stringify(retained)),
      ]);
      expect(await lookup("secondary", retained.id)).toEqual([]);
      expect(await lookup("primary", "f".repeat(64))).toEqual([]);
    },
    { composerPublication: true },
  );
});

// No alternate adapter or clock injection: real HTTP -> broker -> policy relay.
// Keep demand queued for a full reference quota window; measure actual upstream
// starts across all eight callers, not independent per-socket budgets.
test("eight broker callers share combined API/REQ/EVENT budgets and correlated WS cooldown", async () => {
  await fixture(
    async ({ origin, report, relay }) => {
      const realFetch = globalThis.fetch;
      // Node has no browser Origin header. Supply only that browser boundary;
      // request bodies, streaming, signing and upstream admission remain real.
      vi.stubGlobal("fetch", (url, init) =>
        realFetch(url, {
          ...init,
          headers: { ...init?.headers, Origin: origin },
        }),
      );
      const stop = new AbortController();
      const streams = [];
      const states = new Map();
      const pending = [];
      const failures = [];
      let running = true;
      try {
        const transports = await Promise.all(
          Array.from({ length: 8 }, () => connectBrokerTransport(origin)),
        );
        expect(transports.every((t) => t.presence === true)).toBe(true);
        for (const t of transports) {
          const stream = t.subscribe({
            receive() {},
            established() {},
            state(snapshot) {
              states.set(t, snapshot);
            },
            denied() {},
          });
          streams.push(stream);
        }
        for (const stream of streams) {
          // Enough real channel work to keep the ordinary shared setup lane busy
          // throughout measurement, without reconnecting/replacing a socket.
          stream.update(Array.from({ length: 40 }, (_, i) => `load-${i}`));
        }
        await until(
          () =>
            relay.sockets.filter((s) => s.authenticated && s.readyState === 1)
              .length === 8,
        );
        const start = performance.now();
        const loop = (operation) =>
          (async () => {
            while (running) {
              try {
                await operation();
              } catch (error) {
                if (running) throw error;
              }
            }
          })().catch((error) => {
            failures.push(error);
          });
        // Four ordinary readers keep demand ready, below the broker's six-slot
        // bound. Rotate across all eight transport objects on completion.
        let next = 0;
        for (let i = 0; i < 4; i++)
          pending.push(
            loop(() =>
              transports[next++ % 8].query(
                [{ kinds: [0], limit: 1 }],
                stop.signal,
              ),
            ),
          );
        pending.push(
          loop(() =>
            transports[next++ % 8].query(
              [{ kinds: [20001], authors: ["a".repeat(64)], limit: 1 }],
              stop.signal,
            ),
          ),
        );
        // One outstanding publication keeps the shared optional lane saturated
        // without manufacturing publication-deadline failures in the fixture.
        const publishing = loop(async () => {
          // Budget measurement is steady-state, not a cold-publication deadline
          // test. Drive EOSE-established owners rather than AUTH-only owners
          // whose foreground globals are still waiting behind shared traffic.
          const ready = transports
            .map((t, i) => ({ state: states.get(t), stream: streams[i] }))
            .filter(({ state }) => {
              const globals =
                state?.routes.filter((route) => !route.channelId) ?? [];
              return (
                globals.length === 2 &&
                globals.every((route) => route.status === "live")
              );
            });
          if (!ready.length) {
            await delay(20);
            return;
          }
          await ready[next++ % ready.length].stream.presence.publish(
            "online",
            new AbortController().signal,
          );
        });
        pending.push(publishing);
        for (let second = 0; second < 60; second++) {
          for (const stream of streams)
            stream.presence.update([
              (second + 1).toString(16).padStart(64, "0"),
            ]);
          await delay(1000);
          if (failures.length) {
            throw new Error("Broker load driver failed", {
              cause: {
                errors: failures.map(String),
                responses: report.presencePublicationResponses,
              },
            });
          }
        }
        const end = start + 60000;
        running = false;
        stop.abort();
        await Promise.all(pending);
        expect(failures).toEqual([]);
        const during = (rows) =>
          rows.filter((row) => row.at >= start && row.at < end);
        const ordinary = during(report.liveRequests).filter(
          (r) => r.route !== "presence",
        );
        const presence = during(report.liveRequests).filter(
          (r) => r.route === "presence",
        );
        const events = during(report.presencePublications);
        const api = during(report.queries);
        // Real scheduling can delay starts. Lower bounds prove this is a loaded
        // run, not a vacuous "no quota rejection" pass. Exact admission-clock
        // spacing is covered with fake time in live/http-admission tests; this
        // fixture measures actual aggregate arrivals after signing/HTTP overhead.
        expect(ordinary.length).toBeGreaterThanOrEqual(200);
        expect(presence.length).toBeGreaterThanOrEqual(50);
        expect(events.length).toBeGreaterThanOrEqual(11);
        expect(api.length).toBeGreaterThanOrEqual(120);
        expect(
          api.filter((r) => r.filter.kinds?.[0] === 20001).length,
        ).toBeGreaterThanOrEqual(11);
        // The existing first-call-anchored relay counters charge combined callers
        // before acceptance, including rejected work. Do not count only successes.
        for (const [category, maximum] of [
          ["ApiCalls", 134],
          ["WsEvents", 27],
          ["Messages", 13],
        ]) {
          const charges = report.quotaCharges.filter(
            (r) => r.category === category,
          );
          expect(charges.length).toBeGreaterThan(0);
          expect(Math.max(...charges.map((r) => r.count))).toBeLessThanOrEqual(
            maximum,
          );
          expect(charges.every((r) => r.accepted)).toBe(true);
        }
        expect(report.quotaRefusals).toEqual([]);
        // A correlated presence CLOSED must stop every WS caller, while ordinary
        // API reads remain independent. Recovery occurs only after the margin.
        relay.failRoute(
          "primary",
          "presence",
          "rate-limited: quota exceeded; retry in 3s",
        );
        const before = report.quotaCharges.filter(
          (r) => r.category === "WsEvents",
        ).length;
        for (const stream of streams) stream.presence.update(["b".repeat(64)]);
        const recovery = streams[0].presence.publish(
          "away",
          new AbortController().signal,
        );
        await transports[0].query([{ kinds: [0], limit: 1 }]);
        await delay(3200);
        expect(
          report.quotaCharges.filter((r) => r.category === "WsEvents"),
        ).toHaveLength(before);
        await recovery;
        expect(
          report.quotaCharges.filter((r) => r.category === "WsEvents").length,
        ).toBeGreaterThan(before);
      } finally {
        running = false;
        stop.abort();
        for (const stream of streams) stream.dispose();
        await Promise.allSettled(pending);
        vi.unstubAllGlobals();
      }
    },
    { enforceQuotas: true },
  );
}, 90000);
