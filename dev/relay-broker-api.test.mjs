import { fixtureRelayUrl, fixtureAliases } from "../tests/relay-config.ts";
import { createRelayReader } from "../src/features/relay/reader.ts";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
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
      const upstreamUrl = String(url);
      const authorization = new Headers(init?.headers).get("Authorization");
      const auth = authorization
        ? JSON.parse(Buffer.from(authorization.slice(6), "base64").toString())
        : undefined;
      if (upstreamUrl !== fixtureRelayUrl) expect(auth).toBeDefined();
      if (auth) {
        expect(verifyEvent(auth)).toBe(true);
        expect(auth.created_at).toBe(Math.floor(Date.now() / 1000));
      }
      const call = {
        url: upstreamUrl,
        body: init?.body ? JSON.parse(init.body) : undefined,
        signal: init?.signal,
        auth,
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
    get(route, signal) {
      return fetch(`${base}/api/relay/${route}`, { signal });
    },
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

test("GIF capability discovery does not depend on join-policy availability", async () => {
  const h = await harness((call) => {
    if (call.url === fixtureRelayUrl)
      return Response.json({
        supported_extensions: ["buzz-gif"],
        gif: { provider: "klipy", search: "/gifs/search" },
      });
    if (call.url === `${fixtureRelayUrl}/api/join-policy`)
      return new Response("unavailable", { status: 503 });
    return new Response(null, { status: 404 });
  });
  try {
    const response = await h.get("gif-info");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      supported_extensions: ["buzz-gif"],
      gif: { provider: "klipy", search: "/gifs/search" },
    });
    expect(h.calls.map(({ url }) => url)).toEqual([fixtureRelayUrl]);
  } finally {
    await h.close();
  }
});

test("GIF discovery retries unsupported relays and caches confirmed support", async () => {
  let supported = false;
  const descriptor = {
    supported_extensions: ["buzz-gif"],
    gif: { provider: "klipy", search: "/gifs/search" },
  };
  const h = await harness(() => Response.json(supported ? descriptor : {}));
  try {
    expect(await (await h.get("gif-info")).json()).toEqual({});
    supported = true;
    expect(await (await h.get("gif-info")).json()).toEqual(descriptor);
    expect(await (await h.get("gif-info")).json()).toEqual(descriptor);
    expect(h.calls.map(({ url }) => url)).toEqual([
      fixtureRelayUrl,
      fixtureRelayUrl,
    ]);
  } finally {
    await h.close();
  }
});

test("GIF search follows the relay-advertised KLIPY path with signed, bounded input", async () => {
  const responseBody = {
    result: true,
    data: { data: [{ id: 1, type: "gif", slug: "hello" }] },
  };
  const h = await harness((call) => {
    if (call.url === fixtureRelayUrl)
      return Response.json({
        supported_extensions: ["buzz-gif"],
        gif: { provider: "klipy", search: "/gifs/search" },
      });
    if (call.url === `${fixtureRelayUrl}/gifs/search`)
      return Response.json(responseBody);
    return new Response(null, { status: 404 });
  });
  try {
    const body = {
      customer_id: "fixture-customer",
      locale: "en-US",
      query: "hello",
    };
    const response = await h.post("gifs", body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(responseBody);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0]).toMatchObject({
      url: fixtureRelayUrl,
      body: undefined,
      auth: undefined,
    });
    expect(h.calls[1]).toMatchObject({
      url: `${fixtureRelayUrl}/gifs/search`,
      body,
    });
    expect(h.calls[1].auth.tags).toEqual(
      expect.arrayContaining([
        ["u", `${fixtureRelayUrl}/gifs/search`],
        ["method", "POST"],
        [
          "payload",
          createHash("sha256").update(JSON.stringify(body)).digest("hex"),
        ],
      ]),
    );

    const rejected = await h.post("gifs", { ...body, query: "x".repeat(101) });
    expect(rejected.status).toBe(400);
    expect(h.calls).toHaveLength(2);
  } finally {
    await h.close();
  }
});

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

test("reaction sign and publish preserve kind 7 and reject malformed targets before upstream I/O", async () => {
  const h = await harness((call) =>
    Response.json({ accepted: true, event_id: call.body.id }),
  );
  try {
    const template = {
      ...h.event,
      kind: 7,
      content: ":party:",
      tags: [
        ["h", "c"],
        ["e", "a".repeat(64)],
        ["emoji", "party", "https://a.test/party.png"],
      ],
    };
    const response = await h.post("sign", template);
    expect(response.status).toBe(200);
    const event = await response.json();
    expect(verifyEvent(event)).toBe(true);
    expect(event.kind).toBe(7);
    expect(event.tags).toEqual(template.tags);
    expect((await h.post("publish", event)).status).toBe(200);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].body).toEqual(JSON.parse(JSON.stringify(event)));
    for (const length of [62, 63, 64]) {
      const content = `:${"a".repeat(length)}:`;
      const signed = await h.post("sign", { ...template, content });
      expect(signed.status).toBe(200);
      const boundaryEvent = await signed.json();
      expect(boundaryEvent.content).toBe(content);
      expect((await h.post("publish", boundaryEvent)).status).toBe(200);
    }
    expect(h.calls).toHaveLength(4);
    for (const route of ["sign", "publish"]) {
      for (const tags of [
        [],
        [["e", "bad"]],
        [["e", "a".repeat(64), "", "reply"]],
        [
          ["e", "a".repeat(64)],
          ["e", "b".repeat(64)],
        ],
      ]) {
        expect(
          (await h.post(route, { ...event, tags: [["h", "c"], ...tags] }))
            .status,
        ).toBe(400);
      }
      expect(
        (await h.post(route, { ...event, content: "x".repeat(65) })).status,
      ).toBe(400);
      expect(
        (await h.post(route, { ...event, content: `:${"a".repeat(65)}:` }))
          .status,
      ).toBe(400);
      expect(
        (await h.post(route, { ...event, content: ` ${"x".repeat(64)}` }))
          .status,
      ).toBe(400);
    }
    expect(h.calls).toHaveLength(4);
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

test("held optional snapshot body leaves ordinary broker capacity free and start credit untouched", async () => {
  let release;
  const h = await harness((call) => {
    if (call.body?.[0]?.kinds?.includes(20001))
      return new Response(
        new ReadableStream({
          start(controller) {
            release = () => {
              controller.enqueue(new TextEncoder().encode("[]"));
              controller.close();
            };
          },
        }),
      );
    return Response.json([]);
  });
  const presence = [{ kinds: [20001], authors: [h.event.pubkey], limit: 1 }];
  try {
    const snapshot = h.post("presence-snapshot", presence);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const duplicate = await h.post("presence-snapshot", presence);
    expect(duplicate.status).toBe(204);
    expect((await h.post("query", filters)).status).toBe(200);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].at - h.calls[0].at).toBeLessThan(400);
    release();
    release = undefined;
    expect(await (await snapshot).json()).toEqual([]);
    expect(
      (await h.post("presence-snapshot", [{ ...presence[0], authors: [] }]))
        .status,
    ).toBe(400);
    expect(
      (
        await h.post("presence-snapshot", [
          { ...presence[0], authors: Array(257).fill(h.event.pubkey) },
        ])
      ).status,
    ).toBe(400);
    expect(h.calls).toHaveLength(2);
  } finally {
    release?.();
    await h.close();
  }
});
