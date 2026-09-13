import { afterEach, assert, expect, it, vi } from "vitest";
import { createRelayReader } from "./reader";
import type { ReadFilter, RelayEvent } from "./events";
import { isPresenceSnapshot } from "./presence-contract";

const filter = { kinds: [20001], authors: ["a".repeat(64)], limit: 1 };
const snapshot = [filter];
const ordinary = (n: number) => [{ kinds: [9], limit: n }];
afterEach(() => vi.useRealTimers());
function setup() {
  vi.useFakeTimers();
  const calls: {
    filters: readonly ReadFilter[];
    resolve(value: RelayEvent[]): void;
  }[] = [];
  const owner = createRelayReader(
    {
      viewer: "viewer",
      relayAuthor: "relay",
      media: () => undefined,
      // Deliberately unabortable: consumer completion is not underlying settlement.
      query: (filters) =>
        new Promise((resolve) => calls.push({ filters, resolve })),
    },
    { maxPending: 3 },
  );
  return {
    ...owner,
    calls,
    read: owner.reader.read,
    call(index: number) {
      const call = calls[index];
      assert.exists(call);
      return call;
    },
  };
}
it("a held optional snapshot leaves all three ordinary reader slots and pending budget intact", async () => {
  const h = setup();
  try {
    const p = h.read(snapshot, { priority: "background" });
    const reads = [1, 2, 3].map((n) => h.read(ordinary(n)));
    expect(h.calls).toHaveLength(4);
    await expect(h.read(ordinary(4))).rejects.toThrow("Too many");
    await expect(
      h.read([{ ...filter, authors: ["b".repeat(64)] }]),
    ).rejects.toThrow("Too many");
    h.calls.slice(1).forEach((call) => {
      call.resolve([]);
    });
    await Promise.all(reads);
    const fourth = h.read(ordinary(4));
    expect(h.calls).toHaveLength(5);
    h.call(4).resolve([]);
    await fourth;
    h.call(0).resolve([]);
    await p;
  } finally {
    h.dispose();
  }
});
it("abort keeps the single optional slot until transport settlement; ordinary work and recovery still proceed", async () => {
  const h = setup();
  try {
    const c = new AbortController();
    const p = h.read(snapshot, { signal: c.signal });
    const rejected = expect(p).rejects.toThrow();
    c.abort();
    await rejected;
    for (let i = 0; i < 5; i++)
      await expect(h.read(snapshot)).rejects.toThrow("Too many");
    const f = h.read(ordinary(1));
    expect(h.calls).toHaveLength(2);
    h.call(1).resolve([]);
    await f;
    h.call(0).resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    const retry = h.read(snapshot);
    expect(h.calls).toHaveLength(3);
    h.call(2).resolve([]);
    await retry;
  } finally {
    h.dispose();
  }
});
it("normalization cannot upgrade malformed filters or join them to an optional job", async () => {
  const h = setup();
  try {
    const p = h.read(snapshot);
    for (const malformed of [
      [{ ...filter, since: undefined }],
      [{ ...filter, kinds: [20001, 20001] }],
      [{ ...filter, authors: ["a".repeat(64), "a".repeat(64)] }],
    ])
      await expect(
        h.read(malformed as unknown as readonly ReadFilter[]),
      ).rejects.toThrow("Ambiguous presence");
    const mixed = h.read([{ ...filter, kinds: [20001, 9] }]);
    expect(h.calls).toHaveLength(2);
    expect(isPresenceSnapshot(h.call(1).filters)).toBe(false);
    h.calls.forEach((call) => {
      call.resolve([]);
    });
    await Promise.all([p, mixed]);
  } finally {
    h.dispose();
  }
});
