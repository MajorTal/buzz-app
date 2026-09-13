// Regression controls contributed by Brain; see WS_RETRY_REVIEW_2026_09_09.
import { assert, afterEach, expect, it, vi } from "vitest";
import { connectBrokerTransport } from "./transport";
import { keypair, signed } from "./testing";
function required<T>(value: T | undefined): T {
  assert.exists(value);
  return value;
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}
const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function fixture() {
  const headers: ReturnType<typeof deferred<Response>>[] = [];
  const controls: ReturnType<typeof deferred<Response>>[] = [];
  const signals: AbortSignal[] = [];
  const snapshots: unknown[] = [];
  const bodyControllers: ReadableStreamDefaultController[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit = {}) => {
      if (url.endsWith("/session"))
        return Promise.resolve(
          Response.json({
            viewer: "a".repeat(64),
            relayAuthor: "b".repeat(64),
            live: true,
          }),
        );
      if (
        url.endsWith("/stream-retry") ||
        url.endsWith("/stream-presence") ||
        url.endsWith("/stream-observer")
      ) {
        const d = deferred<Response>();
        controls.push(d);
        signals.push(init.signal as AbortSignal);
        return d.promise;
      }
      if (url.endsWith("/stream")) {
        const d = deferred<Response>();
        headers.push(d);
        return d.promise;
      }
      throw Error(`unexpected fetch ${url}`);
    }),
  );
  function accept(index: number) {
    const body = new ReadableStream({
      start(c) {
        bodyControllers[index] = c;
      },
    });
    required(headers[index]).resolve(
      new Response(body, {
        headers: {
          "Content-Type": "text/event-stream",
          "X-Buzz-Live-ID": String(index + 1).padStart(32, "0"),
        },
      }),
    );
  }
  function publish(
    index: number,
    snapshot: unknown = { status: "connected", routes: [] },
  ) {
    required(bodyControllers[index]).enqueue(
      new TextEncoder().encode(
        `event: state\ndata: ${JSON.stringify(snapshot)}\n\n`,
      ),
    );
  }
  return {
    headers,
    controls,
    signals,
    snapshots,
    accept,
    publish,
    presence(index: number, state: unknown) {
      required(bodyControllers[index]).enqueue(
        new TextEncoder().encode(
          `event: presence-state\ndata: ${JSON.stringify(state)}\n\n`,
        ),
      );
    },
    frame(index: number, kind: string, data: unknown) {
      required(bodyControllers[index]).enqueue(
        new TextEncoder().encode(
          `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`,
        ),
      );
    },
    callbacks: {
      state(s: unknown) {
        snapshots.push(s);
      },
      receive() {},
      established() {},
      denied() {},
    },
  };
}
it("rejects status snapshots beyond channel interests plus both globals and observer", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const t = await connectBrokerTransport();
  const owner = required(t.subscribe)(f.callbacks);
  try {
    f.accept(0);
    await tick();
    f.publish(0, {
      status: "connected",
      routes: Array.from({ length: 1028 }, (_, i) => ({
        id: `route-${i}`,
        status: "pending",
        replay: "unknown",
      })),
    });
    await tick();
    expect(f.snapshots.at(-1)).toEqual({
      status: "retrying",
      routes: [],
      error: "Invalid live broker status",
    });
  } finally {
    owner.dispose();
  }
});

it("pre-header clicks preserve in-progress POST; duplicate controls coalesce", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const t = await connectBrokerTransport();
  const owner = required(t.subscribe)(f.callbacks);
  try {
    owner.retry();
    owner.retry();
    await tick();
    expect(f.headers).toHaveLength(1);
    expect(f.controls).toHaveLength(0);
    f.accept(0);
    await tick();
    f.publish(0);
    await tick();
    owner.retry();
    owner.retry();
    await tick();
    expect(f.controls).toHaveLength(1);
    expect(f.headers).toHaveLength(1);
    required(f.controls[0]).resolve(new Response(null, { status: 200 }));
    await tick();
    owner.retry();
    await tick();
    expect(f.controls).toHaveLength(2);
    expect(f.headers).toHaveLength(1);
    required(f.controls[1]).resolve(new Response(null, { status: 200 }));
    await tick();
  } finally {
    owner.dispose();
  }
});
for (const finish of ["replacement", "dispose"] as const)
  for (const outcome of ["status", "reject"] as const)
    it(`late retry ${outcome} cannot update ${finish}`, async () => {
      vi.useFakeTimers();
      const f = fixture();
      const t = await connectBrokerTransport();
      const owner = required(t.subscribe)(f.callbacks);
      try {
        f.accept(0);
        await tick();
        f.publish(0);
        await tick();
        owner.retry();
        await tick();
        expect(f.controls).toHaveLength(1);
        if (finish === "replacement") {
          owner.update(["a"]);
          f.accept(1);
          await tick();
          f.publish(1);
          await tick();
        } else owner.dispose();
        expect(required(f.signals[0]).aborted).toBe(true);
        const before = f.snapshots.length;
        // Deliberately uncooperative completion despite abort, proving callback fence.
        if (outcome === "status")
          required(f.controls[0]).resolve(new Response(null, { status: 500 }));
        else
          required(f.controls[0]).reject(
            new Error("deliberately late network rejection"),
          );
        await tick();
        expect(f.snapshots).toHaveLength(before);
        expect(f.headers).toHaveLength(finish === "replacement" ? 2 : 1);
      } finally {
        owner.dispose();
      }
    });

