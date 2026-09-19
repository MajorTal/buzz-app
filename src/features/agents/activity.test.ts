import { afterEach, expect, it, vi } from "vitest";
import {
  ACTIVITY_BYTE_LIMIT,
  ACTIVITY_RECORD_LIMIT,
  ACTIVITY_TURN_LIMIT,
  createAgentActivity,
} from "./activity";
import type { LiveSnapshot } from "../relay/live";
const agent = "a".repeat(64);
const connected: LiveSnapshot = {
  status: "connected",
  routes: [{ id: "observer", status: "live", replay: "unknown" }],
};
function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(1800000000000);
  const observe = vi.fn();
  let denied = false;
  const activity = createAgentActivity(
    true,
    observe,
    (channel) => !(denied && channel === "a"),
  );
  const release = activity.queries.activate();
  activity.state(connected);
  let serial = 0;
  const generation = () => observe.mock.lastCall?.[0] as number;
  const make = (raw: unknown) => ({
    id: (++serial).toString(16).padStart(64, "0"),
    agent,
    createdAt: Math.floor(Date.now() / 1000),
    plaintext: JSON.stringify(raw),
  });
  const item = (kind: string, turnId = "one", extra = {}) => ({
    kind,
    turnId,
    channelId: "a",
    sessionId: null,
    seq: 1,
    timestamp: new Date().toISOString(),
    payload: {},
    ...extra,
  });
  const send = (raw: unknown) => activity.receive(make(raw), generation());
  return {
    activity,
    release,
    observe,
    make,
    send,
    item,
    generation,
    snapshot: activity.queries.snapshot,
    deny: () => {
      denied = true;
      activity.clear();
    },
  };
}
afterEach(() => vi.useRealTimers());
it("folds each mixed-turn batch child; resolution is not completion; null-session completion ends only its turn", () => {
  const f = fixture();
  f.send(f.item("turn_started"));
  f.send(f.item("session_resolved", "one", { sessionId: "S" }));
  expect(f.snapshot().turns[0]?.state).toBe("working");
  f.send(
    f.item("batch", "two", {
      payload: {
        events: [f.item("turn_completed"), f.item("turn_started", "two")],
      },
    }),
  );
  expect(f.snapshot().turns.map((turn) => [turn.turnId, turn.state])).toEqual([
    ["one", "ended"],
    ["two", "working"],
  ]);
  f.send(f.item("turn_liveness", "one", { seq: 0 }));
  expect(f.snapshot().turns[0]?.state).toBe("ended");
  f.send(f.item("acp_read", "three", { channelId: "b", seq: 0 }));
  expect(f.snapshot().turns[2]?.state).toBe("working");
  f.release();
  expect(vi.getTimerCount()).toBe(0);
});
it("late attachment learns from liveness; silence and disconnect mean unknown, not ended; future/unknown data stays raw", async () => {
  const f = fixture();
  f.send(f.item("turn_liveness"));
  await vi.advanceTimersByTimeAsync(31000);
  expect(f.snapshot().turns[0]?.state).toBe("unknown");
  f.send(f.item("turn_liveness"));
  expect(f.snapshot().turns[0]?.state).toBe("working");
  f.activity.state({ status: "retrying", routes: [] });
  f.activity.state(connected);
  expect(f.snapshot().turns[0]?.state).toBe("unknown");
  f.send(f.item("mystery", "new"));
  f.send(
    f.item("turn_started", "future", {
      timestamp: new Date(Date.now() + 60000).toISOString(),
    }),
  );
  expect(f.snapshot().turns).toHaveLength(1);
  expect(f.snapshot().records).toHaveLength(4);
  f.activity.dispose();
});
it("clears on disable/access/cache/dispose and fences late frames by generation; batches cannot leak denied children", () => {
  const f = fixture();
  const initial = f.generation();
  f.send(f.item("acp_read"));
  f.activity.clear();
  f.activity.receive(f.make(f.item("acp_read")), initial);
  expect(f.snapshot().records).toHaveLength(0);
  f.send(f.item("acp_read"));
  expect(f.snapshot().records).toHaveLength(1);
  f.deny();
  f.send(
    f.item("batch", "two", {
      channelId: "b",
      payload: { events: [f.item("acp_read")] },
    }),
  );
  expect(f.snapshot().records).toHaveLength(0);
  f.release();
  expect(f.snapshot().status).toBe("disabled");
  f.activity.receive(f.make(f.item("acp_read")), f.generation());
  expect(f.snapshot().records).toHaveLength(0);
  f.activity.dispose();
  expect(f.snapshot().status).toBe("unavailable");
});
it("keeps terminal evidence monotonic across clock rollback, eviction and delayed liveness", () => {
  const f = fixture();
  const liveness = f.item("turn_liveness", "retired", {
    timestamp: new Date(Date.now() - 5000).toISOString(),
  });
  f.send(liveness);
  f.send(
    f.item("turn_completed", "retired", {
      timestamp: new Date(Date.now() - 15000).toISOString(),
    }),
  );
  expect(f.snapshot().turns[0]?.state).toBe("ended");
  for (let i = 0; i < ACTIVITY_TURN_LIMIT; i++)
    f.send(
      f.item("turn_liveness", String(i), {
        timestamp: new Date(Date.now() - 10000).toISOString(),
      }),
    );
  f.send(liveness);
  expect(
    f.snapshot().turns.find((turn) => turn.turnId === "retired")?.state,
  ).toBe("ended");
  // Newer evidence eventually evicts the terminal entry, but not its watermark.
  for (let i = 0; i < ACTIVITY_TURN_LIMIT; i++)
    f.send(f.item("turn_liveness", `new-${i}`));
  expect(f.snapshot().turns.some((turn) => turn.turnId === "retired")).toBe(
    false,
  );
  f.send(liveness);
  expect(f.snapshot().turns.some((turn) => turn.turnId === "retired")).toBe(
    false,
  );
  f.activity.dispose();
});
it("bounds records, UTF-8 bytes, turn state and immutable snapshots; dedups IDs, not process-local sequence", () => {
  const f = fixture();
  const first = f.make(f.item("acp_read"));
  f.activity.receive(first, f.generation());
  const old = f.snapshot();
  f.activity.receive(first, f.generation());
  expect(f.snapshot()).toBe(old);
  for (let i = 0; i < ACTIVITY_RECORD_LIMIT + 1; i++)
    f.send(f.item("unknown", String(i)));
  expect(f.snapshot().records).toHaveLength(ACTIVITY_RECORD_LIMIT);
  expect(old.records).toHaveLength(1);
  for (let i = 0; i < 40; i++)
    f.send(f.item("unknown", String(i), { payload: "é".repeat(30000) }));
  expect(
    f
      .snapshot()
      .records.reduce(
        (size, row) => size + new TextEncoder().encode(row.plaintext).length,
        0,
      ),
  ).toBeLessThanOrEqual(ACTIVITY_BYTE_LIMIT);
  f.activity.clear();
  for (let i = 0; i < ACTIVITY_TURN_LIMIT + 10; i++) {
    vi.setSystemTime(Date.now() + 1);
    f.send(f.item("turn_completed", String(i)));
  }
  expect(f.snapshot().turns).toHaveLength(ACTIVITY_TURN_LIMIT);
  expect(f.snapshot().trimmed).toBeGreaterThan(0);
  f.send(
    f.item("acp_read", "0", {
      timestamp: new Date(1800000000000).toISOString(),
    }),
  );
  expect(f.snapshot().turns.some((turn) => turn.turnId === "0")).toBe(false);
  f.activity.dispose();
});

