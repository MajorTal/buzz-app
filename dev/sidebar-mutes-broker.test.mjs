import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { brokerSocket, openBrokerSocket } from "../tests/broker-socket.mjs";
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools";
import { SIDEBAR_HEAD_BYTES } from "./sidebar-preferences.mjs";
import { relayBrokerPlugin } from "./relay-broker.mjs";
import { prepareSidebarMute } from "./sidebar-mutes.mjs";
import { connectBrokerTransport } from "../src/features/relay/transport.ts";
import { fixtureRelayUrl, fixtureAliases } from "../tests/relay-config.ts";

const disposals = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});
async function harness({ connected = true } = {}) {
  const key = generateSecretKey(),
    viewer = getPublicKey(key);
  let handler, queryFailure, publicationFailure, live;
  let activeSocket;
  let conflict = false;
  const heads = new Map(),
    calls = [];
  const socket = brokerSocket((event) => {
    expect(verifyEvent(event)).toBe(true);
    expect(event.pubkey).toBe(viewer);
    calls.push({ url: "socket:EVENT", body: event });
    if (publicationFailure === "disconnect") activeSocket.close();
    if (!publicationFailure && !conflict)
      heads.set(event.tags.find(([name]) => name === "d")[1], event);
    return "";
  });
  const server = createServer((req, res) => {
    req.headers.origin ??= `http://${req.headers.host}`;
    handler(req, res);
  });
  await relayBrokerPlugin({
    relayUrl: fixtureRelayUrl,
    communityAliases: fixtureAliases,
    identity: () => key,
    authority: async () => ({ relayAuthor: viewer }),
    socketFactory: () => {
      activeSocket = socket.factory();
      const rawSend = activeSocket.send;
      activeSocket.send = (text) => {
        const [kind, event] = JSON.parse(text);
        if (kind === "EVENT" && publicationFailure === "rejection") {
          calls.push({ url: "socket:EVENT", body: event });
          queueMicrotask(() =>
            activeSocket.onmessage?.({
              data: JSON.stringify(["OK", event.id, false, "blocked: fixture"]),
            }),
          );
        } else rawSend(text);
      };
      return activeSocket;
    },
    upstreamFetch: async (url, init) => {
      if (!init?.body) return Response.json({ self: viewer });
      const body = JSON.parse(init.body);
      const auth = JSON.parse(
        Buffer.from(init.headers.Authorization.slice(6), "base64").toString(),
      );
      expect(verifyEvent(auth)).toBe(true);
      expect(auth.pubkey).toBe(viewer);
      expect(auth.tags).toContainEqual(["u", String(url)]);
      expect(auth.tags).toContainEqual(["method", "POST"]);
      expect(auth.tags).toContainEqual([
        "payload",
        createHash("sha256").update(init.body).digest("hex"),
      ]);
      expect(init.redirect).toBe("error");
      calls.push({ url: String(url), body });
      expect(new URL(url).pathname).toBe("/query");
      if (queryFailure) return queryFailure;
      const head = heads.get(body[0]["#d"][0]);
      return Response.json(head ? [head] : []);
    },
  }).configureServer({
    httpServer: server,
    config: { logger: { info() {}, error() {} } },
    middlewares: {
      use(callback) {
        handler = callback;
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  disposals.push(async () => {
    live?.dispose();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const transport = await connectBrokerTransport(base);
  if (connected) live = await openBrokerSocket(transport);
  return {
    disconnect() {
      live.dispose();
    },
    liveId: () => live?.identity(),
    key,
    viewer,
    transport,
    calls,
    heads,
    failQuery(value) {
      queryFailure = value;
    },
    failPublication(value) {
      publicationFailure = value;
    },
    conflict() {
      conflict = true;
    },
    post(value, origin, route = "sidebar-mute", liveId = live?.identity()) {
      return fetch(`${base}/api/relay/${route}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(liveId ? { "X-Buzz-Live-ID": liveId } : {}),
          ...(origin ? { Origin: origin } : {}),
        },
        body: JSON.stringify(value),
      });
    },
  };
}
it("real broker Mute roundtrip signs scoped requests and confirms before projecting", async () => {
  const h = await harness(),
    signal = new AbortController().signal;
  h.heads.set(
    "channel-mutes",
    prepareSidebarMute([], { channelId: "other", muted: true }, h.key).event,
  );
  expect(
    await h.transport.writeSidebarMute(
      { channelId: "alpha", muted: true },
      signal,
    ),
  ).toEqual(["other", "alpha"]);
  expect(h.calls.map((call) => new URL(call.url).pathname)).toEqual([
    "/query",
    "EVENT",
    "/query",
  ]);
  expect(h.calls[0].body).toEqual([
    { kinds: [30078], authors: [h.viewer], "#d": ["channel-mutes"], limit: 1 },
  ]);
  expect(
    await h.transport.writeSidebarMute(
      { channelId: "alpha", muted: false },
      signal,
    ),
  ).toEqual(["other"]);
  expect(h.calls.filter((call) => call.url === "socket:EVENT")).toHaveLength(2);
  await h.transport.writeSidebarMute(
    { channelId: "alpha", muted: false },
    signal,
  );
  expect(h.calls.filter((call) => call.url === "socket:EVENT")).toHaveLength(2);
});
it("refuses invalid intent and foreign origins without upstream requests", async () => {
  const h = await harness();
  const post = (value, origin) => h.post(value, origin, "sidebar-mute");
  expect((await post({ channelId: "alpha", muted: "true" })).status).toBe(400);
  expect(
    (await post({ channelId: "alpha", muted: true }, "https://foreign.invalid"))
      .status,
  ).toBe(403);
  expect(
    (await post({ channelId: "x".repeat(2100), muted: true })).status,
  ).toBe(413);
  expect(h.calls).toEqual([]);
});
it.each(["query", "oversized", "rejection", "disconnect", "conflict"])(
  "does not claim a saved Mute after %s failure",
  async (failure) => {
    const h = await harness();
    if (failure === "query")
      h.failQuery(new Response("failed", { status: 503 }));
    if (failure === "oversized")
      h.failQuery(new Response(`[${" ".repeat(SIDEBAR_HEAD_BYTES)}]`));
    if (["rejection", "disconnect"].includes(failure))
      h.failPublication(failure);
    if (failure === "conflict") h.conflict();
    await expect(
      h.transport.writeSidebarMute(
        { channelId: "alpha", muted: true },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    if (["query", "oversized"].includes(failure))
      expect(h.calls.filter((call) => call.url === "socket:EVENT")).toEqual([]);
  },
);

it("refuses missing, stale and cross-community live owners without reads or writes", async () => {
  const h = await harness({ connected: false });
  const intent = { channelId: "alpha", muted: true };
  await expect(
    h.transport.writeSidebarMute(intent, new AbortController().signal),
  ).rejects.toThrow();
  expect(h.calls).toEqual([]);
  const ready = await harness();
  for (const [route, id] of [
    ["sidebar-mute", "f".repeat(32)],
    ["secondary/sidebar-mute", ready.liveId()],
  ]) {
    const response = await ready.post(intent, undefined, route, id);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ sent: false });
  }
  ready.disconnect();
  await expect(
    ready.transport.writeSidebarMute(intent, new AbortController().signal),
  ).rejects.toThrow();
  expect(ready.calls).toEqual([]);
});
