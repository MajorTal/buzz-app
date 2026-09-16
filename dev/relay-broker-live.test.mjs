import { fixtureRelayUrl, fixtureAliases } from "../tests/relay-config.ts";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { test, expect, vi } from "vitest";
import { getPublicKey } from "nostr-tools";
import { relayBrokerPlugin } from "./relay-broker.mjs";
import { connectBrokerTransport } from "../src/features/relay/transport.ts";

/** Real HTTP setup/response cancellation and production subscriber; only upstream
 * WS I/O is substituted. No Keychain access or network outside localhost. */
async function harness(
  refuseAt = 0,
  reason = "rate-limited: quota exceeded; retry in 0s",
) {
  const key = new Uint8Array(32);
  key[31] = 1;
  const requests = [];
  const sockets = [];
  let handler;
  const server = createServer((req, res) => handler?.(req, res));
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
          if (kind === "AUTH")
            queueMicrotask(() => this.receive(["OK", id.id, true]));
          if (kind === "EVENT") {
            queueMicrotask(() => this.receive(["OK", id.id, true, ""]));
            return;
          }
          if (kind !== "REQ") return;
          requests.push({ at: performance.now(), filter, socket });
          const refused = requests.length === refuseAt;
          queueMicrotask(() =>
            this.receive(refused ? ["CLOSED", id, reason] : ["EOSE", id]),
          );
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
    sockets,
    requests,
    base,
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
    command(route, body) {
      return fetch(`${base}/api/relay/${route}`, {
        method: "POST",
        headers: { Origin: base, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    async close() {
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
async function until(check) {
  for (let i = 0; i < 200; i++) {
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

test("room presence is signed and published through the authenticated live socket", async () => {
  const h = await harness();
  try {
    const stream = await h.post(["00000000-0000-4000-8000-000000000001"]);
    await until(() => h.requests.length >= 3);
    const response = await h.command("rooms-presence", {
      roomId: "00000000-0000-4000-8000-000000000001",
      here: true,
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.accepted).toBe(true);
    expect(body.event).toMatchObject({
      kind: 20101,
      content: expect.stringContaining('"state":"here"'),
      tags: [["h", "00000000-0000-4000-8000-000000000001"]],
    });
    stream.abort();
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