it("indexes every recognized channel in a raw batch without rewriting or assigning unscoped records", () => {
  const f = fixture();
  const raw = f.item("batch", "last", {
    channelId: "b",
    payload: {
      events: [
        f.item("acp_read", "first"),
        f.item("acp_read", "last", { channelId: "b" }),
      ],
    },
  });
  f.send(raw);
  f.send(f.item("acp_read", "unscoped", { channelId: null }));
  expect(f.snapshot().records[0]?.channelIds).toEqual(["b", "a"]);
  expect(f.snapshot().records[0]?.plaintext).toBe(JSON.stringify(raw));
  expect(Object.isFrozen(f.snapshot().records[0]?.channelIds)).toBe(true);
  expect(f.snapshot().records[1]?.channelIds).toEqual([]);
  f.activity.dispose();
});

const typingEvent = (root?: string, extra = {}) => ({
  id: "e".repeat(64),
  pubkey: agent,
  kind: 20002,
  content: "",
  created_at: Math.floor(Date.now() / 1000),
  tags: [
    ["h", "a"],
    ...(root
      ? [
          ["e", root, "", "root"],
          ["e", root, "", "reply"],
        ]
      : []),
  ],
  ...extra,
});
it("typing requires observer recognition, retains exact scopes, and expires on its own clock", async () => {
  const f = fixture();
  const root = "b".repeat(64),
    sibling = "c".repeat(64);
  f.activity.channelEvents([typingEvent(root)]);
  expect(f.snapshot().typing).toEqual([]);
  f.send(f.item("turn_completed")); // Recognition is not the turn's working state.
  f.activity.channelEvents([
    typingEvent(root),
    typingEvent(sibling),
    typingEvent(),
  ]);
  expect(f.snapshot().typing.map((entry) => entry.threadRootId)).toEqual([
    root,
    sibling,
    undefined,
  ]);
  const before = f.snapshot();
  await vi.advanceTimersByTimeAsync(4000);
  f.activity.channelEvents([
    typingEvent(root, { created_at: Date.now() / 1000 - 5 }),
  ]);
  expect(f.snapshot()).toBe(before); // Older typing cannot shorten or refresh evidence.
  f.send(f.item("turn_liveness", "new"));
  await vi.advanceTimersByTimeAsync(4000);
  expect(f.snapshot().typing).toEqual([]); // Observer did not refresh the typing clock.
  expect(before.typing).toHaveLength(3);
  f.activity.dispose();
});
it("messages clear only their typing scope and suppress delayed typing, while fresh work can resume", async () => {
  const f = fixture();
  const root = "b".repeat(64),
    sibling = "c".repeat(64);
  f.send(f.item("turn_liveness"));
  const first = typingEvent(root);
  f.activity.channelEvents([first, typingEvent(sibling)]);
  f.activity.channelEvents([{ ...first, kind: 9 }]);
  f.activity.channelEvents([first]);
  expect(f.snapshot().typing.map((entry) => entry.threadRootId)).toEqual([
    sibling,
  ]);
  await vi.advanceTimersByTimeAsync(3000);
  f.activity.channelEvents([typingEvent(root)]);
  expect(f.snapshot().typing).toHaveLength(2);
  f.activity.dispose();
});
it("invalid, stale, unknown-agent and ambiguous channel/thread typing cannot create a channel fallback", () => {
  const f = fixture();
  f.send(f.item("turn_liveness"));
  f.activity.channelEvents([
    typingEvent(undefined, { pubkey: "d".repeat(64) }),
    typingEvent(undefined, { created_at: Date.now() / 1000 - 8 }),
    typingEvent(undefined, { created_at: Date.now() / 1000 + 6 }),
    typingEvent(undefined, {
      tags: [
        ["h", "a"],
        ["h", "b"],
      ],
    }),
    typingEvent(undefined, {
      tags: [
        ["h", "a"],
        ["e", "bogus", "", "reply"],
      ],
    }),
    typingEvent(undefined, { tags: [] }),
  ]);
  expect(f.snapshot().typing).toEqual([]);
  f.activity.dispose();
});
it("typing clears on route failure, disconnect, disable, access reset and disposal without reconnect resurrection", () => {
  const f = fixture();
  f.send(f.item("turn_liveness"));
  const send = () => f.activity.channelEvents([typingEvent("b".repeat(64))]);
  send();
  f.activity.state({
    ...connected,
    routes: [
      ...connected.routes,
      { id: "channel:a", channelId: "a", status: "error", replay: "unknown" },
    ],
  });
  expect(f.snapshot().typing).toEqual([]);
  f.activity.state(connected);
  send();
  f.activity.state({ status: "retrying", routes: [] });
  send();
  f.activity.state(connected);
  expect(f.snapshot().typing).toEqual([]);
  send();
  f.deny();
  f.activity.state(connected);
  send();
  expect(f.snapshot().typing).toEqual([]);
  f.release();
  send();
  expect(f.snapshot().typing).toEqual([]);
  f.activity.dispose();
});
it("typing state is bounded by the existing activity budget", () => {
  const f = fixture();
  f.send(f.item("turn_liveness"));
  f.activity.channelEvents(
    Array.from({ length: ACTIVITY_TURN_LIMIT + 20 }, (_, i) =>
      typingEvent(i.toString(16).padStart(64, "0")),
    ),
  );
  expect(f.snapshot().typing).toHaveLength(ACTIVITY_TURN_LIMIT);
  f.activity.dispose();
});

it("accepted future clock skew cannot extend typing beyond eight seconds from receipt", async () => {
  const f = fixture();
  f.send(f.item("turn_liveness"));
  f.activity.channelEvents([
    typingEvent(undefined, { created_at: Date.now() / 1000 + 5 }),
  ]);
  expect(f.snapshot().typing).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(8000);
  expect(f.snapshot().typing).toEqual([]);
  f.activity.dispose();
});
