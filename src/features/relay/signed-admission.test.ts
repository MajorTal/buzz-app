import { beforeEach, afterEach, assert, expect, it, vi } from "vitest";
import { connectSignedTransport } from "./transport";
import { PublishRejected } from "./outbox";
import { keypair, signed } from "./testing";

const filters = [{ kinds: [0], limit: 1 }];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1700000000000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function signer(key = keypair()) {
  return {
    getPublicKey: async () => key.pubkey,
    signEvent: vi.fn(async (template: Parameters<typeof signed>[1]) =>
      signed(key, template),
    ),
  };
}
it("signed reads/writes share cooldown across constructor recreation; viewer/community are independent", async () => {
  const identity = signer();
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (fetcher.mock.calls.length === 1)
      return Response.json(
        { error: "rate-limited: quota exceeded; retry in 0s" },
        { status: 429 },
      );
    const body = JSON.parse(init?.body as string);
    return Response.json(
      Array.isArray(body) ? [] : { accepted: true, event_id: body.id },
    );
  });
  vi.stubGlobal("fetch", fetcher);
  const first = await connectSignedTransport(
    identity,
    "https://quota.test",
    "relay",
  );
  await expect(first.query(filters)).rejects.toMatchObject({
    status: 429,
    retryAfterMs: 1000,
  });
  // A different signer object wrapping the same viewer still shares the host principal.
  const second = await connectSignedTransport(
    { ...identity },
    "https://quota.test/",
    "relay",
  );
  const event = await identity.signEvent({
    kind: 9,
    content: "exact",
    tags: [["h", "c"]],
  });
  assert.exists(second.writer);
  await expect(
    second.writer.publish(event, new AbortController().signal),
  ).rejects.toBeInstanceOf(PublishRejected);
  await expect(second.query(filters)).rejects.toMatchObject({
    status: 429,
    retryAfterMs: expect.any(Number),
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const otherViewer = await connectSignedTransport(
    signer(),
    "https://quota.test",
    "relay",
  );
  const otherCommunity = await connectSignedTransport(
    identity,
    "https://other.test",
    "relay",
  );
  await Promise.all([
    otherViewer.query(filters),
    otherCommunity.query(filters),
  ]);
  expect(fetcher).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1000);
  await second.writer.publish(event, new AbortController().signal);
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(fetcher.mock.lastCall?.[1]?.body).toBe(JSON.stringify(event));
});
it("cancellation before async auth skips signing/fetch; subsequent read uses new NIP-98", async () => {
  const identity = signer();
  const fetcher = vi.fn(async () => Response.json([]));
  vi.stubGlobal("fetch", fetcher);
  const transport = await connectSignedTransport(
    identity,
    "https://fresh.test",
    "relay",
  );
  await transport.query(filters);
  const controller = new AbortController();
  const cancelled = transport.query(filters, controller.signal);
  const rejected = expect(cancelled).rejects.toMatchObject({
    name: "AbortError",
  });
  controller.abort();
  await rejected;
  // Advance wall time without releasing admission: the replacement must mint
  // new auth, not reuse the first read's event after a cancellation.
  vi.setSystemTime(Date.now() + 1000);
  const before = Date.now();
  const next = transport.query(filters);
  expect(identity.signEvent).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(500);
  await next;
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(identity.signEvent).toHaveBeenCalledTimes(2);
  const auth = identity.signEvent.mock.lastCall?.[0];
  assert.exists(auth);
  expect(auth.kind).toBe(27235);
  expect(auth.created_at).toBe(Math.floor(before / 1000));
});
it("explicit quota rejection is retryable; missing response stays unknown with no transparent resend", async () => {
  const identity = signer();
  const transport = await connectSignedTransport(
    identity,
    "https://write.test",
    "relay",
  );
  const event = await identity.signEvent({
    kind: 9,
    content: "exact",
    tags: [["h", "c"]],
  });
  assert.exists(transport.writer);
  const fetcher = vi.fn(async () =>
    Response.json(
      { error: "rate-limited: quota exceeded; retry in 0s" },
      { status: 429 },
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  await expect(
    transport.writer.publish(event, new AbortController().signal),
  ).rejects.toBeInstanceOf(PublishRejected);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000);
  fetcher.mockImplementation(async () => {
    throw new Error("response lost");
  });
  await expect(
    transport.writer.publish(event, new AbortController().signal),
  ).rejects.not.toBeInstanceOf(PublishRejected);
  await vi.advanceTimersByTimeAsync(500);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
