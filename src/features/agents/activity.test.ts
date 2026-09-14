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
