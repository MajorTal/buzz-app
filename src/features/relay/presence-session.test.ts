import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import type { LiveCallbacks } from "./live";
import { keypair, scriptedTransport, signed } from "./testing";
import type { ActivitySnapshot, PresenceActivity } from "../presence/activity";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000000);
});
afterEach(() => vi.useRealTimers());
function fixture(
  options: { presence?: boolean | undefined; live?: boolean } = {
    presence: true,
  },
) {
  const relay = keypair(),
    viewer = keypair(),
    author = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let callbacks!: LiveCallbacks;
  const update = vi.fn();
  const observe = vi.fn();
  const publish = vi.fn(
    async (_status: "online" | "away", _signal: AbortSignal) => {},
  );
  let activity: ActivitySnapshot = { status: "online", visible: true };
  const listeners = new Set<() => void>();
  const source: PresenceActivity = {
    snapshot: () => activity,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const owner = createRelaySession(
    {
      ...wire.transport,
      agentActivity: true,
      ...(options.presence === undefined ? {} : { presence: options.presence }),
      ...(options.live === false
        ? {}
        : {
            subscribe(value: LiveCallbacks) {
              callbacks = value;
              return {
                update() {},
                retry() {},
                dispose() {},
                observe,
                presence: { update, publish },
              };
            },
          }),
    },
    { presenceActivity: source },
  );
  const mount = () => {
    const demand = owner.session.presence.demand();
    callbacks.state({ status: "connected", routes: [] });
    demand.update([author.pubkey]);
    callbacks.presenceState?.({ status: "ready", authors: [author.pubkey] });
    return demand;
  };
  return {
    owner,
    wire,
    author,
    relay,
    callbacks,
    update,
    observe,
    publish,
    mount,
    activity(next: ActivitySnapshot) {
      activity = next;
      for (const listener of listeners) listener();
    },
    snapshot: () =>
      signed(relay, {
        kind: 20001,
        content: "online",
        tags: [["p", author.pubkey]],
      }),
  };
}
it("production session routes presence outside retained projections and starts no message repair", async () => {
  const f = fixture();
  const demand = f.mount();
  await vi.advanceTimersByTimeAsync(100);
  const query = f.wire.next();
  expect(query.filters).toEqual([
    { kinds: [20001], authors: [f.author.pubkey], limit: 1 },
  ]);
  query.respond([f.snapshot()]);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.owner.session.presence.get(f.author.pubkey)).toBe("online");
  const view = f.owner.session.observe([{ kinds: [20001], limit: 10 }]);
  expect(view.snapshot().events).toEqual([]);
  f.callbacks.presence?.([
    signed(f.author, { kind: 20001, content: "online", tags: [] }),
  ]);
  expect(view.snapshot().events).toEqual([]);
  // Wrongly routed ephemeral frames must also be excluded, not stored by generic acceptance.
  f.callbacks.receive([
    signed(f.author, {
      kind: 20001,
      content: "online",
      tags: [],
      created_at: 2,
    }),
  ]);
  expect(view.snapshot().events).toEqual([]);
  expect(f.wire.pending).toEqual([]);
  expect(f.owner.session.outbox).toBeUndefined();
  demand.dispose();
  view.dispose();
  f.owner.dispose();
});
it("host activity suspends observers but keeps one availability publisher; disposal aborts both", async () => {
  const f = fixture();
  f.mount();
  await vi.advanceTimersByTimeAsync(1100);
  const request = f.wire.next();
  expect(f.publish).toHaveBeenCalledTimes(1);
  f.activity({ status: "online", visible: false });
  expect(f.update).toHaveBeenLastCalledWith([]);
  expect(request.signal?.aborted).toBe(true);
  expect(f.owner.session.presence.get(f.author.pubkey)).toBe("unknown");
  await vi.advanceTimersByTimeAsync(66000);
  expect(f.publish).toHaveBeenCalledTimes(2);
  expect(f.wire.pending).toHaveLength(0);
  f.owner.dispose();
  await vi.advanceTimersByTimeAsync(180000);
  expect(f.publish).toHaveBeenCalledTimes(2);
});
it("session access revocation clears prior presence and rejects in-flight snapshot authority", async () => {
  const f = fixture();
  f.mount();
  await vi.advanceTimersByTimeAsync(100);
  const first = f.wire.next();
  first.respond([f.snapshot()]);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.owner.session.presence.get(f.author.pubkey)).toBe("online");
  // Actual signed roster removes viewer; the session owns access invalidation.
  const { roster } = await import("./testing");
  const member = f.owner.session as typeof f.owner.session;
  f.callbacks.receive([roster(f.relay, "a", [f.wire.transport.viewer])]);
  f.callbacks.receive([roster(f.relay, "a", [], 1700000001)]);
  expect(member.presence.get(f.author.pubkey)).toBe("unknown");
  f.owner.dispose();
});

