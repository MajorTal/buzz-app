import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools";
import { relayBrokerPlugin } from "./relay-broker.mjs";
import { prepareSidebarStar } from "./sidebar-stars.mjs";
import { connectBrokerTransport } from "../src/features/relay/transport.ts";
import { fixtureRelayUrl, fixtureAliases } from "../tests/relay-config.ts";

const disposals = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});
async function harness() {
  const key = generateSecretKey(),
    viewer = getPublicKey(key);
  let handler, queryFailure, publicationFailure;
  let conflict = false;
  const heads = new Map(),
    calls = [];
  const server = createServer((req, res) => {
    req.headers.origin ??= `http://${req.headers.host}`;
    handler(req, res);
  });
  await relayBrokerPlugin({
    relayUrl: fixtureRelayUrl,
    communityAliases: fixtureAliases,
    identity: () => key,
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
      if (String(url).endsWith("/events")) {
        expect(verifyEvent(body)).toBe(true);
        if (publicationFailure) return publicationFailure;
        if (!conflict)
          heads.set(body.tags.find(([name]) => name === "d")[1], body);
        return Response.json({ accepted: true, event_id: body.id });
      }
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
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const transport = await connectBrokerTransport(base);
  return {
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
    post(value, origin) {
      return fetch(`${base}/api/relay/sidebar-star`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(origin ? { Origin: origin } : {}),
        },
        body: JSON.stringify(value),
      });
    },
  };
}
it("real broker Star roundtrip signs scoped requests and confirms before projecting", async () => {
  const h = await harness(),
    signal = new AbortController().signal;
  h.heads.set(
    "channel-stars",
    prepareSidebarStar([], { channelId: "other", starred: true }, h.key).event,
  );
  expect(
    await h.transport.writeSidebarStar(
      { channelId: "alpha", starred: true },
      signal,
    ),
  ).toEqual(["other", "alpha"]);
  expect(h.calls.map((call) => new URL(call.url).pathname)).toEqual([
    "/query",
    "/events",
    "/query",
  ]);
  expect(h.calls[0].body).toEqual([
    { kinds: [30078], authors: [h.viewer], "#d": ["channel-stars"], limit: 1 },
  ]);
  expect(
    await h.transport.writeSidebarStar(
      { channelId: "alpha", starred: false },
      signal,
    ),
  ).toEqual(["other"]);
  expect(h.calls.filter((call) => call.url.endsWith("/events"))).toHaveLength(
    2,
  );
  await h.transport.writeSidebarStar(
    { channelId: "alpha", starred: false },
    signal,
  );
  expect(h.calls.filter((call) => call.url.endsWith("/events"))).toHaveLength(
    2,
  );
});
it("refuses invalid intent and foreign origins without upstream requests", async () => {
  const h = await harness();
  expect((await h.post({ channelId: "alpha", starred: "true" })).status).toBe(
    400,
  );
  expect(
    (
      await h.post(
        { channelId: "alpha", starred: true },
        "https://foreign.invalid",
      )
    ).status,
  ).toBe(403);
  expect(
    (await h.post({ channelId: "x".repeat(2100), starred: true })).status,
  ).toBe(413);
  expect(h.calls).toEqual([]);
});
it.each(["query", "oversized", "publication", "receipt", "conflict"])(
  "does not claim a saved Star after %s failure",
  async (failure) => {
    const h = await harness();
    if (failure === "query")
      h.failQuery(new Response("failed", { status: 503 }));
    if (failure === "oversized")
      h.failQuery(new Response(`[${" ".repeat(270000)}]`));
    if (failure === "publication")
      h.failPublication(new Response("failed", { status: 503 }));
    if (failure === "receipt")
      h.failPublication(Response.json({ accepted: false, event_id: "wrong" }));
    if (failure === "conflict") h.conflict();
    await expect(
      h.transport.writeSidebarStar(
        { channelId: "alpha", starred: true },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    if (["query", "oversized"].includes(failure))
      expect(h.calls.filter((call) => call.url.endsWith("/events"))).toEqual(
        [],
      );
  },
);
