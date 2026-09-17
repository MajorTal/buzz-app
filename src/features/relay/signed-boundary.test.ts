// Delayed signer regression controls contributed by Brain.

import { assert, afterEach, expect, it, vi } from "vitest";
import { connectSignedTransport } from "./transport";
import { ApiCapacity } from "./http-admission";
import { PublishRejected } from "./outbox";
import { signed, keypair } from "./testing";
function required<T>(value: T | undefined): T {
  assert.exists(value);
  return value;
}
const tick = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("actual signed fetch starts remain paced after delayed signer completions", async () => {
  vi.useFakeTimers();
  const key = keypair();
  const pending: Array<() => void> = [];
  const starts: number[] = [];
  const signer = {
    getPublicKey: async () => key.pubkey,
    signEvent: (t: Parameters<typeof signed>[1]) =>
      new Promise<ReturnType<typeof signed>>((resolve) => {
        pending.push(() => resolve(signed(key, t)));
      }),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      starts.push(performance.now());
      return Response.json([]);
    }),
  );
  const transport = await connectSignedTransport(
    signer,
    "https://deferred-sign.test",
    "relay",
  );
  const reads = Array.from({ length: 4 }, (_, i) =>
    transport.query([{ kinds: [0], limit: i + 1 }]),
  );
  await vi.advanceTimersByTimeAsync(1600);
  await vi.waitFor(() => expect(pending).toHaveLength(4));
  expect(starts).toHaveLength(0);
  // A host signer can finish several requests together after unlock/prompt/IPC delay.
  for (const resolve of pending) resolve();
  await tick();
  await vi.advanceTimersByTimeAsync(2000);
  await Promise.all(reads);
  expect(starts).toHaveLength(4);
  for (let i = 1; i < starts.length; i++)
    expect(
      required(starts[i]) - required(starts[i - 1]),
    ).toBeGreaterThanOrEqual(500);
});

it("positive control: immediate signer keeps signed fetches 500ms apart", async () => {
  vi.useFakeTimers();
  const key = keypair();
  const starts: number[] = [];
  const identity = {
    getPublicKey: async () => key.pubkey,
    signEvent: vi.fn(async (t: Parameters<typeof signed>[1]) => signed(key, t)),
  };
  vi.stubGlobal("fetch", async () => {
    starts.push(performance.now());
    return Response.json([]);
  });
  const t = await connectSignedTransport(
    identity,
    "https://fast-sign.test",
    "relay",
  );
  const p = Array.from({ length: 4 }, (_, i) =>
    t.query([{ kinds: [0], limit: i + 1 }]),
  );
  // Digest completion uses real crypto threads, not fake timers. Wait for all
  // preparations before advancing the dispatch clock, including under full-suite load.
  await vi.waitFor(() => expect(identity.signEvent).toHaveBeenCalledTimes(4));
  await vi.advanceTimersByTimeAsync(2000);
  await Promise.all(p);
  for (let i = 1; i < starts.length; i++)
    expect(
      required(starts[i]) - required(starts[i - 1]),
    ).toBeGreaterThanOrEqual(500);
});
it("a signer already waiting cannot bypass a newly learned shared cooldown", async () => {
  vi.useFakeTimers();
  const key = keypair();
  const pending: Array<() => void> = [];
  const starts: number[] = [];
  const identity = {
    getPublicKey: async () => key.pubkey,
    signEvent: (t: Parameters<typeof signed>[1]) =>
      new Promise<ReturnType<typeof signed>>((resolve) =>
        pending.push(() => resolve(signed(key, t))),
      ),
  };
  vi.stubGlobal("fetch", async () => {
    starts.push(performance.now());
    return starts.length === 1
      ? Response.json(
          { error: "rate-limited: quota exceeded; retry in 2s" },
          { status: 429 },
        )
      : Response.json([]);
  });
  const t = await connectSignedTransport(
    identity,
    "https://pause-during-sign.test",
    "relay",
  );
  const one = t.query([{ kinds: [0], limit: 1 }]).catch((e) => e);
  // Digest preparation runs on real crypto threads. Establish which request is
  // waiting first before releasing pending[0]; completion order is otherwise free.
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  const two = t.query([{ kinds: [0], limit: 2 }]).catch((e) => e);
  await vi.advanceTimersByTimeAsync(600);
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  required(pending[0])();
  await tick();
  await vi.advanceTimersByTimeAsync(1);
  await one;
  required(pending[1])();
  await tick();
  await vi.advanceTimersByTimeAsync(1);
  expect(starts).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(3500);
  await two;
});

function deferredSigner() {
  const key = keypair();
  const pending: Array<() => void> = [];
  return {
    key,
    pending,
    getPublicKey: async () => key.pubkey,
    signEvent: (template: Parameters<typeof signed>[1]) =>
      new Promise<ReturnType<typeof signed>>((resolve) => {
        pending.push(() => resolve(signed(key, template)));
      }),
  };
}

