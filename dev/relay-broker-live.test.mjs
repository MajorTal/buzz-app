import { fixtureRelayUrl, fixtureAliases } from "../tests/relay-config.ts";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { test, expect, vi } from "vitest";
import {
  getPublicKey,
  generateSecretKey,
  finalizeEvent,
  nip44,
} from "nostr-tools";
import { createRelaySession } from "../src/features/relay/session.ts";
import { relayBrokerPlugin } from "./relay-broker.mjs";
import { connectBrokerTransport } from "../src/features/relay/transport.ts";

/** Real HTTP setup/response cancellation and production subscriber; only upstream
 * WS I/O is substituted. No Keychain access or network outside localhost. */
async function harness(
  refuseAt = 0,
  reason = "rate-limited: quota exceeded; retry in 0s",
  holdSetup = false,
) {
  const key = new Uint8Array(32);
  key[31] = 1;
  const requests = [];
  const sockets = [];
  const frames = [];
  const setupReplies = [];
  const publications = [];
  const lifecycle = [];
  let onStreamClose;
  let handler;
  const server = createServer((req, res) => {
    if (req.url?.endsWith("/stream")) {
      let streamId;
      const writeHead = res.writeHead;
      res.writeHead = function (...args) {
        // writeHead's direct headers are not retained by getHeader().
        streamId = args.at(-1)["X-Buzz-Live-ID"];
        return writeHead.apply(this, args);
      };
      res.once("close", () => {
        lifecycle.push({ event: "stream-close", streamId });
        onStreamClose?.();
      });
    }
    if (req.url?.endsWith("/stream-presence-publish")) {
      const publication = { closed: false, status: undefined };
      let body = "";
      req.on("data", (part) => {
        body += part;
      });
      req.once("end", () => {
        publication.streamId = JSON.parse(body).streamId;
        // Observe after the real middleware consumes the request body; do not
        // substitute its publication capability or prepare its pending state.
        setImmediate(() => publications.push(publication));
      });
      res.once("finish", () => {
        publication.status = res.statusCode;
        lifecycle.push({
          event: "publication-finish",
          streamId: publication.streamId,
          status: res.statusCode,
        });
      });
      res.once("close", () => {
        publication.closed = true;
      });
    }
    handler?.(req, res);
  });
  const plugin = relayBrokerPlugin({
    relayUrl: fixtureRelayUrl,
    communityAliases: fixtureAliases,
    identity: () => key,
    authority: async () => ({ relayAuthor: getPublicKey(key) }),
    upstreamFetch: async () => Response.json([]),
    socketFactory: () => {
      const socket = {
        readyState: 1,
        send(text) {
          const [kind, id, filter] = JSON.parse(text);
          frames.push({ kind, id, filter, socket, at: performance.now() });
          if (kind === "AUTH")
            queueMicrotask(() => this.receive(["OK", id.id, true]));
          if (kind !== "REQ") return;
          requests.push({ at: performance.now(), id, filter, socket });
          const refused = requests.length === refuseAt;
          const reply = () =>
            this.receive(refused ? ["CLOSED", id, reason] : ["EOSE", id]);
          if (holdSetup) setupReplies.push(reply);
          else queueMicrotask(reply);
        },
        receive(frame) {
          if (this.readyState === 1)
            return this.onmessage?.({ data: JSON.stringify(frame) });
        },
        close() {
          this.readyState = 3;
          this.onclose?.();
        },
      };
      sockets.push(socket);
      queueMicrotask(() => socket.receive(["AUTH", "fixture"]));
      return socket;
    },
  });
  await plugin.configureServer({
    httpServer: server,
    config: { logger: { info() {}, error() {} } },
    middlewares: {
      use(cb) {
        handler = cb;
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const controllers = [];
  return {
    key,
    sockets,
    frames,
    requests,
    publications,
    lifecycle,
    duringStreamClose(callback) {
      onStreamClose = callback;
    },
    releaseSetup() {
      holdSetup = false;
      for (const reply of setupReplies.splice(0)) reply();
    },
    base,
    publishPresence(streamId) {
      return fetch(`${base}/api/relay/stream-presence-publish`, {
        method: "POST",
        headers: { Origin: base, "Content-Type": "application/json" },
        body: JSON.stringify({ streamId, status: "online" }),
        signal: AbortSignal.timeout(3000),
      });
    },
    async post(channels, origin = base) {
      const controller = new AbortController();
      controllers.push(controller);
      const response = await fetch(`${base}/api/relay/stream`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ channels }),
        signal: controller.signal,
      });
      return { response, abort: () => controller.abort() };
    },
    async close() {
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
async function until(check, timeoutMs = 2000) {
  for (let i = 0; i < timeoutMs / 10; i++) {
    if (check()) return;
    await delay(10);
  }
  throw new Error("Local HTTP fixture did not reach expected state");
}

test("POST replacement and a second stream share cooldown and paced starts; response close disposes WS", async () => {
  const h = await harness(1);
  try {
    const first = await h.post(["a", "b"]);
    expect(first.response.status).toBe(200);
    // WebKit must not wait for a later heartbeat to receive the last SSE frame.
    expect(first.response.headers.get("transfer-encoding")).toBeNull();
    expect(first.response.headers.get("connection")).toBe("close");
    await until(() => h.requests.length === 1);
    const second = await h.post(["c", "d"]);
    expect(second.response.status).toBe(200);
    first.abort();
    await until(() => h.sockets[0].readyState === 3);
    const replacement = await h.post(["a", "b", "e"]);
    expect(replacement.response.status).toBe(200);
    await delay(300);
    expect(h.requests).toHaveLength(1);
    await until(() => h.requests.length >= 4);
    // A local quota refusal with a zero-second hint still has a rounding margin.
    expect(h.requests[1].at - h.requests[0].at).toBeGreaterThanOrEqual(990);
    for (let i = 2; i < h.requests.length; i++)
      expect(h.requests[i].at - h.requests[i - 1].at).toBeGreaterThanOrEqual(
        240,
      );
    second.abort();
    replacement.abort();
    await until(() => h.sockets.every((s) => s.readyState === 3));
  } finally {
    await h.close();
  }
});

test("real HTTP accepts the 1022-channel body and rejects invalid/oversized/origin inputs before WS allocation", async () => {
  const h = await harness();
  try {
    const channels = Array.from(
      { length: 1022 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    const large = await h.post(channels);
    expect(large.response.status).toBe(200);
    expect(large.response.headers.get("content-type")).toBe(
      "text/event-stream",
    );
    large.abort();
    await until(() => h.sockets.every((s) => s.readyState === 3));
    const count = h.sockets.length;
    for (const invalid of [[""], Array(1025).fill("a"), ["x".repeat(150001)]]) {
      const { response } = await h.post(invalid);
      expect([400, 413]).toContain(response.status);
      await response.text();
    }
    const denied = await h.post(["a"], "https://other.invalid");
    expect(denied.response.status).toBe(403);
    expect(h.sockets).toHaveLength(count);
  } finally {
    await h.close();
  }
});

test.each([null, 1])(
  "maximum channel interests survive observer startup and toggles (initial %s) through the real broker/browser stream",
  async (initialObserver) => {
    const h = await harness();
    const nativeFetch = globalThis.fetch;
    let traffic;
    try {
      const fetcher = vi.fn((input, init) =>
        nativeFetch(input, {
          ...init,
          headers: {
            ...init?.headers,
            ...(init?.method === "POST" ? { Origin: h.base } : {}),
          },
        }),
      );
      vi.stubGlobal("fetch", fetcher);
      const transport = await connectBrokerTransport(h.base);
      const states = [],
        received = [];
      let snapshot;
      traffic = transport.subscribe({
        receive(events) {
          received.push(...events);
        },
        established() {},
        denied() {},
        state(value) {
          snapshot = value;
          states.push(value);
        },
      });
      const ids = Array.from(
        { length: 1024 },
        (_, i) => `channel-${String(i).padStart(4, "0")}`,
      );
      traffic.observe(initialObserver);
      traffic.update(ids);
      const streamPosts = () =>
        fetcher.mock.calls.filter(([url]) => String(url).endsWith("/stream"))
          .length;
      let sockets, posts;
      for (const [phase, observer] of [
        initialObserver,
        initialObserver === null ? 1 : null,
        initialObserver,
      ].entries()) {
        traffic.observe(observer);
        const enabled = observer !== null;
        await until(
          () =>
            snapshot?.status === "connected" &&
            snapshot.routes.length === 1026 + Number(enabled) &&
            snapshot.routes.some(
              (r) => r.channelId === ids[0] && r.status === "live",
            ) &&
            (!enabled ||
              snapshot.routes.some(
                (r) => r.id === "observer" && r.status === "live",
              )),
        );
        expect(
          snapshot.routes
            .filter((r) => r.channelId)
            .map((r) => r.channelId)
            .sort(),
        ).toEqual(ids);
        expect(
          snapshot.routes
            .filter((r) => r.status === "limited")
            .map((r) => r.channelId),
        ).toEqual(ids.slice(enabled ? 1019 : 1020));
        // Presence reserves two more wires outside this ordinary-route snapshot.
        expect(
          snapshot.routes.filter((r) => r.status !== "limited"),
        ).toHaveLength(1022);
        expect(snapshot.routes.some((r) => r.id === "observer")).toBe(enabled);
        sockets ??= h.sockets.length;
        posts ??= streamPosts();
        expect(h.sockets).toHaveLength(sockets);
        expect(streamPosts()).toBe(posts);

        const socket = h.sockets.at(-1);
        for (const [kind, tags] of [
          [9, [["h", ids[0]]]],
          [0, []],
          [44100, [["p", getPublicKey(h.key)]]],
        ]) {
          const route = h.requests.find(
            (r) => r.socket === socket && r.filter.kinds.includes(kind),
          );
          expect(route).toBeDefined();
          const event = finalizeEvent(
            {
              kind,
              tags,
              created_at: Math.floor(Date.now() / 1000),
              content: `ordinary traffic in observer phase ${phase}`,
            },
            h.key,
          );
          await socket.receive(["EVENT", route.id, event]);
          await until(() => received.some((r) => r.id === event.id));
        }
        expect(received).toHaveLength((phase + 1) * 3);
        expect(
          states.filter((s) => s.status === "retrying" || s.status === "error"),
        ).toEqual([]);
      }
    } finally {
      traffic?.dispose();
      vi.unstubAllGlobals();
      await h.close();
    }
  },
);

test.each([
  "rate-limited: quota exceeded; retry in 0s",
  "temporary: fixture read unavailable",
])(
  "actual browser transport retry preserves healthy routes (%s)",
  async (reason) => {
    const h = await harness(5, reason);
    const nativeFetch = globalThis.fetch;
    let traffic;
    try {
      vi.stubGlobal("fetch", (input, init) =>
        nativeFetch(input, {
          ...init,
          headers: {
            ...init?.headers,
            ...(init?.method === "POST" ? { Origin: h.base } : {}),
          },
        }),
      );
      const transport = await connectBrokerTransport(h.base);
      let snapshot;
      traffic = transport.subscribe({
        receive() {},
        established() {},
        denied() {},
        state(value) {
          snapshot = value;
        },
      });
      traffic.update(["a", "b", "c"]);
      await until(() =>
        snapshot?.routes.some((r) => r.channelId === "c" && r.error),
      );
      expect(snapshot.routes.filter((r) => r.status === "live")).toHaveLength(
        4,
      );
      const sockets = h.sockets.length;
      const healthySocket = h.sockets.at(-1);
      traffic.retry();
      traffic.retry(); // Duplicate clicks coalesce the control request.
      await until(() => snapshot.routes.every((r) => r.status === "live"));
      expect(h.sockets).toHaveLength(sockets);
      expect(healthySocket.readyState).toBe(1);
      expect(h.requests.map((r) => r.filter["#h"]?.[0] ?? "global")).toEqual([
        "global",
        "global",
        "a",
        "b",
        "c",
        "c",
      ]);
      traffic.dispose();
      await until(() => h.sockets.every((s) => s.readyState === 3));
    } finally {
      traffic?.dispose();
      vi.unstubAllGlobals();
      await h.close();
    }
  },
);

test("retry control is bounded, same-origin/community scoped and removed with its response owner", async () => {
  const h = await harness();
  const post = (path, body, origin = h.base) =>
    fetch(`${h.base}${path}`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const stream = await h.post(["a"]);
    const streamId = stream.response.headers.get("x-buzz-live-id");
    expect(streamId).toMatch(/^[0-9a-f]{32}$/);
    await until(() => h.requests.length === 3);
    for (const [body, status] of [
      [{ streamId: "bad" }, 400],
      [{ streamId: "f".repeat(32) }, 404],
      [{ streamId: "x".repeat(300) }, 413],
    ]) {
      const response = await post("/api/relay/stream-retry", body);
      expect(response.status).toBe(status);
      await response.text();
    }
    const cross = await post(
      "/api/relay/stream-retry",
      { streamId },
      "https://evil.invalid",
    );
    expect(cross.status).toBe(403);
    const other = "https://other.invalid";
    await (await post("/api/relay/register", { url: other })).text();
    const wrongScope = await post(
      `/api/relay/${encodeURIComponent(other)}/stream-retry`,
      { streamId },
    );
    expect(wrongScope.status).toBe(404);
    expect(h.sockets).toHaveLength(1);
    const valid = await post("/api/relay/stream-retry", { streamId });
    expect(valid.status).toBe(200);
    await valid.text();
    expect(h.requests).toHaveLength(3); // No healthy route restarts.
    stream.abort();
    await until(() => h.sockets[0].readyState === 3);
    const stale = await post("/api/relay/stream-retry", { streamId });
    expect(stale.status).toBe(404);
  } finally {
    await h.close();
  }
});

test("current demand reaches the front of a large roster without replacing its POST or healthy globals", async () => {
  const h = await harness();
  const nativeFetch = globalThis.fetch;
  let traffic;
  try {
    const fetcher = vi.fn((input, init) =>
      nativeFetch(input, {
        ...init,
        headers: {
          ...init?.headers,
          ...(init?.method === "POST" ? { Origin: h.base } : {}),
        },
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const transport = await connectBrokerTransport(h.base);
    traffic = transport.subscribe({
      receive() {},
      established() {},
      denied() {},
      state() {},
    });
    const ids = Array.from(
      { length: 128 },
      (_, i) => `channel-${String(i).padStart(3, "0")}`,
    );
    traffic.prioritize([ids[127]]);
    traffic.update(ids);
    await until(() => h.requests.length >= 3);
    expect(
      h.requests.slice(0, 3).map((r) => r.filter["#h"]?.[0] ?? "global"),
    ).toEqual(["global", "global", ids[127]]);
    const sockets = h.sockets.length;
    const posts = fetcher.mock.calls.filter(([url]) =>
      String(url).endsWith("/stream"),
    ).length;
    traffic.prioritize([ids[126]]);
    traffic.prioritize([ids[125]]);
    await until(() => h.requests.some((r) => r.filter["#h"]?.[0] === ids[125]));
    expect(
      h.requests.findIndex((r) => r.filter["#h"]?.[0] === ids[125]),
    ).toBeLessThan(7);
    expect(h.sockets).toHaveLength(sockets);
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).endsWith("/stream")),
    ).toHaveLength(posts);
    expect(h.requests.filter((r) => !r.filter["#h"])).toHaveLength(2);
  } finally {
    traffic?.dispose();
    vi.unstubAllGlobals();
    await h.close();
  }
});
test("priority control cannot allocate interests or bypass owner, origin, community and body bounds", async () => {
  const h = await harness();
  try {
    const opened = await h.post(["a"]);
    const streamId = opened.response.headers.get("x-buzz-live-id");
    const control = (
      body,
      path = "/api/relay/stream-priority",
      origin = h.base,
    ) =>
      fetch(`${h.base}${path}`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    for (const body of [
      { streamId, channels: [""] },
      { streamId, channels: Array(65).fill("a") },
      { streamId: "bad", channels: ["a"] },
    ])
      expect((await control(body)).status).toBe(400);
    expect(
      (
        await control(
          { streamId, channels: ["a"] },
          "/api/relay/secondary/stream-priority",
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await control(
          { streamId, channels: ["a"] },
          undefined,
          "https://wrong.test",
        )
      ).status,
    ).toBe(403);
    expect(
      (await control({ streamId, channels: ["x".repeat(9001)] })).status,
    ).toBe(413);
    expect(
      (await control({ streamId, channels: ["not-an-interest"] })).status,
    ).toBe(200);
    await until(() => h.requests.length === 3);
    expect(
      h.requests.filter((r) => r.filter["#h"]).map((r) => r.filter["#h"]),
    ).toEqual([["a"]]);
    opened.abort();
    await until(() => h.sockets.every((s) => s.readyState === 3));
    expect((await control({ streamId, channels: ["a"] })).status).toBe(404);
    expect(h.sockets).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("actual browser/broker presence controls preserve socket and healthy routes; only a correlated WS receipt resolves publication", async () => {
  const h = await harness();
  const nativeFetch = globalThis.fetch;
  let traffic;
  try {
    const fetcher = vi.fn((input, init) =>
      nativeFetch(input, {
        ...init,
        headers: {
          ...init?.headers,
          ...(init?.method === "POST" ? { Origin: h.base } : {}),
        },
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const callbacks = {
      receive: vi.fn(),
      state: vi.fn(),
      established: vi.fn(),
      denied: vi.fn(),
      presence: vi.fn(),
      presenceState: vi.fn(),
    };
    const transport = await connectBrokerTransport(h.base);
    traffic = transport.subscribe(callbacks);
    traffic.update(["a"]);
    await until(() => callbacks.established.mock.calls.length === 3);
    const sockets = h.sockets.length;
    const streams = fetcher.mock.calls.filter(([url]) =>
      String(url).endsWith("/stream"),
    ).length;
    const author = getPublicKey(h.key);
    for (let i = 0; i < 1000; i++) traffic.presence.update([author]);
    await until(
      () => callbacks.presenceState.mock.lastCall?.[0].status === "ready",
    );
    const route = h.frames.find(
      (f) => f.kind === "REQ" && f.filter.kinds[0] === 20001,
    );
    expect(route.filter).toEqual({
      kinds: [20001],
      authors: [author],
      limit: 0,
    });
    const event = finalizeEvent(
      {
        kind: 20001,
        content: "online",
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
      },
      h.key,
    );
    await route.socket.receive(["EVENT", route.id, event]);
    await until(() => callbacks.presence.mock.calls.length === 1);
    expect(callbacks.receive).not.toHaveBeenCalled();
    expect(callbacks.established).toHaveBeenCalledTimes(3);
    // Coalesced A -> B -> A must return to Ready even though the server union never changed.
    traffic.presence.update(["f".repeat(64)]);
    traffic.presence.update([author]);
    expect(callbacks.presenceState.mock.lastCall?.[0].status).toBe("pending");
    await until(
      () => callbacks.presenceState.mock.lastCall?.[0].status === "ready",
    );
    const completed = vi.fn();
    const operation = traffic.presence
      .publish("away", new AbortController().signal)
      .then(completed);
    await until(() => h.frames.some((f) => f.kind === "EVENT"));
    const frame = h.frames.find((f) => f.kind === "EVENT");
    expect(frame.id).toMatchObject({
      kind: 20001,
      content: "away",
      tags: [],
      pubkey: author,
    });
    await frame.socket.receive(["OK", "wrong-id", true]);
    await delay(20);
    expect(completed).not.toHaveBeenCalled();
    await frame.socket.receive(["OK", frame.id.id, true]);
    await operation;
    expect(completed).toHaveBeenCalledOnce();
    traffic.presence.update([]);
    await until(() =>
      h.frames.some((f) => f.kind === "CLOSE" && f.id === route.id),
    );
    expect(h.sockets).toHaveLength(sockets);
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).endsWith("/stream")),
    ).toHaveLength(streams);
    expect(h.requests.filter((r) => r.filter.kinds[0] !== 20001)).toHaveLength(
      3,
    );
    expect(
      fetcher.mock.calls.filter(([url]) =>
        String(url).endsWith("/stream-presence"),
      ),
    ).toHaveLength(3);
    expect(
      fetcher.mock.calls.some(([url]) =>
        /\/(events|publish|sign)$/.test(String(url)),
      ),
    ).toBe(false);
  } finally {
    traffic?.dispose();
    vi.unstubAllGlobals();
    await h.close();
  }
});

test("presence controls enforce origin, owner, community, shape and body bounds without extra sockets/signing", async () => {
  const h = await harness();
  const post = (path, body, origin = h.base) =>
    fetch(`${h.base}${path}`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const stream = await h.post([]);
    const streamId = stream.response.headers.get("x-buzz-live-id");
    const author = getPublicKey(h.key);
    await until(() => h.requests.length === 2);
    for (const [path, body, code] of [
      ["stream-presence", { streamId, authors: ["bad"] }, 400],
      ["stream-presence", { streamId, authors: Array(257).fill(author) }, 400],
      ["stream-presence", { streamId, authors: ["x".repeat(18001)] }, 413],
      ["stream-presence-publish", { streamId, status: "offline" }, 400],
      [
        "stream-presence-publish",
        { streamId, status: { status: "online" } },
        400,
      ],
      ["stream-presence-publish", { streamId, status: "x".repeat(300) }, 413],
      [
        "stream-presence-publish",
        { streamId: "f".repeat(32), status: "online" },
        404,
      ],
    ])
      expect((await post(`/api/relay/${path}`, body)).status).toBe(code);
    for (const path of ["stream-presence", "stream-presence-publish"]) {
      const body = { streamId, authors: [author], status: "online" };
      expect(
        (await post(`/api/relay/${path}`, body, "https://wrong.invalid"))
          .status,
      ).toBe(403);
      expect((await post(`/api/relay/secondary/${path}`, body)).status).toBe(
        404,
      );
    }
    expect(h.sockets).toHaveLength(1);
    expect(h.frames.some((f) => f.kind === "EVENT")).toBe(false);
    expect(h.requests).toHaveLength(2);
    stream.abort();
    await until(() => h.sockets[0].readyState === 3);
    expect(
      (
        await post("/api/relay/stream-presence", {
          streamId,
          authors: [author],
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await post("/api/relay/stream-presence-publish", {
          streamId,
          status: "online",
        })
      ).status,
    ).toBe(404);
  } finally {
    await h.close();
  }
});

test("SSE close before publication POST close remains unconfirmed and replacement needs its matching OK", async () => {
  const h = await harness(0, undefined, true);
  try {
    const first = await h.post([]);
    const streamId = first.response.headers.get("x-buzz-live-id");
    await until(() => h.requests.length === 2); // Authenticated, globals await EOSE.
    const pending = h.publishPresence(streamId);
    await until(() => h.publications.length === 1);
    expect(h.publications[0]).toEqual({
      streamId,
      closed: false,
      status: undefined,
    });
    expect(h.frames.filter((frame) => frame.kind === "EVENT")).toEqual([]);

    // Close only the SSE; the independent publication HTTP response stays open.
    first.abort();
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Presence publication unconfirmed",
      code: "presence_owner_disposed",
    });
    expect(h.lifecycle).toEqual([
      { event: "stream-close", streamId },
      { event: "publication-finish", streamId, status: 503 },
    ]);
    expect(h.sockets[0].readyState).toBe(3);
    h.releaseSetup(); // Late old EOSE must not send the retired publication.
    await delay(10);
    expect(h.frames.filter((frame) => frame.kind === "EVENT")).toEqual([]);

    const replacement = await h.post([]);
    const replacementId = replacement.response.headers.get("x-buzz-live-id");
    await until(() => h.requests.length === 4);
    const retry = h.publishPresence(replacementId);
    const settled = vi.fn();
    void retry.then(settled);
    await until(() => h.frames.some((frame) => frame.kind === "EVENT"));
    const frame = h.frames.find((frame) => frame.kind === "EVENT");
    expect(frame.socket).toBe(h.sockets[1]);
    await frame.socket.receive(["OK", "f".repeat(64), true]);
    await delay(10);
    expect(settled).not.toHaveBeenCalled();
    await frame.socket.receive(["OK", frame.id.id, true]);
    const accepted = await retry;
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ accepted: true });
    expect(h.frames.filter((entry) => entry.kind === "EVENT")).toHaveLength(1);
    replacement.abort();
  } finally {
    await h.close();
  }
});

test.each([
  "restricted: publication refused",
  "Presence owner disposed",
  "presence_owner_disposed",
])("live rejection %s stays unclassified after retirement", async (reason) => {
  const h = await harness();
  try {
    const stream = await h.post([]);
    const streamId = stream.response.headers.get("x-buzz-live-id");
    await until(() => h.requests.length === 2);
    const pending = h.publishPresence(streamId);
    await until(() => h.frames.some((frame) => frame.kind === "EVENT"));
    const frame = h.frames.find((entry) => entry.kind === "EVENT");
    await frame.socket.receive(["OK", frame.id.id, false, reason]);
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Presence publication unconfirmed",
    });
    expect(h.sockets[0].readyState).toBe(1);
    expect(h.lifecycle).toEqual([
      { event: "publication-finish", streamId, status: 503 },
    ]);
    // Later retirement cannot retroactively turn a genuine failure into cancellation.
    stream.abort();
    await until(() => h.sockets[0].readyState === 3);
    expect(h.lifecycle).toEqual([
      { event: "publication-finish", streamId, status: 503 },
      { event: "stream-close", streamId },
    ]);
  } finally {
    await h.close();
  }
});

test("disposal after EVENT but before matching OK stays unconfirmed, not unsent or accepted", async () => {
  const h = await harness();
  try {
    const stream = await h.post([]);
    const streamId = stream.response.headers.get("x-buzz-live-id");
    await until(() => h.requests.length === 2);
    const pending = h.publishPresence(streamId);
    await until(() => h.frames.some((entry) => entry.kind === "EVENT"));
    const frame = h.frames.find((entry) => entry.kind === "EVENT");
    stream.abort();
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Presence publication unconfirmed",
      code: "presence_owner_disposed",
    });
    await frame.socket.receive(["OK", frame.id.id, true]);
    await delay(10);
    expect(h.frames.filter((entry) => entry.kind === "EVENT")).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("a relay rejection during SSE retirement defeats close-before-503 accounting", async () => {
  const h = await harness();
  try {
    const stream = await h.post([]);
    const streamId = stream.response.headers.get("x-buzz-live-id");
    await until(() => h.requests.length === 2);
    const pending = h.publishPresence(streamId);
    await until(() => h.frames.some((entry) => entry.kind === "EVENT"));
    const frame = h.frames.find((entry) => entry.kind === "EVENT");
    const reason = "rate-limited: quota exceeded; retry in 1s";
    let rejectedWhileLive = false;
    // Deliver the real negative OK after an outer observer sees HTTP close but
    // before the broker's close listener disposes the still-live socket owner.
    h.duringStreamClose(() => {
      rejectedWhileLive = frame.socket.readyState === 1;
      frame.socket.receive(["OK", frame.id.id, false, reason]);
    });
    stream.abort();
    const response = await pending;
    expect(rejectedWhileLive).toBe(true);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Presence publication unconfirmed",
    });
    expect(h.lifecycle).toEqual([
      { event: "stream-close", streamId },
      { event: "publication-finish", streamId, status: 503 },
    ]);
    // This is a real rejection, not merely a discarded negative OK after
    // disposal: its host-wide quota pause suppresses the replacement's REQ.
    const count = h.requests.length;
    const replacement = await h.post([]);
    await until(() =>
      h.frames.some(
        (entry) => entry.kind === "AUTH" && entry.socket === h.sockets[1],
      ),
    );
    await delay(300);
    expect(h.requests).toHaveLength(count);
    replacement.abort();
  } finally {
    await h.close();
  }
});

test("broker publication cancellation frees its owner and quota rejection remains unconfirmed with no retry", async () => {
  const h = await harness();
  const nativeFetch = globalThis.fetch;
  let traffic;
  try {
    vi.stubGlobal("fetch", (input, init) =>
      nativeFetch(input, {
        ...init,
        headers: {
          ...init?.headers,
          ...(init?.method === "POST" ? { Origin: h.base } : {}),
        },
      }),
    );
    const transport = await connectBrokerTransport(h.base);
    let ready = 0;
    traffic = transport.subscribe({
      receive() {},
      state() {},
      established() {
        ready++;
      },
      denied() {},
    });
    await until(() => ready === 2);
    const controller = new AbortController();
    const operation = traffic.presence.publish("online", controller.signal);
    const failure = expect(operation).rejects.toThrow();
    await until(() => h.frames.some((f) => f.kind === "EVENT"));
    controller.abort();
    await failure;
    await delay(50); // Let HTTP close cancellation reach the server owner.
    const second = traffic.presence.publish(
      "away",
      new AbortController().signal,
    );
    const rejected = expect(second).rejects.toThrow("unconfirmed");
    await until(
      () => h.frames.filter((f) => f.kind === "EVENT").length === 2,
      6000,
    );
    const frame = h.frames.filter((f) => f.kind === "EVENT")[1];
    expect(
      frame.at - h.frames.find((f) => f.kind === "EVENT").at,
    ).toBeGreaterThanOrEqual(4990);
    await frame.socket.receive([
      "OK",
      frame.id.id,
      false,
      "rate-limited: quota exceeded; retry in 0s",
    ]);
    await rejected;
    await delay(1100);
    expect(h.frames.filter((f) => f.kind === "EVENT")).toHaveLength(2);
    expect(h.sockets).toHaveLength(1);
  } finally {
    traffic?.dispose();
    vi.unstubAllGlobals();
    await h.close();
  }
}, 10000);

test("real signed/encrypted WS → host decode → SSE → session activity; demand and clear fence without replacing chat", async () => {
  const h = await harness();
  const nativeFetch = globalThis.fetch;
  let owner, release;
  try {
    vi.stubGlobal("fetch", (input, init) =>
      nativeFetch(input, {
        ...init,
        headers: {
          ...init?.headers,
          ...(init?.method === "POST" ? { Origin: h.base } : {}),
        },
      }),
    );
    const transport = await connectBrokerTransport(h.base);
    expect(transport.agentActivity).toBe(true);
    owner = createRelaySession(transport, { prepared: true });
    release = owner.session.agentActivity.activate();
    await until(
      () => owner.session.agentActivity.snapshot().status === "listening",
    );
    const routes = () =>
      h.requests.filter((r) => r.filter.kinds.includes(24200));
    const first = routes().at(-1);
    const socketCount = h.sockets.length;
    const globals = h.requests.filter(
      (r) => !r.filter.kinds.includes(24200),
    ).length;
    const agent = generateSecretKey(),
      sender = getPublicKey(agent),
      viewer = getPublicKey(h.key);
    const encrypt = (
      raw,
      tags = [
        ["p", viewer],
        ["agent", sender],
        ["frame", "telemetry"],
      ],
    ) =>
      finalizeEvent(
        {
          kind: 24200,
          created_at: Math.floor(Date.now() / 1000),
          tags,
          content: nip44.v2.encrypt(
            JSON.stringify(raw),
            nip44.v2.utils.getConversationKey(agent, viewer),
          ),
        },
        agent,
      );
    const raw = {
      kind: "turn_started",
      seq: 1,
      timestamp: new Date().toISOString(),
      channelId: null,
      sessionId: null,
      turnId: "synthetic-turn",
      payload: { text: "inert <script>raw</script>" },
    };
    const event = encrypt(raw);
    const view = owner.session.observe([{ kinds: [24200], limit: 1 }]);
    await first.socket.receive(["EVENT", first.id, event]);
    await until(
      () => owner.session.agentActivity.snapshot().records.length === 1,
    );
    expect(owner.session.agentActivity.snapshot().records[0].plaintext).toBe(
      JSON.stringify(raw),
    );
    expect(owner.session.agentActivity.snapshot().turns[0].state).toBe(
      "working",
    );
    expect(view.snapshot().events).toEqual([]);
    // Wrong direction is signed/encrypted but must never become telemetry.
    await first.socket.receive([
      "EVENT",
      first.id,
      encrypt(raw, [
        ["p", viewer],
        ["agent", sender],
        ["frame", "control"],
      ]),
    ]);
    await delay(20);
    expect(owner.session.agentActivity.snapshot().records).toHaveLength(1);
    await owner.clearCache();
    expect(owner.session.agentActivity.snapshot().records).toHaveLength(0);
    await until(() => routes().length === 2);
    await first.socket.receive(["EVENT", first.id, event]);
    await delay(20);
    expect(owner.session.agentActivity.snapshot().records).toHaveLength(0);
    const second = routes().at(-1);
    await until(
      () => owner.session.agentActivity.snapshot().status === "listening",
    );
    await second.socket.receive([
      "EVENT",
      second.id,
      encrypt({ ...raw, kind: "turn_completed" }),
    ]);
    await until(
      () => owner.session.agentActivity.snapshot().records.length === 1,
    );
    expect(owner.session.agentActivity.snapshot().turns[0].state).toBe("ended");
    release();
    expect(owner.session.agentActivity.snapshot().records).toHaveLength(0);
    await delay(30);
    expect(h.sockets).toHaveLength(socketCount);
    expect(
      h.requests.filter((r) => !r.filter.kinds.includes(24200)),
    ).toHaveLength(globals);
    view.dispose();
  } finally {
    release?.();
    owner?.dispose();
    vi.unstubAllGlobals();
    await h.close();
  }
});
