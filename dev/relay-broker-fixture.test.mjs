import { test, expect } from "vitest";
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
async function fixture(use) {
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
        page,
        context: { route: async () => {}, routeWebSocket: async () => {} },
        browserName: "chromium",
        browser: { version: () => "HTTP-only fixture wiring check" },
        productionBroker: true,
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
  const pending = fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ streamId, status: "online" }),
    signal: AbortSignal.timeout(3000),
  });
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
  controller.abort();
  return endpoint;
}

const console503 = (page, url) =>
  page.emit("console", {
    type: () => "error",
    text: () =>
      "Failed to load resource: the server responded with a status of 503 (Service Unavailable)",
    location: () => ({ url }),
  });

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
  ).rejects.toThrow("Unclassified presence publication 503");
});

test("same endpoint disposal console cannot hide a separate unclassified response", async () => {
  await expect(
    fixture(async (app, page) => {
      console503(page, await publication(app, true));
      await publication(app, false);
    }),
  ).rejects.toThrow("Unclassified presence publication 503");
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
    "Unclassified presence publication 503",
  );
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