it.each(["signer", "dispatch"])(
  "cancelled during %s wait never fetches or blocks the next signed read",
  async (phase) => {
    vi.useFakeTimers();
    const identity = deferredSigner();
    const fetcher = vi.fn(async () => Response.json([]));
    vi.stubGlobal("fetch", fetcher);
    const t = await connectSignedTransport(
      identity,
      "https://cancel-sign.test",
      "relay",
    );
    const first = t.query([{ kinds: [0], limit: 1 }]);
    await vi.waitFor(() => expect(identity.pending).toHaveLength(1));
    required(identity.pending.shift())();
    await first;
    const controller = new AbortController();
    const cancelled = t.query([{ kinds: [0], limit: 2 }], controller.signal);
    const rejected = expect(cancelled).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.waitFor(() => expect(identity.pending).toHaveLength(1));
    if (phase === "dispatch") {
      required(identity.pending.shift())();
      await tick();
    }
    controller.abort();
    if (phase === "signer") required(identity.pending.shift())();
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(1);
    const next = t.query([{ kinds: [0], limit: 3 }]);
    await vi.waitFor(() => expect(identity.pending).toHaveLength(1));
    required(identity.pending.shift())();
    await vi.advanceTimersByTimeAsync(500);
    await next;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each(["signer", "dispatch"])(
  "auth that expires during %s wait is explicitly unsent; manual retry preserves the signed message",
  async (phase) => {
    vi.useFakeTimers();
    const identity = deferredSigner();
    const event = signed(identity.key, {
      kind: 9,
      content: "exact",
      tags: [["h", "c"]],
    });
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const auth = JSON.parse(
        atob(
          (init.headers as Record<string, string>).Authorization?.slice(6) ??
            "",
        ),
      );
      expect(
        Math.abs(Math.floor(Date.now() / 1000) - auth.created_at),
      ).toBeLessThanOrEqual(45);
      return Response.json(
        Array.isArray(body) ? [] : { accepted: true, event_id: body.id },
      );
    });
    vi.stubGlobal("fetch", fetcher);
    const t = await connectSignedTransport(
      identity,
      "https://expired-sign.test",
      "relay",
    );
    assert.exists(t.writer);
    const first = t.query([{ kinds: [0], limit: 1 }]);
    await vi.waitFor(() => expect(identity.pending).toHaveLength(1));
    required(identity.pending.shift())();
    await first;
    const publication = t.writer.publish(event, new AbortController().signal);
    const rejected =
      expect(publication).rejects.toBeInstanceOf(PublishRejected);
    await vi.waitFor(() => expect(identity.pending).toHaveLength(1));
    if (phase === "dispatch") {
      required(identity.pending.shift())();
      await tick();
    }
    // Wall-clock expiry after signing must still be checked at the final fetch boundary.
    vi.setSystemTime(Date.now() + 46000);
    if (phase === "signer") required(identity.pending.shift())();
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetcher).toHaveBeenCalledTimes(1); // No auto-resign or automatic resend.
    const retry = t.writer.publish(event, new AbortController().signal);
    await vi.waitFor(() => expect(identity.pending).toHaveLength(1));
    required(identity.pending.shift())();
    await retry;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.lastCall?.[1].body).toBe(JSON.stringify(event));
  },
);

it("async auth ownership is bounded across signed constructor recreation", async () => {
  vi.useFakeTimers();
  const identity = deferredSigner();
  const fetcher = vi.fn(async () => Response.json([]));
  vi.stubGlobal("fetch", fetcher);
  const t = await connectSignedTransport(
    identity,
    "https://bounded-sign.test",
    "relay",
  );
  const controller = new AbortController();
  const reads = Array.from({ length: 128 }, (_, i) =>
    t
      .query([{ kinds: [0], limit: i + 1 }], controller.signal)
      .catch((error) => error),
  );
  await vi.waitFor(() => expect(identity.pending).toHaveLength(128));
  const replacement = await connectSignedTransport(
    { ...identity },
    "https://bounded-sign.test/",
    "relay",
  );
  const overflow = replacement
    .query([{ kinds: [0], limit: 129 }], controller.signal)
    .catch((error) => error);
  await tick();
  // Fail promptly if an overflow operation reaches the unabortable signer.
  await vi.waitFor(() =>
    expect(identity.pending.length).toBeGreaterThanOrEqual(128),
  );
  expect(
    await Promise.race([overflow, Promise.resolve("still signing")]),
  ).toBeInstanceOf(ApiCapacity);
  controller.abort();
  // A signer cannot be aborted: cancellation must not admit unlimited new prompts.
  await expect(
    replacement.query([{ kinds: [0], limit: 130 }]),
  ).rejects.toBeInstanceOf(ApiCapacity);
  for (const finish of identity.pending.splice(0)) finish();
  expect(
    (await Promise.all(reads)).every((error) => error.name === "AbortError"),
  ).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
  const next = replacement.query([{ kinds: [0], limit: 1 }]);
  await vi.waitFor(() => expect(identity.pending).toHaveLength(1));
  required(identity.pending.shift())();
  await next;
  expect(fetcher).toHaveBeenCalledTimes(1);
});
