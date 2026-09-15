import { fixtureRelayUrl, fixtureAliases } from "../tests/relay-config.ts";
import { createRelayReader } from "../src/features/relay/reader.ts";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools";
import { relayBrokerPlugin } from "./relay-broker.mjs";
import { connectBrokerTransport } from "../src/features/relay/transport.ts";
import { PublishRejected } from "../src/features/relay/outbox.ts";

// Only wall time is controlled. Real timers/performance.now still exercise HTTP pacing.
let wallClock;
beforeEach(() => {
  wallClock = 1700000000999;
  vi.spyOn(Date, "now").mockImplementation(() => wallClock);
});
afterEach(() => vi.restoreAllMocks());

// Real browser HTTP -> production broker. Ephemeral key; upstream I/O is entirely local.
async function harness(respond) {
  const key = new Uint8Array(32);
  key[31] = 7;
  const viewer = getPublicKey(key);
  const event = finalizeEvent(
    { kind: 9, content: "fixture", created_at: 1700000000, tags: [["h", "c"]] },
    key,
  );
  const calls = [];
  let handler;
  const server = createServer((req, res) => {
    req.headers.origin = `http://${req.headers.host}`;
    handler?.(req, res);
  });
  const plugin = relayBrokerPlugin({
    relayUrl: fixtureRelayUrl,
    communityAliases: fixtureAliases,
    identity: () => key,
    authority: async () => ({ relayAuthor: viewer }),
    upstreamFetch: async (url, init) => {
      const auth = JSON.parse(
        Buffer.from(init.headers.Authorization.slice(6), "base64").toString(),
      );
      expect(verifyEvent(auth)).toBe(true);
      expect(auth.created_at).toBe(Math.floor(Date.now() / 1000));
      const call = {
        url: String(url),
        body: JSON.parse(init.body),
        signal: init.signal,
        at: performance.now(),
      };
      calls.push(call);
      return respond(call, calls.length, event);
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
  return {
    base,
    event,
    calls,
    post(route, body, signal, priority) {
      return fetch(`${base}/api/relay/${route}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(priority ? { "X-Buzz-Read-Priority": priority } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
const filters = [{ kinds: [0], limit: 1 }];
const success = (call, _count, event) =>
  Response.json(
    call.url.endsWith("/events") ? { accepted: true, event_id: event.id } : [],
  );

test("upstream quota survives browser recreation, gates reads/profile/publish and leaves other communities independent", async () => {
  const h = await harness((call, count, event) =>
    count === 1
      ? Response.json(
          {
            error: "rate-limited: quota exceeded; retry in 0s",
            secret: "not forwarded",
          },
          { status: 429 },
        )
      : success(call, count, event),
  );
  try {
    const first = await connectBrokerTransport(h.base);
    await expect(first.query(filters)).rejects.toMatchObject({
      kind: "unavailable",
      status: 429,
      retryAfterMs: 1000,
    });
    const replacement = await connectBrokerTransport(h.base);
    await expect(replacement.query(filters)).rejects.toMatchObject({
      kind: "unavailable",
      status: 429,
      retryAfterMs: expect.any(Number),
    });
    await expect(
      replacement.writer.publish(h.event, new AbortController().signal),
    ).rejects.toBeInstanceOf(PublishRejected);
    const profile = await h.post("profile", { name: "Fixture", picture: "" });
    expect(profile.status).toBe(429);
    expect(await profile.json()).toMatchObject({ paused: true, sent: false });
    expect(h.calls).toHaveLength(1);
    const independent = await connectBrokerTransport(
      h.base,
      undefined,
      "secondary",
    );
    await independent.query(filters);
    expect(h.calls).toHaveLength(2);
    await delay(1050);
    await replacement.writer.publish(h.event, new AbortController().signal);
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2].body).toEqual(JSON.parse(JSON.stringify(h.event)));
    expect(h.calls[2].at - h.calls[0].at).toBeGreaterThanOrEqual(1000);
  } finally {
    await h.close();
  }
});

test("foreground publish overtakes queued background reads; cancellation consumes no later start", async () => {
  const h = await harness(success);
  try {
    await (await h.post("query", filters)).text();
    const cancel = new AbortController();
    const cancelled = h.post(
      "query",
      [{ kinds: [0], limit: 2 }],
      cancel.signal,
      "background",
    );
    const rejection = expect(cancelled).rejects.toMatchObject({
      name: "AbortError",
    });
    const background = h.post(
      "query",
      [{ kinds: [0], limit: 3 }],
      undefined,
      "background",
    );
    await delay(50); // Both requests have reached the real broker's admission queue.
    cancel.abort();
    await rejection;
    const write = h.post("publish", h.event);
    await (await write).text();
    await (await background).text();
    expect(h.calls.map((c) => c.url.split("/").at(-1))).toEqual([
      "query",
      "events",
      "query",
    ]);
    expect(h.calls[2].body[0].limit).toBe(3);
    for (let i = 1; i < h.calls.length; i++)
      expect(h.calls[i].at - h.calls[i - 1].at).toBeGreaterThanOrEqual(490);
  } finally {
    await h.close();
  }
});

test("local capacity is explicitly unsent, not relay quota; unknown upstream publication is never resent", async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const h = await harness(async (call, count, event) => {
    await held;
    return success(call, count, event);
  });
  const controllers = [];
  try {
    const requests = Array.from({ length: 6 }, () => {
      const controller = new AbortController();
      controllers.push(controller);
      return h.post("query", filters, controller.signal);
    });
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    await delay(50);
    const refused = await h.post("publish", h.event);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      error: "Query concurrency limit",
      sent: false,
    });
    release();
    await Promise.all(
      requests.map(async (response) => (await response).text()),
    );
    expect(h.calls).toHaveLength(6);
    const transport = await connectBrokerTransport(h.base);
    // Generic upstream 503 is not proof of non-delivery (separate fixture below).
    await transport.query(filters);
    expect(h.calls).toHaveLength(7); // Local capacity did not introduce a relay cooldown.
  } finally {
    release();
    for (const c of controllers) c.abort();
    await h.close();
  }
  const uncertain = await harness(
    () => new Response("private upstream detail", { status: 503 }),
  );
  try {
    const transport = await connectBrokerTransport(uncertain.base);
    await expect(
      transport.writer.publish(uncertain.event, new AbortController().signal),
    ).rejects.not.toBeInstanceOf(PublishRejected);
    expect(uncertain.calls).toHaveLength(1);
    await delay(550);
    expect(uncertain.calls).toHaveLength(1);
  } finally {
    await uncertain.close();
  }
}, 10000);

// Reader-to-host priority propagation control contributed by Brain.
test("priority reaches actual broker from the production reader and transport", async () => {
  const h = await harness(success);
  let reader;
  try {
    const t = await connectBrokerTransport(h.base);
    reader = createRelayReader(t);
    await reader.reader.read([{ kinds: [0], limit: 1 }]);
    const background = reader.reader.read([{ kinds: [0], limit: 2 }], {
      priority: "background",
    });
    await delay(50);
    const foreground = reader.reader.read([{ kinds: [0], limit: 3 }], {
      priority: "foreground",
    });
    await Promise.all([background, foreground]);
    expect(h.calls.map((c) => c.body[0].limit)).toEqual([1, 3, 2]);
  } finally {
    reader?.dispose();
    await h.close();
  }
});

test("queued request mints fresh auth at dispatch after wall time advances", async () => {
  const h = await harness(success);
  try {
    await (await h.post("query", filters)).text();
    const queued = h.post("query", [{ kinds: [0], limit: 2 }]);
    // Reach the broker while its real 500ms pacing interval is still active.
    await delay(50);
    expect(h.calls).toHaveLength(1);
    wallClock += 61000;
    const response = await queued;
    expect(response.status).toBe(200);
    await response.text();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].at - h.calls[0].at).toBeGreaterThanOrEqual(490);
  } finally {
    await h.close();
  }
});

test("both real sign and publish routes admit direct replies but reject arbitrary references before upstream I/O", async () => {
  const h = await harness((call) =>
    Response.json({ accepted: true, event_id: call.body.id }),
  );
  try {
    const template = {
      ...h.event,
      tags: [
        ["h", "c"],
        ["e", "a".repeat(64), "", "reply"],
        ["p", "b".repeat(64)],
      ],
    };
    const signed = await h.post("sign", template);
    expect(signed.status).toBe(200);
    const event = await signed.json();
    expect(verifyEvent(event)).toBe(true);
    expect(event.tags).toEqual(template.tags);
    expect(h.calls).toHaveLength(0);
    const published = await h.post("publish", event);
    expect(published.status).toBe(200);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].body).toEqual(JSON.parse(JSON.stringify(event)));
    for (const route of ["sign", "publish"]) {
      for (const references of [
        [["e", "a".repeat(64)]],
        [["e", "a".repeat(64), "", "root"]],
        [["e", "invalid", "", "reply"]],
        [
          ["e", "a".repeat(64), "", "reply"],
          ["e", "b".repeat(64), "", "reply"],
        ],
      ]) {
        const rejected = await h.post(route, {
          ...event,
          tags: [["h", "c"], ...references],
        });
        expect(rejected.status).toBe(400);
        expect(await rejected.json()).toEqual({ error: "Message rejected" });
      }
    }
    expect(h.calls).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("live room commands construct fixed private-channel events and audio auth stays challenge-scoped", async () => {
  const invited = "a".repeat(64);
  const h = await harness((call) =>
    Response.json({ accepted: true, event_id: call.body.id }),
  );
  try {
    const authResponse = await h.post("huddle-auth", {
      challenge: "relay-issued-challenge",
      kind: 1,
      content: "ignored",
    });
    expect(authResponse.status).toBe(200);
    const auth = await authResponse.json();
    expect(verifyEvent(auth)).toBe(true);
    expect(auth).toMatchObject({
      kind: 22242,
      content: "",
      pubkey: getPublicKey(new Uint8Array([...Array(31).fill(0), 7])),
    });
    expect(auth.tags).toEqual([
      ["relay", fixtureRelayUrl.replace(/^http/, "ws")],
      ["challenge", "relay-issued-challenge"],
    ]);
    expect(h.calls).toHaveLength(0);

    const createdResponse = await h.post("rooms-create", {
      name: "Design pairing",
      invited: [invited, invited],
      visibility: "open",
    });
    expect(createdResponse.status).toBe(200);
    const { roomId } = await createdResponse.json();
    expect(roomId).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.calls.map((call) => call.body.kind)).toEqual([9007, 9000]);
    expect(h.calls[0].body.tags).toEqual([
      ["h", roomId],
      ["name", "Live: Design pairing"],
      ["visibility", "private"],
      ["channel_type", "stream"],
      ["about", "buzz.live-room.v1"],
    ]);
    expect(h.calls[1].body.tags).toEqual([
      ["h", roomId],
      ["p", invited],
    ]);
    const renameResponse = await h.post("rooms-rename", {
      roomId,
      name: "Team focus",
    });
    expect(renameResponse.status).toBe(200);
    expect(await renameResponse.json()).toEqual({ renamed: true });
    expect(h.calls[2].body.kind).toBe(9002);
    expect(h.calls[2].body.tags).toEqual([
      ["h", roomId],
      ["name", "Live: Team focus"],
    ]);
    const deleteResponse = await h.post("rooms-delete", { roomId });
    expect(deleteResponse.status).toBe(200);
    expect(await deleteResponse.json()).toEqual({ deleted: true });
    expect(h.calls.slice(3, 5).map((call) => call.body.kind)).toEqual([
      9002, 9008,
    ]);
    expect(h.calls[3].body.tags).toEqual([
      ["h", roomId],
      ["archived", "false"],
    ]);
    expect(h.calls[4].body.tags).toEqual([["h", roomId]]);
    const audioResponse = await h.post("rooms-audio-start", {
      parentRoomId: roomId,
      members: [invited],
    });
    expect(audioResponse.status).toBe(200);
    const { audioRoomId } = await audioResponse.json();
    expect(audioRoomId).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.calls.slice(5).map((call) => call.body.kind)).toEqual([
      9007, 9000, 48100,
    ]);
    expect(h.calls[5].body.tags).toContainEqual(["ttl", "3600"]);
    expect(h.calls[7].body.tags).toEqual([["h", roomId]]);
    expect(JSON.parse(h.calls[7].body.content)).toEqual({
      ephemeral_channel_id: audioRoomId,
    });
    expect(h.calls.every((call) => verifyEvent(call.body))).toBe(true);
  } finally {
    await h.close();
  }
});

test("live room commands reject malformed names, identities, room ids and challenges without upstream I/O", async () => {
  const h = await harness(success);
  try {
    for (const [route, body] of [
      ["rooms-create", { name: "", invited: [] }],
      ["rooms-create", { name: "Valid", invited: ["not-a-pubkey"] }],
      ["rooms-invite", { roomId: "not-a-room", pubkey: "a".repeat(64) }],
      ["rooms-rename", { roomId: "not-a-room", name: "Valid" }],
      ["rooms-rename", { roomId: crypto.randomUUID(), name: "" }],
      ["rooms-delete", { roomId: "not-a-room" }],
      ["rooms-audio-start", { parentRoomId: "not-a-room", members: [] }],
      ["huddle-auth", { challenge: "line\nbreak" }],
    ]) {
      const response = await h.post(route, body);
      expect(response.status).toBe(400);
    }
    expect(h.calls).toHaveLength(0);
  } finally {
    await h.close();
  }
});
