import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { EventTemplate, VerifiedEvent } from "nostr-tools";
import {
  connectNativeTransport,
  nativeRelayRequest,
  nativeRelaySigner,
} from "./native";
import { keypair, message, signed } from "./testing";
import { createOutbox, type OutgoingEvent, PublishRejected } from "./outbox";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));
const viewer = keypair(),
  relay = keypair();
const community = "https://packaged.test";
type Request = {
  community: string;
  path: string;
  method: string;
  body: string | null;
};
let respond: (
  request: Request,
) =>
  | { status?: number; body: unknown }
  | Promise<{ status?: number; body: unknown }>;
const requests: Request[] = [];
const owners: ReturnType<typeof createOutbox>[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1700000010000);
  requests.length = 0;
  respond = () => ({ body: [] });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Packaged connections must not call the dev broker");
    }),
  );
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "identity_restore") return viewer.pubkey;
    if (command === "relay_sign") {
      expect(
        Object.keys((args as { event: EventTemplate }).event).sort(),
      ).toEqual(["content", "created_at", "kind", "tags"]);
      return signed(viewer, (args as { event: EventTemplate }).event);
    }
    if (command === "relay_http") {
      const request = args as Request;
      requests.push(request);
      const result =
        request.path === "/"
          ? { body: { self: relay.pubkey } }
          : await respond(request);
      return {
        status: result.status ?? 200,
        headers: {},
        body: JSON.stringify(result.body),
      };
    }
    throw new Error(`Unexpected native command: ${command}`);
  });
});

it("requires the relay self key, never its operator contact pubkey", async () => {
  vi.mocked(invoke).mockResolvedValueOnce({
    status: 200,
    headers: {},
    body: JSON.stringify({ pubkey: relay.pubkey }),
  });
  await expect(connectNativeTransport(community)).rejects.toThrow(
    "advertise its identity",
  );
});

it("reads back expired delivery with strong consistency without re-signing or publishing it", async () => {
  const transport = await connectNativeTransport(community);
  assert.exists(transport.writer);
  const event = message(viewer, "channel", "old delivery", 1699999000);
  respond = () => ({ body: [event] });
  await transport.writer.publish(event, new AbortController().signal);
  expect(JSON.parse(requests.at(-1)?.body ?? "null")).toEqual([
    {
      kinds: [9],
      ids: [event.id],
      authors: [viewer.pubkey],
      limit: 1,
      consistency: "strong",
    },
  ]);
  respond = () => ({ body: [] });
  await expect(
    transport.writer.publish(event, new AbortController().signal),
  ).rejects.toThrow("too old to retry");
  respond = () => ({ status: 503, body: { error: "offline" } });
  await expect(
    transport.writer.publish(event, new AbortController().signal),
  ).rejects.not.toBeInstanceOf(PublishRejected);
  expect(requests.every((request) => request.path !== "/events")).toBe(true);
  expect(
    vi.mocked(invoke).mock.calls.some(([command]) => command === "relay_sign"),
  ).toBe(false);
});
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("discovers the relay, verifies reads and publishes through the same native identity and destination", async () => {
  const incoming = message(viewer, "channel", "hello", 1700000000);
  respond = (r) =>
    r.path === "/query"
      ? { body: [incoming] }
      : {
          body: {
            accepted: true,
            event_id: JSON.parse(r.body ?? "{}").id,
            message: "confirmed",
          },
        };
  const transport = await connectNativeTransport(community);
  expect(transport.viewer).toBe(viewer.pubkey);
  expect(transport.relayAuthor).toBe(relay.pubkey);
  expect(
    await transport.query([{ kinds: [9], "#h": ["channel"], limit: 10 }]),
  ).toEqual([incoming]);
  assert.exists(transport.writer);
  const event = await transport.writer.sign(
    {
      kind: 9,
      content: "native send",
      tags: [["h", "channel"]],
      created_at: 1700000001,
    },
    new AbortController().signal,
  );
  expect(
    await transport.writer.publish(event, new AbortController().signal),
  ).toBe("confirmed");
  expect(requests.map((r) => [r.community, r.path])).toEqual([
    [community, "/"],
    [community, "/query"],
    [community, "/events"],
  ]);
  expect(JSON.parse(requests[2]?.body ?? "null")).toEqual(
    JSON.parse(JSON.stringify(event)),
  );
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects tampered reads and keeps refusals distinct from uncertain receipts", async () => {
  const transport = await connectNativeTransport(community);
  const event = message(viewer, "channel", "original", 1700000000);
  respond = () => ({ body: [{ ...event, content: "tampered" }] });
  await expect(transport.query([{ kinds: [9], limit: 10 }])).rejects.toThrow();
  assert.exists(transport.writer);
  respond = () => ({ status: 403, body: { error: "denied" } });
  await expect(
    transport.writer.publish(event, new AbortController().signal),
  ).rejects.toBeInstanceOf(PublishRejected);
  respond = () => ({ body: { accepted: true, event_id: "wrong" } });
  await expect(
    transport.writer.publish(event, new AbortController().signal),
  ).rejects.not.toBeInstanceOf(PublishRejected);
});

