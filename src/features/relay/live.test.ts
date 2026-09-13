import { assert, afterEach, expect, it, vi } from "vitest";
import {
  createLiveAdmission,
  liveChannels,
  subscribeRelayTraffic,
  type LiveCallbacks,
} from "./live";
import { keypair, message, signed } from "./testing";
class Socket {
  readyState = 1;
  onmessage?: (event: { data: string }) => Promise<void>;
  onclose?: () => void;
  onerror?: () => void;
  sent: unknown[][] = [];
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  async receive(value: unknown) {
    await this.onmessage?.({ data: JSON.stringify(value) });
  }
  requests() {
    return this.sent.filter((entry) => entry[0] === "REQ") as [
      string,
      string,
      {
        kinds: number[];
        "#h"?: string[];
        "#p"?: string[];
        since: number;
        limit: number;
      },
    ][];
  }
  async auth() {
    await this.receive(["AUTH", "challenge"]);
    const event = this.sent.find((entry) => entry[0] === "AUTH")?.[1] as {
      id: string;
    };
    await this.receive(["OK", event.id, true]);
  }
}
afterEach(() => vi.useRealTimers());
function setup(channels = ["a", "b"]) {
  const key = keypair(),
    sockets: Socket[] = [];
  const callbacks = {
    receive: vi.fn(),
    state: vi.fn<LiveCallbacks["state"]>(),
    established: vi.fn(),
    denied: vi.fn(),
  } satisfies LiveCallbacks;
  const owner = subscribeRelayTraffic(
    "wss://relay.test",
    async (event) => signed(key, event),
    key.pubkey,
    callbacks,
    () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  );
  owner.update(channels);
  const first = sockets[0];
  assert.exists(first);
  return { key, sockets, callbacks, owner, first };
}
it("uses independent explicit channel routes and self-p globals; equal interests do not restart", async () => {
  vi.useFakeTimers();
  const h = setup();
  await h.first.auth();
  await vi.advanceTimersByTimeAsync(750);
  expect(h.first.requests().map((r) => r[2])).toEqual([
    { kinds: [0], since: expect.any(Number), limit: 500 },
    {
      kinds: [44100, 44101],
      "#p": [h.key.pubkey],
      since: expect.any(Number),
      limit: 500,
    },
    {
      kinds: expect.arrayContaining([9, 40003, 7, 39002, 40099]),
      "#h": ["a"],
      since: expect.any(Number),
      limit: 500,
    },
    {
      kinds: expect.arrayContaining([9]),
      "#h": ["b"],
      since: expect.any(Number),
      limit: 500,
    },
  ]);
  const before = h.first.sent.length;
  h.owner.update(["b", "a", "a"]);
  expect(h.first.sent).toHaveLength(before);
  const request = h.first.requests()[2];
  assert.exists(request);
  const event = message(keypair(), "a", "incoming", 1700000000);
  await h.first.receive(["EVENT", request[1], event]);
  await h.first.receive(["EOSE", request[1]]);
  expect(h.callbacks.receive).toHaveBeenCalledWith([event], {
    phase: "replay",
    channelId: "a",
  });
  await h.first.receive(["EVENT", request[1], event]);
  expect(h.callbacks.receive).toHaveBeenLastCalledWith([event], {
    phase: "live",
    channelId: "a",
  });
  expect(h.callbacks.established).toHaveBeenCalledWith("a");
  expect(
    h.callbacks.state.mock.lastCall?.[0].routes.find(
      (r) => r.channelId === "a",
    ),
  ).toMatchObject({ status: "live", replay: "unknown" });
  h.owner.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
it("isolates denial, fences removed/readded routes and late sockets, and disposes retries", async () => {
  vi.useFakeTimers();
  const h = setup();
  await h.first.auth();
  await vi.advanceTimersByTimeAsync(750);
  const a = h.first.requests()[2],
    b = h.first.requests()[3];
  assert.exists(a);
  assert.exists(b);
  await h.first.receive(["CLOSED", a[1], "restricted: not a channel member"]);
  expect(h.callbacks.denied).toHaveBeenCalledWith(
    "a",
    "restricted: not a channel member",
  );
  expect(h.first.readyState).toBe(1);
  await h.first.receive(["EOSE", b[1]]);
  h.owner.update(["b"]);
  h.owner.update(["a", "b"]);
  await vi.advanceTimersByTimeAsync(250);
  const fresh = h.first.requests().at(-1);
  assert.exists(fresh);
  expect(fresh[1]).not.toBe(a[1]);
  await h.first.receive(["EVENT", a[1], message(h.key, "a", "stale", 1)]);
  await h.first.receive(["CLOSED", a[1], "restricted: not a channel member"]);
  expect(h.callbacks.receive).not.toHaveBeenCalled();
  expect(h.callbacks.denied).toHaveBeenCalledTimes(1);
  h.first.close();
  await vi.advanceTimersByTimeAsync(500);
  expect(h.sockets).toHaveLength(2);
  await h.first.receive(["EVENT", b[1], message(h.key, "b", "old socket", 2)]);
  expect(h.callbacks.receive).not.toHaveBeenCalled();
  h.owner.dispose();
  await vi.advanceTimersByTimeAsync(60000);
  expect(h.sockets).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});
it("times out individual setup, releases queue slots and never calls capped replay complete", async () => {
  vi.useFakeTimers();
  const h = setup(["a", "b", "c", "d"]);
  await h.first.auth();
  await vi.advanceTimersByTimeAsync(750);
  expect(h.first.requests()).toHaveLength(4);
  const a = h.first.requests()[2];
  assert.exists(a);
  const event = message(h.key, "a", "echo", 1);
  for (let i = 0; i < 500; i++) await h.first.receive(["EVENT", a[1], event]);
  await h.first.receive(["EOSE", a[1]]);
  await vi.advanceTimersByTimeAsync(250);
  expect(h.first.requests()).toHaveLength(5);
  expect(
    h.callbacks.state.mock.lastCall?.[0].routes.find((r) => r.channelId === "a")
      ?.replay,
  ).toBe("limited");
  await vi.advanceTimersByTimeAsync(10000);
  expect(h.first.requests()).toHaveLength(6);
  expect(
    h.callbacks.state.mock.lastCall?.[0].routes.find((r) => r.channelId === "b")
      ?.status,
  ).toBe("error");
  expect(h.callbacks.denied).not.toHaveBeenCalled();
  h.owner.dispose();
});
it("bounds interests and exposes every omitted ID without exceeding 1024 subscriptions", async () => {
  vi.useFakeTimers();
  const ids = Array.from(
    { length: 1024 },
    (_, i) => `channel-${i.toString().padStart(4, "0")}`,
  );
  const h = setup(ids);
  await h.first.auth();
  await vi.advanceTimersByTimeAsync(750);
  let index = 0;
  while (index < 1024) {
    if (index >= h.first.requests().length)
      await vi.advanceTimersByTimeAsync(250);
    const request = h.first.requests()[index++];
    assert.exists(request);
    await h.first.receive(["EOSE", request[1]]);
  }
  expect(h.first.requests()).toHaveLength(1024);
  expect(
    h.callbacks.state.mock.lastCall?.[0].routes
      .filter((r) => r.status === "limited")
      .map((r) => r.channelId),
  ).toEqual(ids.slice(1022));
  expect(() => liveChannels([...ids, "excess"])).toThrow();
  for (const invalid of [[""], ["a b"], ["x".repeat(129)], [9], {}])
    expect(() => liveChannels(invalid)).toThrow();
  h.owner.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
it("surfaces invalid signatures and terminal auth failure without an automatic policy loop", async () => {
  vi.useFakeTimers();
  const h = setup();
  await h.first.auth();
  await vi.advanceTimersByTimeAsync(750);
  const request = h.first.requests()[2];
  assert.exists(request);
  const event = message(h.key, "a", "valid", 1);
  await h.first.receive([
    "EVENT",
    request[1],
    { ...event, content: "tampered" },
  ]);
  expect(h.callbacks.receive).not.toHaveBeenCalled();
  expect(
    h.callbacks.state.mock.lastCall?.[0].routes.find((r) => r.channelId === "a")
      ?.status,
  ).toBe("error");
  h.owner.dispose();
  const key = keypair(),
    socket = new Socket(),
    state = vi.fn();
  const owner = subscribeRelayTraffic(
    "wss://relay.test",
    async (event) => signed(key, event),
    keypair().pubkey,
    { state, receive: vi.fn(), established: vi.fn(), denied: vi.fn() },
    () => socket as unknown as WebSocket,
  );
  await socket.receive(["AUTH", "challenge"]);
  expect(state.mock.lastCall?.[0]).toMatchObject({
    status: "error",
    error: "Live signer does not match viewer",
  });
  expect(socket.sent).toEqual([]);
  await vi.advanceTimersByTimeAsync(60000);
  expect(vi.getTimerCount()).toBe(0);
  owner.dispose();
});

it("paces fast EOSEs; quota CLOSED pauses the whole queue and only retries refused routes", async () => {
  vi.useFakeTimers();
  const h = setup(Array.from({ length: 80 }, (_, i) => `channel-${i}`));
  await h.first.auth();
  // Fast completions cannot refill setup slots into an unbounded same-tick burst.
  for (let i = 0; i < 20; i++) {
    expect(h.first.requests()).toHaveLength(i + 1);
    const request = h.first.requests()[i];
    assert.exists(request);
    await h.first.receive(["EOSE", request[1]]);
    expect(h.first.requests()).toHaveLength(i + 1);
    await vi.advanceTimersByTimeAsync(250);
  }
  const refused = h.first.requests()[20];
  assert.exists(refused);
  const before = h.first.requests().length;
  await h.first.receive([
    "CLOSED",
    refused[1],
    "rate-limited: quota exceeded; retry in 2s",
  ]);
  await vi.advanceTimersByTimeAsync(2999);
  expect(h.first.requests()).toHaveLength(before);
  // Explicit retry keeps established routes and cannot bypass the shared cooldown.
  h.owner.retry();
  expect(h.sockets).toHaveLength(1);
  expect(h.first.requests()).toHaveLength(before);
  await vi.advanceTimersByTimeAsync(1);
  const retry = h.first.requests().at(-1);
  assert.exists(retry);
  expect(retry[2]).toEqual(refused[2]);
  expect(retry[1]).not.toBe(refused[1]);
  await h.first.receive(["EOSE", refused[1]]);
  expect(
    h.callbacks.state.mock.lastCall?.[0].routes.filter(
      (r) => r.status === "live",
    ),
  ).toHaveLength(20);
  await h.first.receive(["EOSE", retry[1]]);
  expect(
    h.callbacks.state.mock.lastCall?.[0].routes.filter(
      (r) => r.status === "live",
    ),
  ).toHaveLength(21);
  expect(h.callbacks.denied).not.toHaveBeenCalled();
  h.owner.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
it("preserves host cooldown across subscription replacement and stops bounded quota retries", async () => {
  vi.useFakeTimers();
  const key = keypair();
  const admission = createLiveAdmission();
  const callbacks = {
    receive: vi.fn(),
    state: vi.fn<LiveCallbacks["state"]>(),
    established: vi.fn(),
    denied: vi.fn(),
  };
  const open = () => {
    const socket = new Socket();
    const owner = subscribeRelayTraffic(
      "wss://relay.test",
      async (e) => signed(key, e),
      key.pubkey,
      callbacks,
      () => socket as unknown as WebSocket,
      admission,
    );
    owner.update(["a", "b"]);
    return { socket, owner };
  };
  const first = open();
  await first.socket.auth();
  const request = first.socket.requests()[0];
  assert.exists(request);
  await first.socket.receive([
    "CLOSED",
    request[1],
    "rate-limited: quota exceeded; retry in 2s",
  ]);
  first.owner.dispose();
  const second = open();
  await second.socket.auth();
  expect(second.socket.requests()).toHaveLength(0);
  second.owner.retry();
  await vi.advanceTimersByTimeAsync(2999);
  expect(second.socket.requests()).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  for (let i = 0; i < 4; i++) {
    const pending = second.socket.requests().at(-1);
    assert.exists(pending);
    await second.socket.receive([
      "CLOSED",
      pending[1],
      "rate-limited: quota exceeded; retry in 2s",
    ]);
    await vi.advanceTimersByTimeAsync(3000);
  }
  const count = second.socket.requests().length;
  await vi.advanceTimersByTimeAsync(60000);
  expect(second.socket.requests()).toHaveLength(count);
  expect(
    callbacks.state.mock.lastCall?.[0].routes.every(
      (r) => r.status === "error",
    ),
  ).toBe(true);
  expect(callbacks.denied).not.toHaveBeenCalled();
  second.owner.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["61", "9007199254740992"])(
  "an unsupported %s-second hint stops the unsent queue instead of draining it",
  async (seconds) => {
    vi.useFakeTimers();
    const h = setup();
    await h.first.auth();
    const request = h.first.requests()[0];
    assert.exists(request);
    await h.first.receive([
      "CLOSED",
      request[1],
      `rate-limited: quota exceeded; retry in ${seconds}s`,
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.first.requests()).toHaveLength(1);
    expect(
      h.callbacks.state.mock.lastCall?.[0].routes.every(
        (r) => r.status === "error",
      ),
    ).toBe(true);
    h.owner.retry();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.first.requests()).toHaveLength(1);
    h.owner.dispose();
    expect(vi.getTimerCount()).toBe(0);
  },
);
it("disposal from a live state notification fences the following established callback", async () => {
  vi.useFakeTimers();
  const h = setup();
  await h.first.auth();
  const request = h.first.requests()[0];
  assert.exists(request);
  h.callbacks.state.mockImplementation((snapshot) => {
    if (snapshot.routes.some((r) => r.status === "live")) h.owner.dispose();
  });
  await h.first.receive(["EOSE", request[1]]);
  expect(h.callbacks.established).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

// Reentrant remove/re-add control contributed by Brain.
it("EOSE from a removed incarnation cannot establish its replacement", async () => {
  vi.useFakeTimers();
  const h = setup();
  try {
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(500);
    const old = h.first.requests()[2];
    assert.exists(old);
    let replaced = false;
    h.callbacks.state.mockImplementation((snapshot) => {
      if (
        !replaced &&
        snapshot.routes.find((r) => r.channelId === "a")?.status === "live"
      ) {
        replaced = true;
        h.owner.update(["b"]);
        h.owner.update(["a", "b"]);
      }
    });
    await h.first.receive(["EOSE", old[1]]);
    expect(replaced).toBe(true);
    expect(h.callbacks.established).not.toHaveBeenCalledWith("a");
    await vi.advanceTimersByTimeAsync(500);
    const fresh = h.first
      .requests()
      .find((r) => r[2]["#h"]?.[0] === "a" && r[1] !== old[1]);
    assert.exists(fresh);
    await h.first.receive(["EOSE", fresh[1]]);
    expect(h.callbacks.established).toHaveBeenCalledWith("a");
  } finally {
    h.owner.dispose();
  }
});

it("prioritizes a demanded tail channel after globals, without bypassing cooldown or adding interests", async () => {
  vi.useFakeTimers();
  const ids = Array.from(
    { length: 128 },
    (_, i) => `channel-${String(i).padStart(3, "0")}`,
  );
  const h = setup(ids);
  try {
    h.owner.prioritize?.([ids[127] as string, "unowned"]);
    await h.first.auth();
    const first = h.first.requests()[0];
    assert.exists(first);
    await h.first.receive([
      "CLOSED",
      first[1],
      "rate-limited: quota exceeded; retry in 0s",
    ]);
    h.owner.prioritize?.([ids[126] as string]);
    await vi.advanceTimersByTimeAsync(999);
    expect(h.first.requests()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(751);
    expect(h.first.requests()[3]?.[2]["#h"]).toEqual([ids[126]]);
    expect(h.first.requests().some((r) => r[2]["#h"]?.[0] === "unowned")).toBe(
      false,
    );
    expect(h.sockets).toHaveLength(1);
  } finally {
    h.owner.dispose();
  }
});

it("retains quota recovery evidence through automatic and manual retries until fresh EOSE", async () => {
  vi.useFakeTimers();
  const h = setup();
  try {
    await h.first.auth();
    const first = h.first.requests()[0];
    assert.exists(first);
    const error = "rate-limited: quota exceeded; retry in 0s";
    const profiles = () =>
      h.callbacks.state.mock.lastCall?.[0].routes.find(
        (r) => r.id === "profiles",
      );
    await h.first.receive(["CLOSED", first[1], error]);
    expect(profiles()).toMatchObject({ status: "pending", error });
    await vi.advanceTimersByTimeAsync(1000);
    const retry = h.first.requests().at(-1);
    assert.exists(retry);
    // Force an unrelated notification after retry dispatch: old error must not
    // disappear just because the new REQ was sent, or because stale EOSE arrives.
    h.owner.prioritize?.(["a"]);
    await h.first.receive(["EOSE", first[1]]);
    expect(profiles()).toMatchObject({ status: "pending", error });
    await h.first.receive(["EOSE", retry[1]]);
    expect(profiles()).toMatchObject({ status: "live" });
    expect(profiles()).not.toHaveProperty("error");
    // Exhaust the same route's remaining automatic attempts.
    for (let i = 0; i < 3; i++) {
      const latest = h.first
        .requests()
        .filter((r) => r[2].kinds?.includes(0))
        .at(-1);
      assert.exists(latest);
      await h.first.receive(["CLOSED", latest[1], error]);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(profiles()).toMatchObject({ status: "error", error });
    h.owner.retry();
    h.owner.prioritize?.(["b"]);
    expect(profiles()).toMatchObject({ status: "pending", error });
    const manual = h.first
      .requests()
      .filter((r) => r[2].kinds?.includes(0))
      .at(-1);
    assert.exists(manual);
    await h.first.receive(["EOSE", manual[1]]);
    expect(profiles()).toMatchObject({ status: "live" });
    expect(profiles()).not.toHaveProperty("error");
  } finally {
    h.owner.dispose();
  }
});

it("replaces unconfirmed quota recovery with a timeout and retains nonquota manual failures", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    await h.first.auth();
    const first = h.first.requests()[0];
    assert.exists(first);
    await h.first.receive([
      "CLOSED",
      first[1],
      "rate-limited: quota exceeded; retry in 0s",
    ]);
    await vi.advanceTimersByTimeAsync(11000);
    const profiles = () =>
      h.callbacks.state.mock.lastCall?.[0].routes.find(
        (route) => route.id === "profiles",
      );
    const error = "Live subscription setup timed out; retry available";
    expect(profiles()).toMatchObject({ status: "error", error });
    h.owner.retry();
    expect(profiles()).toMatchObject({ status: "pending", error });
    const manual = h.first
      .requests()
      .filter((r) => r[2].kinds.includes(0))
      .at(-1);
    assert.exists(manual);
    await h.first.receive(["EOSE", manual[1]]);
    expect(profiles()).toMatchObject({ status: "live" });
    expect(profiles()).not.toHaveProperty("error");
  } finally {
    h.owner.dispose();
  }
});

it("requests community emoji on the existing profile route and delivers verified updates", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  await h.first.auth();
  const req = h.first.sent.find((entry) => entry[0] === "REQ");
  expect(req?.slice(2)).toEqual([
    { kinds: [0], since: expect.any(Number), limit: 500 },
    {
      kinds: [30030],
      "#d": ["buzz:custom-emoji"],
      since: expect.any(Number),
      limit: 500,
    },
  ]);
  const event = signed(h.key, {
    kind: 30030,
    content: "",
    tags: [
      ["d", "buzz:custom-emoji"],
      ["emoji", "party", "https://x.test/p"],
    ],
  });
  await h.first.receive(["EVENT", req?.[1], event]);
  expect(h.callbacks.receive).toHaveBeenCalledWith([event], {
    phase: "replay",
  });
  h.owner.dispose();
});

it("a reconnect starts a new replay phase even for previously established routes", async () => {
  vi.useFakeTimers();
  const h = setup(["a"]);
  await h.first.auth();
  await vi.advanceTimersByTimeAsync(750);
  const request = h.first.requests()[2];
  assert.exists(request);
  await h.first.receive(["EOSE", request[1]]);
  const event = message(keypair(), "a", "live", 1700000000);
  await h.first.receive(["EVENT", request[1], event]);
  expect(h.callbacks.receive).toHaveBeenLastCalledWith([event], {
    phase: "live",
    channelId: "a",
  });
  h.first.close();
  await vi.advanceTimersByTimeAsync(500);
  const socket = h.sockets[1];
  assert.exists(socket);
  await socket.auth();
  await vi.advanceTimersByTimeAsync(750);
  const replay = socket.requests()[2];
  assert.exists(replay);
  await socket.receive(["EVENT", replay[1], event]);
  expect(h.callbacks.receive).toHaveBeenLastCalledWith([event], {
    phase: "replay",
    channelId: "a",
  });
  h.owner.dispose();
});

it("live channel provenance excludes observer telemetry while preserving membership traffic", async () => {
  vi.useFakeTimers();
  const h = setup(["a"]);
  try {
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(750);
    const route = h.first.requests()[2];
    assert.exists(route);
    await h.first.receive(["EOSE", route[1]]);
    const telemetry = signed(h.key, {
      kind: 24200,
      content: "opaque",
      tags: [],
    });
    await h.first.receive(["EVENT", route[1], telemetry]);
    expect(h.callbacks.receive).not.toHaveBeenCalled();
    const membership = signed(h.key, {
      kind: 40099,
      content: "{}",
      tags: [["h", "a"]],
    });
    await h.first.receive(["EVENT", route[1], membership]);
    expect(h.callbacks.receive).toHaveBeenCalledExactlyOnceWith([membership], {
      phase: "live",
      channelId: "a",
    });
  } finally {
    h.owner.dispose();
  }
});

it("observer route is optional, live-only at dispatch/retry, separately fenced and never ordinary replay", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1800000000000);
  const h = setup([]);
  const telemetry = vi.fn();
  Object.assign(h.callbacks, { telemetry });
  await h.first.auth();
  await vi.advanceTimersByTimeAsync(500);
  const globals = h.first.requests().map((request) => request[1]);
  h.owner.observe?.(1);
  await vi.advanceTimersByTimeAsync(250);
  const first = h.first.requests().at(-1);
  assert.exists(first);
  expect(first[2]).toEqual({
    kinds: [24200],
    "#p": [h.key.pubkey],
    since: Math.floor(Date.now() / 1000),
  });
  const event = signed(h.key, {
    kind: 24200,
    content: "opaque",
    tags: [],
    created_at: Math.floor(Date.now() / 1000),
  });
  await h.first.receive(["EVENT", first[1], event]);
  expect(telemetry).toHaveBeenCalledWith(event, 1);
  expect(h.callbacks.receive).not.toHaveBeenCalled();
  await h.first.receive(["EOSE", first[1]]);
  expect(h.callbacks.established).not.toHaveBeenCalled();
  await h.first.receive(["CLOSED", first[1], "temporary: unavailable"]);
  await vi.advanceTimersByTimeAsync(3000);
  h.owner.retry();
  const retried = h.first.requests().at(-1);
  assert.exists(retried);
  expect(retried[2].since).toBeGreaterThan(first[2].since);
  h.owner.observe?.(2);
  await vi.advanceTimersByTimeAsync(250);
  await h.first.receive(["EVENT", first[1], event]);
  await h.first.receive(["EVENT", retried[1], event]);
  expect(telemetry).toHaveBeenCalledTimes(1);
  h.owner.observe?.(null);
  expect(
    h.first.sent
      .filter((entry) => entry[0] === "CLOSE")
      .some((entry) => globals.includes(entry[1] as string)),
  ).toBe(false);
  expect(h.sockets).toHaveLength(1);
  h.owner.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
