// Reader-to-host priority propagation control contributed by Brain.

import { afterEach, expect, it, vi } from "vitest";
import { connectSignedTransport } from "./transport";
import { createRelayReader } from "./reader";
import { keypair, signed } from "./testing";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("production reader priority reaches actual signed fetch admission", async () => {
  vi.useFakeTimers();
  const key = keypair();
  const prepared: Array<() => void> = [];
  const nextAuth = () => new Promise<void>((resolve) => prepared.push(resolve));
  const calls: number[] = [];
  const signer = {
    getPublicKey: async () => key.pubkey,
    signEvent: async (t: Parameters<typeof signed>[1]) => {
      const event = signed(key, t);
      prepared.shift()?.();
      return event;
    },
  };
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(init.body as string)[0].limit);
    return Response.json([]);
  });
  const t = await connectSignedTransport(
    signer,
    "https://priority-review.test",
    "relay",
  );
  const r = createRelayReader(t);
  try {
    await r.reader.read([{ kinds: [0], limit: 1 }]);
    const backgroundAuth = nextAuth();
    const b = r.reader.read([{ kinds: [0], limit: 2 }], {
      priority: "background",
    });
    // Finish real async authentication, then drain its admission continuation
    // without allowing the 500ms dispatch window to expire.
    await backgroundAuth;
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([1]);
    const foregroundAuth = nextAuth();
    const f = r.reader.read([{ kinds: [0], limit: 3 }], {
      priority: "foreground",
    });
    await foregroundAuth;
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(499);
    expect(calls).toEqual([1]);
    await vi.advanceTimersByTimeAsync(1);
    await f;
    expect(calls).toEqual([1, 3]);
    await vi.advanceTimersByTimeAsync(500);
    await b;
    expect(calls).toEqual([1, 3, 2]);
  } finally {
    r.dispose();
  }
});