it("merged session keeps observer telemetry and presence independently owned across clear and disposal", async () => {
  const f = fixture();
  const demand = f.mount();
  const release = f.owner.session.agentActivity.activate();
  const generation = f.observe.mock.lastCall?.[0];
  expect(generation).toBeTypeOf("number");
  f.callbacks.state({
    status: "connected",
    routes: [{ id: "observer", status: "live", replay: "unknown" }],
  });
  expect(f.owner.session.agentActivity.snapshot().status).toBe("listening");
  await vi.advanceTimersByTimeAsync(1100);
  f.wire.next().respond([f.snapshot()]);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.owner.session.presence.get(f.author.pubkey)).toBe("online");
  const frame = {
    id: "f".repeat(64),
    agent: f.author.pubkey,
    createdAt: Math.floor(Date.now() / 1000),
    plaintext: JSON.stringify({
      kind: "turn_started",
      turnId: "one",
      channelId: null,
      timestamp: new Date().toISOString(),
    }),
  };
  f.callbacks.observer?.(frame, generation);
  expect(f.owner.session.agentActivity.snapshot().turns[0]?.state).toBe(
    "working",
  );
  const view = f.owner.session.observe([{ kinds: [20001, 24200], limit: 10 }]);
  expect(view.snapshot().events).toEqual([]);
  demand.dispose();
  expect(f.update).toHaveBeenLastCalledWith([]);
  expect(f.owner.session.agentActivity.snapshot().records).toHaveLength(1);
  f.callbacks.state({ status: "retrying", routes: [] });
  expect(f.owner.session.agentActivity.snapshot().turns[0]?.state).toBe(
    "unknown",
  );
  await f.owner.clearCache();
  f.callbacks.observer?.(frame, generation);
  expect(f.owner.session.agentActivity.snapshot().records).toHaveLength(0);
  release();
  expect(f.observe).toHaveBeenLastCalledWith(null);
  const publications = f.publish.mock.calls.length;
  f.owner.dispose();
  f.callbacks.observer?.({ ...frame, id: "e".repeat(64) }, generation);
  await vi.advanceTimersByTimeAsync(180000);
  expect(f.publish).toHaveBeenCalledTimes(publications);
  expect(f.owner.session.agentActivity.snapshot().status).toBe("unavailable");
  expect(f.owner.session.agentActivity.snapshot().records).toHaveLength(0);
  expect(view.snapshot().events).toEqual([]);
  view.dispose();
});

it.each([{ presence: false }, {}, { presence: true, live: false }])(
  "unsupported transport starts no presence reads, controls, publisher or renewals (%j)",
  async (options) => {
    const f = fixture(options);
    try {
      if (options.live !== false) f.mount();
      else f.owner.session.presence.demand().update([f.author.pubkey]);
      f.activity({ status: "away", visible: false });
      f.activity({ status: "online", visible: true });
      f.callbacks?.presenceState?.({
        status: "ready",
        authors: [f.author.pubkey],
      });
      await vi.advanceTimersByTimeAsync(180000);
      expect(f.wire.pending).toEqual([]);
      expect(f.update).not.toHaveBeenCalled();
      expect(f.publish).not.toHaveBeenCalled();
      expect(f.owner.diagnostics().presence.publisher).toBeUndefined();
      expect(f.owner.session.presence.get(f.author.pubkey)).toBe("unknown");
    } finally {
      f.owner.dispose();
    }
  },
);
