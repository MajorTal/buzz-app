import { assert, afterEach, expect, it, vi } from "vitest";
import { connectBrokerTransport, connectSignedTransport } from "./transport";
import { PublishRejected } from "./outbox";
import { keypair, signed } from "./testing";
const key = keypair();
afterEach(() => vi.unstubAllGlobals());
it("publishes the unchanged signed event to /events with request-bound NIP-98 auth", async () => {
  const event = signed(key, { kind: 9, content: "hello", tags: [["h", "c"]] });
  const fetcher = vi.fn(async () =>
    Response.json({ accepted: true, event_id: event.id }),
  );
  vi.stubGlobal("fetch", fetcher);
  const transport = await connectSignedTransport(
    {
      getPublicKey: async () => key.pubkey,
      signEvent: async (template) => signed(key, template),
    },
    "https://relay.test",
    "relay",
  );
  assert.exists(transport.writer);
  await transport.writer.publish(event, new AbortController().signal);
  const call = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(call[0]).toBe("https://relay.test/events");
  expect(JSON.parse(call[1].body as string)).toEqual(
    JSON.parse(JSON.stringify(event)),
  );
  const headers = call[1].headers as Record<string, string>;
  assert.exists(headers.Authorization);
  const auth = JSON.parse(atob(headers.Authorization.slice(6)));
  expect(auth.tags).toContainEqual(["u", "https://relay.test/events"]);
  expect(auth.tags).toContainEqual(["method", "POST"]);
  expect(
    auth.tags.find((tag: string[]) => tag[0] === "payload")?.[1],
  ).toHaveLength(64);
});
it("distinguishes explicit rejection from invalid or missing delivery receipts", async () => {
  const event = signed(key, { kind: 9, content: "hello", tags: [["h", "c"]] });
  const transport = await connectSignedTransport(
    {
      getPublicKey: async () => key.pubkey,
      signEvent: async (template) => signed(key, template),
    },
    "https://relay.test",
    "relay",
  );
  vi.stubGlobal("fetch", async () =>
    Response.json({ accepted: false, event_id: event.id, message: "denied" }),
  );
  assert.exists(transport.writer);
  await expect(
    transport.writer.publish(event, new AbortController().signal),
  ).rejects.toBeInstanceOf(PublishRejected);
  vi.stubGlobal("fetch", async () =>
    Response.json({ accepted: true, event_id: "wrong" }),
  );
  assert.exists(transport.writer);
  await expect(
    transport.writer.publish(event, new AbortController().signal),
  ).rejects.toThrow("invalid delivery receipt");
  vi.stubGlobal(
    "fetch",
    async () => new Response("unavailable", { status: 503 }),
  );
  assert.exists(transport.writer);
  await expect(
    transport.writer.publish(event, new AbortController().signal),
  ).rejects.not.toBeInstanceOf(PublishRejected);
  // A broker that never reached the relay is a definite non-delivery, not an unknown outcome.
  vi.stubGlobal("fetch", async () =>
    Response.json({ error: "Relay unreachable", sent: false }, { status: 502 }),
  );
  assert.exists(transport.writer);
  await expect(
    transport.writer.publish(event, new AbortController().signal),
  ).rejects.toBeInstanceOf(PublishRejected);
});
it("the broker advertises and supplies writes through the same connection", async () => {
  const event = signed(key, { kind: 9, content: "hello", tags: [["h", "c"]] });
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith("/session"))
      return Response.json({
        viewer: key.pubkey,
        relayAuthor: "relay",
        relayUrl: "https://relay.test",
        writeKinds: [9],
      });
    if (url.endsWith("/sign")) return Response.json(event);
    return Response.json({ accepted: true, event_id: event.id });
  });
  vi.stubGlobal("fetch", fetcher);
  const transport = await connectBrokerTransport();
  expect(transport.scope).toBe("https://relay.test");
  expect(transport.writer?.kinds).toEqual([9]);
  assert.exists(transport.writer);
  const signedEvent = await transport.writer.sign(
    event,
    new AbortController().signal,
  );
  await transport.writer.publish(signedEvent, new AbortController().signal);
  expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
    "/api/relay/session",
    "/api/relay/sign",
    "/api/relay/publish",
  ]);
});

it("requests relay thumbnails only for small media", async () => {
  vi.stubGlobal("fetch", async () =>
    Response.json({
      viewer: key.pubkey,
      relayAuthor: "relay",
      relayUrl: "https://relay.test",
    }),
  );
  const transport = await connectBrokerTransport();
  const hash = "1".repeat(64);
  const original = `https://relay.test/media/${hash}.png`;
  const thumbnail = `https://relay.test/media/${hash}.thumb.jpg`;

  expect(transport.media(original)).toBe(
    `/api/relay/media?url=${encodeURIComponent(original)}`,
  );
  expect(transport.media(original, "small")).toBe(
    `/api/relay/media?url=${encodeURIComponent(thumbnail)}`,
  );
  expect(transport.media("https://images.example/avatar.png", "small")).toBe(
    "https://images.example/avatar.png",
  );
});

