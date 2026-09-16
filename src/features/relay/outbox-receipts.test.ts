import { assert, afterEach, expect, it, vi } from "vitest";
import { createOutbox, PublishRejected, type OutgoingEvent } from "./outbox";
import type { RelayEvent } from "./events";
import { flush, keypair, signed } from "./testing";
import { readReceiptText } from "./receipt";

const owners: ReturnType<typeof createOutbox>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.useRealTimers();
});
function setup(timeoutMs = 10000) {
  const key = keypair();
  let saved: readonly OutgoingEvent[] = [];
  let settle: ((message: string) => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  let published: RelayEvent | undefined;
  let signal: AbortSignal | undefined;
  const onReceipt = vi.fn();
  const sign = vi.fn(async (template) =>
    signed(key, structuredClone(template)),
  );
  const publish = vi.fn((event: RelayEvent, abort: AbortSignal) => {
    expect(saved.find((row) => row.signed?.id === event.id)).toBeDefined();
    published = event;
    signal = abort;
    return new Promise<string>((resolve, fail) => {
      settle = resolve;
      reject = fail;
    });
  });
  const storage = {
    load: () => saved,
    save: (rows: readonly OutgoingEvent[]) => {
      saved = structuredClone(rows);
    },
  };
  const owner = createOutbox(key.pubkey, { sign, publish }, storage, {
    needsReceipt: (event) => [30620, 46020, 5].includes(event.kind),
    onReceipt,
    timeoutMs,
  });
  owners.push(owner);
  return {
    ...owner,
    key,
    storage,
    sign,
    publish,
    onReceipt,
    saved: () => saved,
    published: () => {
      assert.exists(published);
      return published;
    },
    signal: () => {
      assert.exists(signal);
      return signal;
    },
    settle: (message: string) => {
      assert.exists(settle);
      settle(message);
    },
    reject: (error: Error) => {
      assert.exists(reject);
      reject(error);
    },
    send: (kind = 30620) =>
      owner.outbox.send({
        kind,
        content: "disabled workflow",
        tags: [
          ["h", "channel"],
          ...(kind === 5
            ? [["a", `30620:${key.pubkey}:workflow`]]
            : [["d", "workflow"]]),
        ],
      }),
  };
}
it("preserves command receipt after echo, without persisting secret or aborting publication", async () => {
  const h = setup();
  const id = h.send();
  await flush();
  h.observe([h.published()]);
  expect(h.signal().aborted).toBe(false);
  expect(h.outbox.snapshot()[0]?.delivery).toBe("seen");
  expect(h.onReceipt).not.toHaveBeenCalled();
  h.settle('response:{"webhook_secret":"one-time-fixture"}');
  await flush();
  expect(h.onReceipt).toHaveBeenCalledExactlyOnceWith(
    h.published(),
    'response:{"webhook_secret":"one-time-fixture"}',
  );
  expect(h.outbox.snapshot()).toEqual([]);
  expect(h.local.snapshot()[0]).toMatchObject({
    event: { id },
    delivery: "seen",
  });
  expect(JSON.stringify(h.saved())).not.toContain("one-time-fixture");
});
it("receipt before echo is retained once and message echo keeps its existing cancellation behavior", async () => {
  const h = setup();
  h.send();
  await flush();
  h.settle("response:{}");
  await flush();
  expect(h.outbox.snapshot()[0]?.delivery).toBe("accepted");
  h.observe([h.published()]);
  expect(h.onReceipt).toHaveBeenCalledTimes(1);
  const message = setup();
  message.send(9);
  await flush();
  message.observe([message.published()]);
  expect(message.signal().aborted).toBe(true);
  message.settle("irrelevant");
  await flush();
  expect(message.onReceipt).not.toHaveBeenCalled();
});
it("echo plus lost receipt remains seen but settles command result as unavailable", async () => {
  const h = setup();
  h.send();
  await flush();
  h.observe([h.published()]);
  h.reject(new Error("connection lost"));
  await flush();
  expect(h.local.snapshot()[0]?.delivery).toBe("seen");
  expect(h.onReceipt).toHaveBeenCalledExactlyOnceWith(h.published(), undefined);
});
it("receipt waits are bounded and late results after disposal never publish", async () => {
  vi.useFakeTimers();
  const h = setup(100);
  h.send();
  await vi.advanceTimersByTimeAsync(0);
  h.observe([h.published()]);
  await vi.advanceTimersByTimeAsync(101);
  expect(h.signal().aborted).toBe(true);
  expect(h.onReceipt).toHaveBeenCalledExactlyOnceWith(h.published(), undefined);
  const late = setup();
  late.send();
  await vi.advanceTimersByTimeAsync(0);
  late.dispose();
  late.settle("secret");
  await vi.advanceTimersByTimeAsync(0);
  expect(late.onReceipt).not.toHaveBeenCalled();
});
it("restores signed command intent for inspection without generic replay", async () => {
  const h = setup();
  const id = h.send(46020);
  await flush();
  h.dispose();
  const receipt = vi.fn();
  const publish = vi.fn(
    async (_event: RelayEvent) => "duplicate: already processed",
  );
  const sign = vi.fn(async () => {
    throw new Error("must not sign again");
  });
  const restored = createOutbox(h.key.pubkey, { sign, publish }, h.storage, {
    needsReceipt: (event) => event.kind === 46020,
    onReceipt: receipt,
  });
  owners.push(restored);
  await restored.ready;
  expect(publish).not.toHaveBeenCalled();
  restored.outbox.retry(id);
  await flush();
  expect(sign).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
  expect(receipt).not.toHaveBeenCalled();
  expect(restored.outbox.snapshot()[0]?.delivery).toBe("unknown");
});
it("bounds receipt bytes while streaming before JSON decoding", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(17000));
    },
    cancel,
  });
  await expect(readReceiptText(new Response(body))).rejects.toThrow(
    "size limit",
  );
  expect(cancel).toHaveBeenCalled();
  expect(await readReceiptText(new Response("response:{}"))).toBe(
    "response:{}",
  );
});

