import { assert, afterEach, expect, it, vi } from "vitest";
import { CommunityError, createNativeCommunities } from "./native";
import { keypair, signed } from "../relay/testing";
import type { IdentityStatus } from "../identity/contracts";
import { PublishRejected } from "../relay/outbox";
import type { EventTemplate } from "nostr-tools";

const key = keypair(),
  relay = keypair();
const ready: IdentityStatus = {
  state: "ready",
  pubkey: key.pubkey,
  generation: "2",
  revocation: "11111111-1111-4111-8111-111111111111",
  busy: false,
  reason: null,
};
function fixture() {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException("Timed out", "TimeoutError")),
      milliseconds,
    );
    return controller.signal;
  });
  let status: IdentityStatus | null = ready;
  const controller = new AbortController();
  const info = {
    viewer: key.pubkey,
    relayAuthor: relay.pubkey,
    archiveAuthority: relay.pubkey,
    policy: null,
  };
  const call = vi.fn(
    async (
      command: string,
      { request }: { request: Record<string, unknown> },
    ): Promise<unknown> => {
      let value: unknown = info;
      if (command === "community_query") value = [];
      if (command.startsWith("community_sign_"))
        value = signed(key, request.template as EventTemplate);
      if (command === "community_publish")
        value = {
          event_id: (request.event as { id: string }).id,
          accepted: true,
          duplicate: false,
        };
      return { scope: request.scope, value };
    },
  );
  const source = createNativeCommunities(
    {
      snapshot: () => ({
        identity: status,
        pending: null,
        error: null,
        selectedPubkey: key.pubkey,
        canSignOut: true,
      }),
      subscribe: () => () => {},
    },
    call,
  );
  return {
    source,
    call,
    controller,
    info,
    change: (value: IdentityStatus | null) => {
      status = value;
    },
    connect: () =>
      source.connect(ready, "https://one.example", controller.signal),
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function writer(
  transport: Awaited<ReturnType<ReturnType<typeof fixture>["connect"]>>,
) {
  assert.exists(transport.writer);
  return transport.writer;
}
async function run<T>(promise: Promise<T>) {
  const result = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.advanceTimersByTimeAsync(550);
  const settled = await result;
  if ("error" in settled) throw settled.error;
  return settled.value;
}
it("uses scoped purpose commands, verifies signatures and omits unsupported capabilities", async () => {
  const f = fixture(),
    transport = await f.connect();
  const template = {
    kind: 9,
    created_at: 123,
    content: "hello",
    tags: [
      ["h", "channel"],
      ["client-id", "stable"],
    ],
  };
  const event = await writer(transport).sign(template, f.controller.signal);
  await run(writer(transport).publish(event, f.controller.signal));
  const filters = [
    {
      kinds: [9],
      "#h": ["channel"],
      top_level: true,
      include_aux: true,
      before_id: "a".repeat(64),
      limit: 50,
    },
  ];
  await run(transport.query(filters));
  expect(f.call.mock.calls.map(([name]) => name)).toEqual([
    "community_discover",
    "community_sign_message",
    "community_publish",
    "community_query",
  ]);
  expect(f.call.mock.calls[3]?.[1].request.filters).toEqual(filters);
  for (const [, { request }] of f.call.mock.calls)
    expect(request.scope).toEqual({
      origin: "https://one.example",
      expectedPubkey: key.pubkey,
      generation: "2",
      revocation: ready.revocation,
    });
  expect(transport.writer?.kinds).toEqual([0, 9]);
  expect(transport.subscribe).toBeUndefined();
  expect(transport.readState).toBeUndefined();
  expect(transport.readAgentLibrary).toBeUndefined();
  expect(transport.media("https://one.example/media/private")).toBeUndefined();
  expect(transport.media("https://images.example/public.png")).toBe(
    "https://images.example/public.png",
  );
});
it.each(["origin", "expectedPubkey", "generation", "revocation"])(
  "rejects a mismatched %s in returned authority",
  async (field) => {
    const f = fixture();
    f.call.mockImplementationOnce(async (_command, { request }) => ({
      scope: { ...(request.scope as object), [field]: "different" },
      value: f.info,
    }));
    await expect(f.connect()).rejects.toMatchObject({
      code: "invalidResponse",
    });
  },
);
it("fences queued signing and late responses after same-key retirement", async () => {
  const f = fixture(),
    transport = await f.connect();
  f.change({ ...ready, generation: "4" });
  await expect(
    writer(transport).sign(
      { kind: 0, created_at: 1, content: '{"name":"A"}', tags: [] },
      f.controller.signal,
    ),
  ).rejects.toMatchObject({ code: "cancelled", outcome: "notSent" });
  expect(f.call).toHaveBeenCalledTimes(1);
});
it("rejects signed template rewrites and wrong event receipts without treating them as not-sent", async () => {
  const f = fixture(),
    transport = await f.connect();
  f.call.mockImplementationOnce(async (_command, { request }) => ({
    scope: request.scope,
    value: signed(key, {
      ...(request.template as EventTemplate),
      content: "rewritten",
    }),
  }));
  await expect(
    writer(transport).sign(
      { kind: 0, created_at: 1, content: '{"name":"A"}', tags: [] },
      f.controller.signal,
    ),
  ).rejects.toMatchObject({ code: "invalidResponse" });
  f.call.mockImplementationOnce(async (_command, { request }) => ({
    scope: request.scope,
    value: { event_id: "a".repeat(64), accepted: true, duplicate: false },
  }));
  const result = run(
    writer(transport).publish(
      signed(key, { kind: 0, content: '{"name":"A"}', tags: [] }),
      f.controller.signal,
    ),
  );
  await expect(result).rejects.toMatchObject({
    code: "invalidResponse",
    outcome: "unknown",
  });
});
it.each(["notSent", "rejected", "unknown"])(
  "preserves native %s write evidence and redacts arbitrary text",
  async (outcome) => {
    const f = fixture(),
      transport = await f.connect();
    f.call.mockRejectedValueOnce({
      code: "denied",
      outcome,
      message: "secret-invite",
    });
    const error = await run(
      writer(transport).publish(
        signed(key, { kind: 0, content: '{"name":"A"}', tags: [] }),
        f.controller.signal,
      ),
    ).catch((error: unknown) => error);
    expect(error instanceof PublishRejected).toBe(outcome !== "unknown");
    expect(String(error)).not.toContain("secret-invite");
  },
);
it("only validated quota evidence pauses shared setup/transport admission", async () => {
  const f = fixture(),
    transport = await f.connect();
  f.call.mockRejectedValueOnce({
    code: "busy",
    httpStatus: 429,
    retryAfterMs: 60000,
  });
  await expect(
    run(transport.query([{ kinds: [0], limit: 1 }])),
  ).rejects.toMatchObject({ code: "busy" });
  await run(transport.query([{ kinds: [0], limit: 1 }]));
  f.call.mockRejectedValueOnce({
    code: "rateLimited",
    httpStatus: 429,
    retryAfterMs: 60000,
  });
  await expect(
    run(transport.query([{ kinds: [0], limit: 1 }])),
  ).rejects.toMatchObject({ code: "rateLimited" });
  const before = f.call.mock.calls.length;
  await expect(
    transport.query([{ kinds: [0], limit: 1 }]),
  ).rejects.toBeInstanceOf(CommunityError);
  expect(f.call).toHaveBeenCalledTimes(before);
});
it("native callback loss stays unknown and cannot admit unlimited unresolved invocations", async () => {
  const f = fixture(),
    transport = await f.connect();
  f.call.mockImplementation(() => new Promise(() => {}));
  const event = signed(key, { kind: 0, content: '{"name":"A"}', tags: [] });
  for (let i = 0; i < 6; i++) {
    const result = writer(transport)
      .publish(event, f.controller.signal)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(25001);
    expect(await result).toMatchObject({ outcome: "unknown" });
  }
  await expect(
    writer(transport).publish(event, f.controller.signal),
  ).rejects.toBeInstanceOf(PublishRejected);
  expect(f.call).toHaveBeenCalledTimes(7);
});
it("a real signed query event is checked again, not trusted from a cached verification symbol", async () => {
  const f = fixture(),
    transport = await f.connect();
  const event = signed(key, { kind: 0, content: '{"name":"A"}', tags: [] });
  f.call.mockImplementationOnce(async (_command, { request }) => ({
    scope: request.scope,
    value: [{ ...event, content: "tampered" }],
  }));
  await expect(
    run(transport.query([{ kinds: [0], limit: 1 }])),
  ).rejects.toMatchObject({ code: "invalidResponse" });
});
