import { afterEach, assert, expect, it, vi } from "vitest";
import type { EventTemplate, VerifiedEvent } from "nostr-tools";
import {
  createLiveAdmission,
  LIVE_CHANNEL_CAPACITY,
  subscribeRelayTraffic,
  type LiveCallbacks,
} from "./live";
import { connectSignedTransport } from "./transport";
import { presenceAuthors } from "./presence-contract";
import { PresenceOwnerDisposed } from "./presence-live";
import { keypair, signed } from "./testing";

class Socket {
  readyState = 1;
  sent: unknown[][] = [];
  times: number[] = [];
  onmessage?: (event: { data: string }) => Promise<void>;
  onclose?: () => void;
  send(text: string) {
    this.sent.push(JSON.parse(text));
    this.times.push(performance.now());
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  async receive(frame: unknown[]) {
    await this.onmessage?.({ data: JSON.stringify(frame) });
  }
  requests(presence = false) {
    return this.sent.filter(
      (f) =>
        f[0] === "REQ" &&
        ((f[2] as { kinds: number[] }).kinds[0] === 20001) === presence,
    ) as [
      string,
      string,
      { kinds: number[]; authors?: string[]; limit: number; "#h"?: string[] },
    ][];
  }
  events() {
    return this.sent
      .filter((f) => f[0] === "EVENT")
      .map((f) => f[1] as VerifiedEvent);
  }
  async auth() {
    await this.receive(["AUTH", "test"]);
    const event = this.sent.find((f) => f[0] === "AUTH")?.[1] as VerifiedEvent;
    await this.receive(["OK", event.id, true]);
  }
  async globals() {
    await this.auth();
    for (let i = 0; i < 2; i++) {
      const request = this.requests()[i];
      assert.exists(request);
      await this.receive(["EOSE", request[1]]);
      await vi.advanceTimersByTimeAsync(250);
    }
  }
}
const author = (n: number) => n.toString(16).padStart(64, "0");
const signal = () => new AbortController().signal;
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function setup(
  signOverride?: (event: EventTemplate) => Promise<VerifiedEvent>,
  admission = createLiveAdmission(),
) {
  vi.useFakeTimers();
  const key = keypair();
  const sockets: Socket[] = [];
  const callbacks = {
    receive: vi.fn(),
    established: vi.fn(),
    denied: vi.fn(),
    state: vi.fn(),
    presence: vi.fn(),
    presenceState: vi.fn(),
  } satisfies LiveCallbacks;
  const sign = vi.fn(
    signOverride ?? (async (event: EventTemplate) => signed(key, event)),
  );
  const owner = subscribeRelayTraffic(
    "wss://test.invalid",
    sign,
    key.pubkey,
    callbacks,
    () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    admission,
  );
  const socket = sockets[0];
  assert.exists(socket);
  const presence = owner.presence;
  assert.exists(presence);
  return { key, sockets, socket, owner, presence, callbacks, sign, admission };
}

it("zero demand opens no presence route; production update is bounded, explicit and separate from ordinary establishment/receive", async () => {
  const h = setup();
  try {
    await h.socket.globals();
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.socket.requests(true)).toHaveLength(0);
    expect(h.sign).toHaveBeenCalledTimes(1); // AUTH, no implicit heartbeat.
    const person = keypair();
    for (let i = 0; i < 1000; i++) h.presence.update([person.pubkey]);
    await vi.advanceTimersByTimeAsync(100);
    const route = h.socket.requests(true)[0];
    assert.exists(route);
    expect(route[2]).toEqual({
      kinds: [20001],
      authors: [person.pubkey],
      limit: 0,
    });
    const event = signed(person, { kind: 20001, content: "online", tags: [] });
    await h.socket.receive(["EVENT", route[1], event]);
    await h.socket.receive(["EOSE", route[1]]);
    expect(h.callbacks.presence).toHaveBeenCalledWith([event]);
    expect(h.callbacks.presenceState).toHaveBeenLastCalledWith({
      status: "ready",
      authors: [person.pubkey],
    });
    expect(h.callbacks.established).toHaveBeenCalledTimes(2);
    expect(h.callbacks.receive).not.toHaveBeenCalled();
    // Misrouted ephemeral events can never enter generic acceptance either.
    await h.socket.receive(["EVENT", h.socket.requests()[0]?.[1], event]);
    expect(h.callbacks.receive).not.toHaveBeenCalled();
    h.presence.update([]);
    await h.socket.receive(["EVENT", route[1], event]);
    expect(h.callbacks.presence).toHaveBeenCalledTimes(1);
    expect(h.callbacks.presenceState).toHaveBeenLastCalledWith({
      status: "idle",
      authors: [],
    });
    for (const value of [
      [""],
      ["a"],
      [author(1).toUpperCase().replace("1", "A")],
      Array(257).fill(author(1)),
      {},
    ])
      expect(() => presenceAuthors(value)).toThrow();
  } finally {
    h.owner.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("continuous scrolling makes progress at <=1 start/sec, retains only confirmed+candidate and fences obsolete EOSE", async () => {
  const h = setup();
  try {
    await h.socket.globals();
    h.presence.update([author(1)]);
    await vi.advanceTimersByTimeAsync(100);
    const first = h.socket.requests(true)[0];
    assert.exists(first);
    await h.socket.receive(["EOSE", first[1]]);
    for (let i = 2; i <= 50; i++) {
      h.presence.update([author(i)]);
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(h.socket.requests(true)).toHaveLength(2); // One candidate, not 49 cancellations.
    const candidate = h.socket.requests(true)[1];
    assert.exists(candidate);
    expect(h.socket.sent).not.toContainEqual(["CLOSE", first[1]]);
    await h.socket.receive(["EOSE", candidate[1]]);
    expect(h.socket.sent).toContainEqual(["CLOSE", candidate[1]]);
    expect(h.socket.sent).not.toContainEqual(["CLOSE", first[1]]);
    await vi.advanceTimersByTimeAsync(100);
    const latest = h.socket.requests(true)[2];
    assert.exists(latest);
    expect(latest[2].authors).toEqual([author(50)]);
    await h.socket.receive(["EOSE", latest[1]]);
    expect(h.socket.sent).toContainEqual(["CLOSE", first[1]]);
    const count = h.callbacks.presenceState.mock.calls.length;
    await h.socket.receive(["EOSE", candidate[1]]);
    expect(h.callbacks.presenceState).toHaveBeenCalledTimes(count);
    let active = 0,
      max = 0;
    for (const frame of h.socket.sent) {
      if (frame[0] === "REQ" && String(frame[1]).startsWith("presence-"))
        max = Math.max(max, ++active);
      if (frame[0] === "CLOSE" && String(frame[1]).startsWith("presence-"))
        active--;
    }
    const starts = h.socket.sent.flatMap((frame, i) =>
      frame[0] === "REQ" && String(frame[1]).startsWith("presence-")
        ? [h.socket.times[i] as number]
        : [],
    );
    for (let i = 1; i < starts.length; i++)
      expect(
        (starts[i] as number) - (starts[i - 1] as number),
      ).toBeGreaterThanOrEqual(1000);
    expect(max).toBe(2);
    expect(active).toBe(1);
  } finally {
    h.owner.dispose();
  }
});

it("failed candidates preserve confirmed routes and retries stay capped even as desired authors change", async () => {
  const h = setup();
  try {
    await h.socket.globals();
    h.presence.update([author(1)]);
    await vi.advanceTimersByTimeAsync(100);
    const first = h.socket.requests(true)[0];
    assert.exists(first);
    await h.socket.receive(["EOSE", first[1]]);
    h.presence.update([author(2)]);
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(8000);
      const route = h.socket.requests(true).at(-1);
      assert.exists(route);
      expect(route[1]).not.toBe(first[1]);
      await h.socket.receive([
        "CLOSED",
        route[1],
        "temporary: presence unavailable",
      ]);
      h.presence.update([author(i + 3)]);
    }
    const count = h.socket.requests(true).length;
    await vi.advanceTimersByTimeAsync(120000);
    expect(h.socket.requests(true)).toHaveLength(count);
    expect(count).toBe(5);
    expect(h.socket.sent).not.toContainEqual(["CLOSE", first[1]]);
    h.owner.retry();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.socket.requests(true)).toHaveLength(count + 1);
  } finally {
    h.owner.dispose();
  }
});

it("channel opening wins over presence and all routes fit the reserved 1024 slots", async () => {
  const h = setup();
  try {
    const ids = Array.from({ length: 1024 }, (_, i) => `c-${i}`);
    h.owner.update(ids);
    h.owner.prioritize?.(["c-999"]);
    h.presence.update([author(1)]);
    await h.socket.auth();
    for (let i = 0; i < 3; i++) {
      const request = h.socket.requests()[i];
      assert.exists(request);
      await h.socket.receive(["EOSE", request[1]]);
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(h.socket.requests()[2]?.[2]["#h"]).toEqual(["c-999"]);
    const p = h.socket.requests(true)[0];
    assert.exists(p);
    await h.socket.receive(["EOSE", p[1]]);
    let index = 3;
    while (index < LIVE_CHANNEL_CAPACITY + 2) {
      if (index >= h.socket.requests().length)
        await vi.advanceTimersByTimeAsync(250);
      const request = h.socket.requests()[index++];
      assert.exists(request);
      await h.socket.receive(["EOSE", request[1]]);
    }
    h.presence.update([author(2)]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.socket.requests().length + h.socket.requests(true).length).toBe(
      1024,
    );
    expect(
      h.callbacks.state.mock.lastCall?.[0].routes.filter(
        (r: { status: string }) => r.status === "limited",
      ),
    ).toHaveLength(4);
  } finally {
    h.owner.dispose();
  }
});

it("publication signs only after authenticated foreground admission; matching OK alone resolves and no echo/read is needed", async () => {
  const h = setup();
  try {
    await expect(h.presence.publish("online", signal())).rejects.toThrow(
      "authenticated",
    );
    await h.socket.auth();
    const operation = h.presence.publish("away", signal());
    const done = vi.fn();
    void operation.then(done);
    await vi.advanceTimersByTimeAsync(250);
    expect(h.sign).toHaveBeenCalledTimes(1); // globals await EOSE
    for (const route of h.socket.requests())
      await h.socket.receive(["EOSE", route[1]]);
    await vi.advanceTimersByTimeAsync(250);
    const event = h.socket.events()[0];
    assert.exists(event);
    expect(event).toMatchObject({
      kind: 20001,
      content: "away",
      tags: [],
      pubkey: h.key.pubkey,
    });
    await h.socket.receive(["OK", "wrong", true]);
    expect(done).not.toHaveBeenCalled();
    await expect(h.presence.publish("online", signal())).rejects.toThrow(
      "in flight",
    );
    await h.socket.receive(["OK", event.id, true]);
    await operation;
    expect(done).toHaveBeenCalledOnce();
    expect(h.socket.events()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(180000);
    expect(h.socket.events()).toHaveLength(1);
  } finally {
    h.owner.dispose();
  }
});

it("publication rejection shares cooldown with channel setup and cannot create automatic retries", async () => {
  const h = setup();
  try {
    await h.socket.globals();
    const promise = h.presence.publish("online", signal());
    const failure = expect(promise).rejects.toThrow("rate-limited");
    await vi.advanceTimersByTimeAsync(0);
    const event = h.socket.events()[0];
    assert.exists(event);
    await h.socket.receive([
      "OK",
      event.id,
      false,
      "rate-limited: quota exceeded; retry in 2s",
    ]);
    await failure;
    h.owner.update(["a"]);
    await vi.advanceTimersByTimeAsync(2999);
    expect(h.socket.requests()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.socket.requests()).toHaveLength(3);
    expect(h.socket.events()).toHaveLength(1);
  } finally {
    h.owner.dispose();
  }
});

it.each(["abort", "disconnect", "dispose", "timeout"])(
  "%s fences a pending signer and leaves no heartbeat replay",
  async (finish) => {
    let release!: (value: VerifiedEvent) => void;
    const key = keypair();
    let template!: EventTemplate;
    // Match the viewer returned by setup by replacing only the publication signing phase.
    const h = setup();
    h.sign.mockImplementation(async (event) => {
      if (event.kind !== 20001) return signed(h.key, event);
      template = event;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    try {
      await h.socket.globals();
      const controller = new AbortController();
      const promise = h.presence.publish("online", controller.signal);
      const outcome = promise.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      if (finish === "abort") controller.abort();
      if (finish === "disconnect") h.socket.close();
      if (finish === "dispose") h.owner.dispose();
      if (finish === "timeout") await vi.advanceTimersByTimeAsync(10000);
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect(error instanceof PresenceOwnerDisposed).toBe(finish === "dispose");
      release(signed(key, template));
      await vi.advanceTimersByTimeAsync(0);
      expect(h.socket.events()).toHaveLength(0);
    } finally {
      h.owner.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each(["rejection", "deadline", "reset", "local", "abort"])(
  "%s winning settlement cannot become owner disposal later",
  async (first) => {
    const h = setup();
    try {
      await h.socket.globals();
      const local = new Error("Presence owner disposed");
      if (first === "local") h.sign.mockRejectedValueOnce(local);
      const controller = new AbortController();
      const outcome = h.presence
        .publish("online", controller.signal)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      if (first === "rejection") {
        const event = h.socket.events()[0];
        assert.exists(event);
        await h.socket.receive([
          "OK",
          event.id,
          false,
          "Presence owner disposed",
        ]);
      } else if (first === "deadline") await vi.advanceTimersByTimeAsync(10000);
      else if (first === "reset") h.socket.close();
      else if (first === "abort") controller.abort();
      h.owner.dispose();
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(PresenceOwnerDisposed);
      if (first === "local") expect(error).toBe(local);
    } finally {
      h.owner.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("a signing delay cannot bypass a newly learned shared cooldown", async () => {
  const h = setup();
  let release!: (value: VerifiedEvent) => void;
  let template!: EventTemplate;
  try {
    await h.socket.globals();
    h.sign.mockImplementation((event) => {
      template = event;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const promise = h.presence.publish("online", signal());
    h.admission.pause(1);
    release(signed(h.key, template));
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.socket.events()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    const event = h.socket.events()[0];
    assert.exists(event);
    await h.socket.receive(["OK", event.id, true]);
    await promise;
  } finally {
    h.owner.dispose();
  }
});

it("the signed transport exposes the actual same-socket presence capability, never HTTP publication", async () => {
  vi.useFakeTimers();
  const key = keypair();
  const sockets: Socket[] = [];
  vi.stubGlobal(
    "WebSocket",
    class extends Socket {
      constructor() {
        super();
        sockets.push(this);
      }
    },
  );
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const transport = await connectSignedTransport(
    {
      getPublicKey: async () => key.pubkey,
      signEvent: async (event) => signed(key, event),
    },
    "https://presence-fixture.invalid",
    key.pubkey,
  );
  const owner = transport.subscribe?.({
    receive() {},
    established() {},
    state() {},
    denied() {},
  });
  assert.exists(owner);
  try {
    const socket = sockets[0];
    assert.exists(socket);
    await socket.globals();
    const operation = owner.presence?.publish("online", signal());
    await vi.advanceTimersByTimeAsync(0);
    const event = socket.events()[0];
    assert.exists(event);
    await socket.receive(["OK", event.id, true]);
    await operation;
    expect(sockets).toHaveLength(1);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    owner.dispose();
  }
});

it("presence CLOSED honors shared cooldown and setup timeout advances only the latest candidate", async () => {
  const h = setup();
  try {
    await h.socket.globals();
    h.presence.update([author(1)]);
    await vi.advanceTimersByTimeAsync(100);
    const first = h.socket.requests(true)[0];
    assert.exists(first);
    await h.socket.receive([
      "CLOSED",
      first[1],
      "rate-limited: quota exceeded; retry in 2s",
    ]);
    h.owner.update(["a"]);
    h.owner.prioritize?.(["a"]);
    h.presence.update([author(2)]);
    await vi.advanceTimersByTimeAsync(2999);
    expect(h.socket.requests()).toHaveLength(2);
    expect(h.socket.requests(true)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const channel = h.socket.requests()[2];
    assert.exists(channel);
    await h.socket.receive(["EOSE", channel[1]]);
    await vi.advanceTimersByTimeAsync(250);
    const candidate = h.socket.requests(true)[1];
    assert.exists(candidate);
    expect(candidate[2].authors).toEqual([author(2)]);
    h.presence.update([author(3)]);
    await vi.advanceTimersByTimeAsync(12000);
    const replacement = h.socket.requests(true)[2];
    assert.exists(replacement);
    expect(replacement[2].authors).toEqual([author(3)]);
    expect(h.socket.sent).toContainEqual(["CLOSE", candidate[1]]);
    expect(h.callbacks.established).toHaveBeenCalledTimes(3);
  } finally {
    h.owner.dispose();
  }
});

it("lost WS OK is an unknown outcome, never an automatic resend or acceptance of late receipts", async () => {
  const h = setup();
  try {
    await h.socket.globals();
    const operation = h.presence.publish("online", signal());
    const failed = expect(operation).rejects.toThrow("unknown");
    await vi.advanceTimersByTimeAsync(0);
    const event = h.socket.events()[0];
    assert.exists(event);
    await vi.advanceTimersByTimeAsync(10000);
    await failed;
    await h.socket.receive(["OK", event.id, true]);
    await vi.advanceTimersByTimeAsync(120000);
    expect(h.socket.events()).toHaveLength(1);
    expect(h.callbacks.receive).not.toHaveBeenCalled();
  } finally {
    h.owner.dispose();
  }
});

it("a held presence candidate leaves four ordinary setups available with untouched 250ms pacing", async () => {
  const h = setup();
  try {
    await h.socket.globals();
    h.presence.update([author(1)]);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.socket.requests(true)).toHaveLength(1); // Keep EOSE held throughout.
    await vi.advanceTimersByTimeAsync(1);
    const started = performance.now();
    h.owner.update(["a", "b", "c", "d", "e"]);
    h.owner.prioritize?.(["a", "b", "c", "d", "e"]);
    await vi.advanceTimersByTimeAsync(750);
    const channels = h.socket.sent.flatMap((f, i) =>
      f[0] === "REQ" && (f[2] as { "#h"?: string[] })["#h"]
        ? [(h.socket.times[i] as number) - started]
        : [],
    );
    expect(channels).toEqual([0, 250, 500, 750]);
    await vi.advanceTimersByTimeAsync(250);
    expect(h.socket.requests()).toHaveLength(6); // 2 globals + 4 held channels.
    await h.socket.receive(["EOSE", h.socket.requests()[2]?.[1]]);
    expect(h.socket.requests()).toHaveLength(7);
  } finally {
    h.owner.dispose();
  }
});

it("presence publication does not charge or reset the ordinary dispatch clock", async () => {
  const h = setup();
  try {
    await h.socket.globals();
    h.owner.update(["a"]);
    await h.socket.receive(["EOSE", h.socket.requests()[2]?.[1]]);
    const started = performance.now();
    await vi.advanceTimersByTimeAsync(100);
    const p = h.presence.publish("online", signal());
    await vi.advanceTimersByTimeAsync(0);
    const event = h.socket.events()[0];
    assert.exists(event);
    h.owner.update(["a", "b"]);
    await vi.advanceTimersByTimeAsync(149);
    expect(h.socket.requests()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.socket.requests()).toHaveLength(4);
    expect((h.socket.times.at(-1) as number) - started).toBe(250);
    await h.socket.receive(["OK", event.id, true]);
    await p;
  } finally {
    h.owner.dispose();
  }
});

it("cancelled unabortable publication signing stays capped across shared streams without blocking ordinary AUTH/setup", async () => {
  const h = setup();
  const other = setup(undefined, h.admission);
  let release!: (value: VerifiedEvent) => void;
  let template!: EventTemplate;
  try {
    await h.socket.globals();
    h.sign.mockImplementation(async (event) => {
      template = event;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const c = new AbortController();
    const p = h.presence.publish("online", c.signal);
    const failed = expect(p).rejects.toThrow();
    c.abort();
    await failed;
    await other.socket.globals(); // The optional lease cannot serialize ordinary signing.
    for (let i = 0; i < 5; i++)
      await expect(other.presence.publish("online", signal())).rejects.toThrow(
        "capacity",
      );
    expect(h.sign).toHaveBeenCalledTimes(2); // AUTH + exactly one unresolved heartbeat.
    expect(other.sign).toHaveBeenCalledTimes(1);
    other.owner.update(["foreground"]);
    expect(other.socket.requests()).toHaveLength(3);
    release(signed(h.key, template));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.socket.events()).toHaveLength(0);
    await other.socket.receive(["EOSE", other.socket.requests()[2]?.[1]]);
    const retry = other.presence.publish("online", signal());
    await vi.advanceTimersByTimeAsync(0);
    const event = other.socket.events()[0];
    assert.exists(event);
    await other.socket.receive(["OK", event.id, true]);
    await retry;
  } finally {
    h.owner.dispose();
    other.owner.dispose();
  }
});

it.each([false, true])(
  "exhausted presence survives automatic reconnect, but one disconnected explicit Retry recovers (explicit %s)",
  async (explicit) => {
    const h = setup();
    try {
      await h.socket.globals();
      h.presence.update([author(1)]);
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(8000);
        const route = h.socket.requests(true).at(-1);
        assert.exists(route);
        await h.socket.receive(["CLOSED", route[1], "temporary: unavailable"]);
      }
      expect(h.socket.requests(true)).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(120000);
      expect(h.socket.requests(true)).toHaveLength(4);
      h.socket.close();
      if (explicit) h.owner.retry();
      else await vi.advanceTimersByTimeAsync(500);
      expect(h.sockets).toHaveLength(2);
      const replacement = h.sockets[1];
      assert.exists(replacement);
      await replacement.globals();
      await vi.advanceTimersByTimeAsync(100);
      if (explicit) {
        expect(replacement.requests(true)).toHaveLength(1);
        const route = replacement.requests(true)[0];
        assert.exists(route);
        await replacement.receive(["EOSE", route[1]]);
        expect(h.callbacks.presenceState).toHaveBeenLastCalledWith({
          status: "ready",
          authors: [author(1)],
        });
      } else {
        await vi.advanceTimersByTimeAsync(120000);
        expect(replacement.requests(true)).toHaveLength(0);
      }
    } finally {
      h.owner.dispose();
    }
  },
);