it("a captured signer cannot send a request to a different community", async () => {
  const signer = nativeRelaySigner(community);
  expect(() =>
    signer.request?.(
      "https://other.test/events",
      "{}",
      new AbortController().signal,
    ),
  ).toThrow("changed community");
  expect(invoke).not.toHaveBeenCalled();
});

it("authenticates live traffic with the native signer and verifies incoming channel events", async () => {
  const sockets: Socket[] = [];
  class Socket {
    readyState = 1;
    onmessage?: (event: { data: string }) => Promise<void>;
    onclose?: () => void;
    sent: unknown[][] = [];
    constructor(readonly url: string) {
      sockets.push(this);
    }
    send(raw: string) {
      this.sent.push(JSON.parse(raw));
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
    async receive(value: unknown) {
      await this.onmessage?.({ data: JSON.stringify(value) });
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  const transport = await connectNativeTransport(community);
  const receive = vi.fn();
  const traffic = transport.subscribe?.({
    receive,
    state: vi.fn(),
    established: vi.fn(),
    denied: vi.fn(),
  });
  assert.exists(traffic);
  try {
    traffic.update(["channel"]);
    const socket = sockets[0];
    assert.exists(socket);
    expect(socket.url).toBe("wss://packaged.test");
    await socket.receive(["AUTH", "nonce"]);
    const proof = socket.sent.find(
      ([kind]) => kind === "AUTH",
    )?.[1] as VerifiedEvent;
    expect(proof.pubkey).toBe(viewer.pubkey);
    expect(proof.tags).toEqual([
      ["relay", "wss://packaged.test"],
      ["challenge", "nonce"],
    ]);
    await socket.receive(["OK", proof.id, true]);
    const route = socket.sent.find(
      ([kind, , filter]) =>
        kind === "REQ" &&
        (filter as { "#h"?: string[] })["#h"]?.includes("channel"),
    );
    assert.exists(route);
    await socket.receive(["EOSE", route[1]]);
    const incoming = message(keypair(), "channel", "Live reply", 1700000002);
    await socket.receive(["EVENT", route[1], incoming]);
    expect(receive).toHaveBeenCalledWith([incoming], {
      phase: "live",
      channelId: "channel",
    });
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([command]) => command === "identity_export"),
    ).toBe(false);
  } finally {
    traffic.dispose();
  }
});

it("cancellation fences a late native response and prevents undispatched work", async () => {
  const gate = deferred<{ body: unknown }>();
  respond = () => gate.promise;
  const controller = new AbortController();
  const request = nativeRelayRequest(
    community,
    "/query",
    [],
    controller.signal,
  );
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  controller.abort();
  try {
    await expect(
      nativeRelayRequest(community, "/query", [], controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toHaveLength(1);
  } finally {
    gate.resolve({ body: [] });
  }
  await expect(request).rejects.toMatchObject({ name: "AbortError" });
});

it("cancelled native reads retain the six-request admission bound until IPC settles", async () => {
  vi.useFakeTimers();
  const transport = await connectNativeTransport(
    "https://cancelled-native.test",
  );
  const gate = deferred<{ body: unknown }>();
  let active = 0,
    maximum = 0;
  respond = async () => {
    active++;
    maximum = Math.max(maximum, active);
    try {
      return await gate.promise;
    } finally {
      active--;
    }
  };
  const controllers = Array.from({ length: 12 }, () => new AbortController());
  const reads = controllers.map((controller) =>
    transport
      .query([{ kinds: [0], limit: 5 }], controller.signal)
      .catch((error: unknown) => error),
  );
  try {
    await vi.waitFor(() =>
      expect(requests.filter((r) => r.path === "/query")).toHaveLength(6),
    );
    for (const controller of controllers) controller.abort();
    // A further request has entered the same lane, but cannot dispatch past cancelled native work.
    const last = transport.query([{ kinds: [0], limit: 5 }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(requests.filter((r) => r.path === "/query")).toHaveLength(6);
    gate.resolve({ body: [] });
    await last;
    expect(requests.filter((r) => r.path === "/query")).toHaveLength(7);
    for (const error of await Promise.all(reads))
      expect(error).toMatchObject({ name: "AbortError" });
    expect(maximum).toBe(6);
  } finally {
    gate.resolve({ body: [] });
    await Promise.all(reads);
  }
});

it("restores uncertain native delivery and retries the exact signed event without signing it again", async () => {
  let records: readonly OutgoingEvent[] = [];
  const storage = {
    load: () => structuredClone(records),
    save: (next: readonly OutgoingEvent[]) => {
      records = structuredClone(next);
    },
  };
  const first = await connectNativeTransport(community);
  assert.exists(first.writer);
  respond = () => {
    throw new Error("Receipt lost after dispatch");
  };
  const one = createOutbox(viewer.pubkey, first.writer, storage);
  owners.push(one);
  await one.outbox.ready();
  const id = one.outbox.send({
    kind: 9,
    content: "recover me",
    tags: [["h", "channel"]],
  });
  await vi.waitFor(() => expect(records[0]?.delivery).toBe("unknown"));
  const published = JSON.parse(
    requests.find((r) => r.path === "/events")?.body ?? "null",
  );
  one.dispose();
  vi.mocked(invoke).mockClear();
  const second = await connectNativeTransport(community);
  assert.exists(second.writer);
  respond = () => ({ body: { accepted: true, event_id: published.id } });
  const two = createOutbox(viewer.pubkey, second.writer, storage);
  owners.push(two);
  await two.outbox.ready();
  expect(two.outbox.snapshot()[0]?.delivery).toBe("unknown");
  two.outbox.retry(id);
  await vi.waitFor(() =>
    expect(two.outbox.snapshot()[0]?.delivery).toBe("accepted"),
  );
  expect(
    requests
      .filter((r) => r.path === "/events")
      .map((r) => JSON.parse(r.body ?? "null")),
  ).toEqual([published, published]);
  expect(
    vi.mocked(invoke).mock.calls.some(([command]) => command === "relay_sign"),
  ).toBe(false);
});

it.each(["missing", "offline"])(
  "keeps expired delivery unknown after %s readback",
  async (failure) => {
    const event = message(viewer, "channel", "expired intent", 1699999000);
    let records: readonly OutgoingEvent[] = [
      { event, signed: event, delivery: "unknown" },
    ];
    const transport = await connectNativeTransport(community);
    assert.exists(transport.writer);
    respond = () =>
      failure === "missing"
        ? { body: [] }
        : { status: 503, body: { error: "offline" } };
    const owner = createOutbox(viewer.pubkey, transport.writer, {
      load: () => structuredClone(records),
      save: (next) => {
        records = structuredClone(next);
      },
    });
    owners.push(owner);
    await owner.outbox.ready();
    owner.outbox.retry(event.id);
    await vi.waitFor(() =>
      expect(records[0]?.error).toMatch(
        failure === "missing"
          ? /too old to retry/
          : /Relay request failed \(503\)/,
      ),
    );
    expect(records[0]).toMatchObject({ signed: event, delivery: "unknown" });
    expect(requests.some((request) => request.path === "/events")).toBe(false);
  },
);