it.each([null, 42, "", "A".repeat(64), "b".repeat(64)])(
  "rejects malformed or mismatched broker archive authority %j",
  async (archiveAuthority) => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        viewer: key.pubkey,
        relayAuthor: key.pubkey,
        archiveAuthority,
      }),
    );
    await expect(connectBrokerTransport()).rejects.toMatchObject({
      kind: "invalid-response",
    });
  },
);
it("does not infer archive authority from a host-supplied signing key", async () => {
  const transport = await connectSignedTransport(
    {
      getPublicKey: async () => key.pubkey,
      signEvent: async (template) => signed(key, template),
    },
    "https://relay.test",
    key.pubkey,
  );
  expect(transport.archiveAuthority).toBeUndefined();
});

it.each([Infinity, 1.5])(
  "direct signed transport rejects raw invalid timestamp %s",
  async (created_at) => {
    const event = signed(key, { kind: 0, created_at, content: "{}", tags: [] });
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify([event]).replace(
            '"created_at":null',
            '"created_at":1e400',
          ),
        ),
    );
    const transport = await connectSignedTransport(
      {
        getPublicKey: async () => key.pubkey,
        signEvent: async (template) => signed(key, template),
      },
      "https://relay.test",
      key.pubkey,
    );
    await expect(transport.query([{ kinds: [0], limit: 1 }])).rejects.toThrow(
      /malformed/,
    );
  },
);

it("uses each signed transport's own origin for protected media, never a deployment default", async () => {
  const signer = {
    getPublicKey: async () => "a".repeat(64),
    signEvent: async () => {
      throw new Error("not signing");
    },
  };
  const a = await connectSignedTransport(
    signer,
    "wss://media-a.example",
    "b".repeat(64),
  );
  const b = await connectSignedTransport(
    signer,
    "wss://media-b.example",
    "c".repeat(64),
  );
  expect(a.media("https://media-a.example/media/private")).toBeUndefined();
  expect(b.media("https://media-b.example/media/private")).toBeUndefined();
  expect(a.media("https://images.example/public.png")).toBe(
    "https://images.example/public.png",
  );
  expect(a.media("http://images.example/insecure.png")).toBeUndefined();
});

it("presence validates whole snapshots before omission means Offline; busy is not empty", async () => {
  const relay = keypair(),
    author = keypair().pubkey,
    absent = keypair().pubkey;
  const event = signed(relay, {
    kind: 20001,
    content: "online",
    tags: [["p", author]],
  });
  let response = () => Response.json([event]);
  const fetcher = vi.fn(async (url: string) =>
    url.endsWith("/session")
      ? Response.json({
          viewer: key.pubkey,
          relayAuthor: relay.pubkey,
          live: true,
          presence: true,
        })
      : response(),
  );
  vi.stubGlobal("fetch", fetcher);
  const transport = await connectBrokerTransport();
  assert.exists(transport.presenceSnapshot);
  const snapshot = transport.presenceSnapshot;
  const read = () => snapshot([author, absent], new AbortController().signal);
  expect(await read()).toEqual(
    new Map([
      [author, "online"],
      [absent, "offline"],
    ]),
  );
  response = () => new Response(null, { status: 204 });
  expect(await read()).toBeNull();
  for (const events of [
    [event, event],
    [{ ...event, sig: "0".repeat(128) }],
    [signed(key, { kind: 20001, content: "online", tags: [["p", author]] })],
    [
      signed(relay, {
        kind: 20001,
        content: "online",
        tags: [["p", key.pubkey]],
      }),
    ],
    [signed(relay, { kind: 20001, content: "maybe", tags: [["p", author]] })],
    [
      signed(relay, {
        kind: 20001,
        content: "away",
        tags: [
          ["p", author],
          ["p", absent],
        ],
      }),
    ],
  ]) {
    response = () => Response.json(events);
    await expect(read()).rejects.toThrow();
  }
  response = () =>
    Response.json([
      signed(relay, {
        kind: 20001,
        content: '{"status":"away"}',
        tags: [["p", author]],
      }),
    ]);
  expect((await read())?.get(author)).toBe("away");
  response = () => new Response(" ".repeat(1024 * 1024 + 1));
  await expect(read()).rejects.toThrow("capacity");
  await expect(snapshot([], new AbortController().signal)).rejects.toThrow(
    "demand",
  );
});