it("presence controls coalesce continuous demand with a fixed deadline and stale author state cannot replace current demand", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const states = vi.fn();
  const t = await connectBrokerTransport();
  const owner = required(t.subscribe)({
    ...f.callbacks,
    presenceState: states,
  });
  try {
    f.accept(0);
    await tick();
    for (let i = 1; i <= 10; i++) {
      owner.presence?.update([i.toString(16).padStart(64, "0")]);
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(f.controls).toHaveLength(1);
    const latest = "a".padStart(64, "0");
    f.presence(0, { status: "ready", authors: ["1".padStart(64, "0")] });
    await tick();
    expect(states.mock.lastCall?.[0]).toEqual({
      status: "pending",
      authors: [latest],
    });
    required(f.controls[0]).resolve(new Response(null, { status: 200 }));
    await tick();
    await vi.advanceTimersByTimeAsync(600);
    expect(f.controls).toHaveLength(2);
    f.presence(0, { status: "ready", authors: [latest] });
    await tick();
    expect(states.mock.lastCall?.[0]).toEqual({
      status: "ready",
      authors: [latest],
    });
    required(f.controls[1]).resolve(new Response(null, { status: 200 }));
    await tick();
  } finally {
    owner.dispose();
  }
});

it("stream replacement clears a queued presence timer without poisoning later controls; late failed controls are fenced", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const states = vi.fn();
  const t = await connectBrokerTransport();
  const owner = required(t.subscribe)({
    ...f.callbacks,
    presenceState: states,
  });
  try {
    f.accept(0);
    await tick();
    owner.presence?.update(["a".repeat(64)]);
    owner.update(["a"]); // replacement while the first control is still queued
    f.accept(1);
    await tick();
    owner.presence?.update(["b".repeat(64)]);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.controls).toHaveLength(1);
    owner.update(["b"]);
    f.accept(2);
    await tick();
    const before = states.mock.calls.length;
    required(f.controls[0]).resolve(new Response(null, { status: 503 }));
    await tick();
    expect(states).toHaveBeenCalledTimes(before);
    owner.presence?.update(["c".repeat(64)]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.controls).toHaveLength(2);
    required(f.controls[1]).resolve(new Response(null, { status: 200 }));
    await tick();
  } finally {
    owner.dispose();
  }
});

it("late observer 404 from a retired stream cannot interrupt its replacement", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const t = await connectBrokerTransport();
  const owner = required(t.subscribe)(f.callbacks);
  try {
    f.accept(0);
    await tick();
    f.publish(0);
    await tick();
    required(owner.observe)(1);
    await tick();
    expect(f.controls).toHaveLength(1);
    owner.update(["a"]);
    f.accept(1);
    await tick();
    f.publish(1);
    await tick();
    expect(required(f.signals[0]).aborted).toBe(true);
    const before = f.snapshots.length;
    required(f.controls[0]).resolve(new Response(null, { status: 404 }));
    await tick();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.snapshots).toHaveLength(before);
    expect(f.headers).toHaveLength(2);
    required(owner.observe)(2);
    await tick();
    expect(f.controls).toHaveLength(2);
    expect(required(f.signals[1]).aborted).toBe(false);
    required(f.controls[1]).resolve(new Response(null, { status: 200 }));
    await tick();
  } finally {
    owner.dispose();
  }
});

it("keeps simultaneous presence and observer startup controls and SSE deliveries isolated", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const callbacks = {
    ...f.callbacks,
    receive: vi.fn(),
    presence: vi.fn(),
    observer: vi.fn(),
  };
  const t = await connectBrokerTransport();
  const owner = required(t.subscribe)(callbacks);
  const key = keypair();
  try {
    const startup = vi
      .mocked(fetch)
      .mock.calls.find(([url]) => String(url).endsWith("/stream"));
    expect(JSON.parse(String(startup?.[1]?.body))).toMatchObject({
      authors: [],
      observer: null,
    });
    required(owner.presence).update([key.pubkey]);
    required(owner.observe)(1);
    f.accept(0);
    await tick();
    await vi.advanceTimersByTimeAsync(100);
    const controls = () =>
      vi
        .mocked(fetch)
        .mock.calls.filter(([url]) =>
          /\/stream-(presence|observer)$/.test(String(url)),
        );
    expect(
      controls().map(([url, init]) => [
        String(url).split("/").at(-1),
        JSON.parse(String(init?.body)),
      ]),
    ).toEqual([
      ["stream-observer", { streamId: "1".padStart(32, "0"), observer: 1 }],
      [
        "stream-presence",
        { streamId: "1".padStart(32, "0"), authors: [key.pubkey] },
      ],
    ]);
    expect(f.headers).toHaveLength(1);
    for (const control of f.controls)
      control.resolve(new Response(null, { status: 200 }));
    await tick();

    const event = signed(key, { kind: 20001, content: "online", tags: [] });
    const telemetry = signed(key, { kind: 24200, content: "opaque", tags: [] });
    const frame = {
      id: telemetry.id,
      agent: key.pubkey,
      createdAt: telemetry.created_at,
      plaintext: "{}",
    };
    f.frame(0, "message", event);
    f.frame(0, "message", telemetry);
    f.frame(0, "presence", event);
    f.frame(0, "observer", { frame, generation: 1 });
    await tick();
    expect(callbacks.receive).not.toHaveBeenCalled();
    expect(callbacks.presence).toHaveBeenCalledWith([event]);
    expect(callbacks.observer).toHaveBeenCalledWith(frame, 1);

    required(owner.observe)(2);
    required(owner.presence).update([]);
    f.frame(0, "presence", event);
    f.frame(0, "observer", { frame, generation: 1 });
    f.frame(0, "observer", { frame, generation: 2 });
    await tick();
    expect(callbacks.presence).toHaveBeenCalledTimes(1);
    expect(callbacks.observer).toHaveBeenCalledTimes(2);
    expect(callbacks.observer).toHaveBeenLastCalledWith(frame, 2);
    expect(f.headers).toHaveLength(1);
  } finally {
    owner.dispose();
  }
});