it("seen commands can dismiss retained receipts without another publication", async () => {
  const h = setup();
  const id = h.send();
  await flush();
  h.observe([h.published()]);
  h.reject(new Error("lost"));
  await flush();
  expect(h.outbox.snapshot()).toEqual([]);
  expect(h.local.snapshot()[0]?.delivery).toBe("seen");
  await h.outbox.dismiss(id);
  expect(h.local.snapshot()).toEqual([]);
  expect(h.saved()).toEqual([]);
  expect(h.publish).toHaveBeenCalledTimes(1);
});
it.each([30620, 46020, 5])(
  "rejection text never journals command secrets and generic retry cannot replay kind %s",
  async (kind) => {
    const h = setup();
    const id = h.send(kind);
    await flush();
    h.reject(new PublishRejected("PRIVATE"));
    await flush();
    expect(h.outbox.snapshot()[0]?.delivery).toBe("failed");
    expect(JSON.stringify(h.saved())).not.toContain("PRIVATE");
    h.outbox.retry(id);
    await flush();
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.outbox.snapshot()[0]?.delivery).toBe("failed");
  },
);

it.each([30620, 46020, 5])(
  "unknown kind %s is inspect-only while dismissal remains available",
  async (kind) => {
    const h = setup();
    const id = h.send(kind);
    await flush();
    h.reject(new Error("connection lost"));
    await flush();
    expect(h.outbox.snapshot()[0]?.delivery).toBe("unknown");
    h.outbox.retry(id);
    await flush();
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.outbox.snapshot()[0]?.delivery).toBe("unknown");
    await h.outbox.dismiss(id);
    expect(h.outbox.snapshot()).toEqual([]);
  },
);
