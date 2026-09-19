import type { EventData } from "../relay/events";
import { threadReference } from "../relay/thread-reference";
import type { LiveSnapshot } from "../relay/live";
import { observerFrame, type ObserverFrame } from "./observer";

export const ACTIVITY_RECORD_LIMIT = 200;
export const ACTIVITY_BYTE_LIMIT = 2 * 1024 * 1024;
export const ACTIVITY_TURN_LIMIT = 512;
export const ACTIVITY_FRESH_MS = 30_000;
type RawRecord = ObserverFrame &
  Readonly<{
    receivedAt: number;
    kind: string;
    /** Recognized envelope/child channel metadata; plaintext stays unmodified. */
    channelIds: readonly string[];
  }>;
export type ActivityTurn = Readonly<{
  agent: string;
  turnId: string;
  channelId: string | null;
  timestamp: number;
  state: "working" | "unknown" | "ended";
}>;
type Typing = Readonly<{
  agent: string;
  channelId: string;
  threadRootId: string | undefined;
  timestamp: number;
  working: boolean;
  expiresAt: number;
}>;
const TYPING_FRESH_MS = 8000;
type Snapshot = Readonly<{
  status:
    | "unavailable"
    | "disabled"
    | "connecting"
    | "listening"
    | "interrupted";
  records: readonly RawRecord[];
  turns: readonly ActivityTurn[];
  typing: readonly Typing[];
  trimmed: number;
}>;
type Turn = Omit<ActivityTurn, "state"> & { ended: boolean; epoch: number };
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;
const starts = new Set([
  "turn_started",
  "turn_liveness",
  "acp_read",
  "acp_write",
  "session_resolved",
]);
const ends = new Set(["turn_completed", "turn_error", "agent_panic"]);

/** Session-owned RAM only. Plugin activation owns demand, not sockets or keys. */
export function createAgentActivity(
  available: boolean,
  observe: (generation: number | null) => void,
  canAccess: (channel: string) => boolean,
  notify = (listener: () => void) => listener(),
) {
  let closed = false,
    leases = 0,
    generation = 0,
    epoch = 0;
  let status: Snapshot["status"] = available ? "disabled" : "unavailable";
  let records: RawRecord[] = [],
    bytes = 0,
    trimmed = 0,
    evidenceFloor = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const turns = new Map<string, Turn>();
  const typing = new Map<string, Typing>();
  const listeners = new Set<() => void>();
  let snapshot: Snapshot = Object.freeze({
    status,
    records: [],
    turns: [],
    typing: [],
    trimmed,
  });
  function publish() {
    const now = Date.now();
    const known = new Set(records.map((record) => record.agent));
    for (const [key, entry] of typing)
      if (now >= entry.expiresAt || !known.has(entry.agent)) typing.delete(key);
    const typers = [...typing.values()].filter((entry) => entry.working);
    const visible = [...turns.values()].map(
      (turn): ActivityTurn =>
        Object.freeze({
          agent: turn.agent,
          turnId: turn.turnId,
          channelId: turn.channelId,
          timestamp: turn.timestamp,
          state: turn.ended
            ? "ended"
            : status === "listening" &&
                turn.epoch === epoch &&
                now - turn.timestamp <= ACTIVITY_FRESH_MS &&
                turn.timestamp <= now + 5000
              ? "working"
              : "unknown",
        }),
    );
    if (
      snapshot.status === status &&
      snapshot.records === records &&
      snapshot.trimmed === trimmed &&
      JSON.stringify(snapshot.turns) === JSON.stringify(visible) &&
      JSON.stringify(snapshot.typing) === JSON.stringify(typers)
    )
      return;
    snapshot = Object.freeze({
      status,
      records: Object.freeze(records),
      turns: Object.freeze(visible),
      typing: Object.freeze(typers),
      trimmed,
    });
    for (const listener of listeners) notify(listener);
  }
  function reset() {
    records = [];
    bytes = 0;
    trimmed = 0;
    evidenceFloor = 0;
    turns.clear();
    typing.clear();
    epoch++;
  }
  function restart() {
    generation++;
    reset();
    if (available && !closed && leases) {
      status = "connecting";
      observe(generation);
    } else status = closed || !available ? "unavailable" : "disabled";
    publish();
  }
  function fold(agent: string, value: unknown) {
    const item = object(value);
    if (
      !item ||
      !text(item.kind) ||
      !text(item.turnId) ||
      !(item.channelId === null || text(item.channelId)) ||
      typeof item.timestamp !== "string"
    )
      return;
    if (item.channelId && !canAccess(item.channelId)) return;
    if (!starts.has(item.kind) && !ends.has(item.kind)) return;
    const timestamp = Date.parse(item.timestamp);
    if (!Number.isFinite(timestamp) || timestamp > Date.now() + 5000) return;
    const key = `${agent}:${item.turnId}`;
    const previous = turns.get(key);
    // Terminal evidence wins even when a delayed earlier heartbeat arrives later.
    if (
      previous?.ended ||
      (previous && previous.timestamp > timestamp && !ends.has(item.kind))
    )
      return;
    if (!previous && timestamp <= evidenceFloor) return;
    turns.set(key, {
      agent,
      turnId: item.turnId,
      channelId: item.channelId,
      // Completion may precede liveness on a rolled-back producer clock. Keep
      // the highest observed time so eventual eviction cannot weaken the fence.
      timestamp: Math.max(timestamp, previous?.timestamp ?? timestamp),
      ended: ends.has(item.kind),
      epoch,
    });
    if (turns.size > ACTIVITY_TURN_LIMIT) {
      const oldest = [...turns].sort(
        (a, b) => a[1].timestamp - b[1].timestamp,
      )[0];
      if (oldest) {
        turns.delete(oldest[0]);
        // Forgetting a tombstone must not let older evidence resurrect that turn.
        evidenceFloor = Math.max(evidenceFloor, oldest[1].timestamp);
        trimmed++;
      }
    }
  }
  return {
    queries: Object.freeze({
      snapshot: () => snapshot,
      subscribe(listener: () => void) {
        if (closed) return () => {};
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      activate() {
        if (closed || !available) return () => {};
        if (++leases === 1) {
          restart();
          timer = setInterval(publish, 1000);
        }
        let released = false;
        return () => {
          if (released || closed) return;
          released = true;
          if (--leases === 0) {
            observe(null);
            clearInterval(timer);
            restart();
          }
        };
      },
    }),
    receive(input: ObserverFrame, current: number) {
      if (closed || !available || !leases || current !== generation) return;
      let frame: ObserverFrame, raw: unknown;
      try {
        frame = observerFrame(input);
        raw = JSON.parse(frame.plaintext);
      } catch {
        return;
      }
      if (records.some((record) => record.id === frame.id)) return;
      const envelope = object(raw);
      const children =
        envelope?.kind === "batch"
          ? object(envelope.payload)?.events
          : undefined;
      const items = Array.isArray(children) ? children : [raw];
      // A denied child cannot leak through an otherwise visible raw batch.
      if (
        [raw, ...items].some((value) => {
          const item = object(value);
          return text(item?.channelId) && !canAccess(item.channelId);
        })
      )
        return;
      for (const item of items) fold(frame.agent, item);
      const record = Object.freeze({
        ...frame,
        receivedAt: Date.now(),
        kind: text(envelope?.kind) ? envelope.kind : "unknown",
        channelIds: Object.freeze([
          ...new Set(
            [raw, ...items].flatMap((value) => {
              const channelId = object(value)?.channelId;
              return text(channelId) ? [channelId] : [];
            }),
          ),
        ]),
      });
      records = [...records, record];
      bytes += new TextEncoder().encode(frame.plaintext).length;
      while (
        records.length > ACTIVITY_RECORD_LIMIT ||
        bytes > ACTIVITY_BYTE_LIMIT
      ) {
        const first = records.shift();
        if (first) bytes -= new TextEncoder().encode(first.plaintext).length;
        trimmed++;
      }
      publish();
    },
    /** Public typing is scope/freshness evidence only, never ownership evidence. */
    channelEvents(events: readonly EventData[]) {
      if (closed || !leases || status !== "listening") return;
      const known = new Set(records.map((record) => record.agent));
      const now = Date.now();
      for (const event of events) {
        if (![9, 20002].includes(event.kind) || !known.has(event.pubkey))
          continue;
        const channels = event.tags.filter(([name]) => name === "h");
        const channelId = channels[0]?.[1];
        const timestamp = event.created_at * 1000;
        if (
          channels.length !== 1 ||
          !text(channelId) ||
          !canAccess(channelId) ||
          !Number.isSafeInteger(event.created_at) ||
          event.created_at * 1000 > now + 5000 ||
          now - timestamp >= TYPING_FRESH_MS
        )
          continue;
        const reference = threadReference(event);
        // Malformed thread tags must not become channel-wide working evidence.
        if (event.tags.some(([name]) => name === "e") && !reference) continue;
        const threadRootId = reference?.rootId;
        const key = JSON.stringify([event.pubkey, channelId, threadRootId]);
        const previous = typing.get(key);
        if (
          previous &&
          (timestamp < previous.timestamp ||
            (event.kind === 20002 &&
              !previous.working &&
              timestamp <= previous.timestamp + 2000))
        )
          continue;
        typing.delete(key);
        typing.set(
          key,
          Object.freeze({
            agent: event.pubkey,
            channelId,
            threadRootId,
            timestamp,
            working: event.kind === 20002,
            expiresAt: Math.min(timestamp, now) + TYPING_FRESH_MS,
          }),
        );
        if (typing.size > ACTIVITY_TURN_LIMIT) {
          const oldest = typing.keys().next().value;
          if (oldest) typing.delete(oldest);
        }
      }
      publish();
    },
    state(live: LiveSnapshot) {
      if (closed || !available || !leases) return;
      const route = live.routes.find((route) => route.id === "observer");
      const next =
        live.status === "connected" && route?.status === "live"
          ? "listening"
          : live.status === "error" ||
              live.status === "retrying" ||
              route?.status === "error"
            ? "interrupted"
            : "connecting";
      if (status === "listening" && next !== status) epoch++;
      if (next !== "listening") typing.clear();
      else
        for (const [key, entry] of typing) {
          const route = live.routes.find(
            (route) => route.channelId === entry.channelId,
          );
          if (route && route.status !== "live") typing.delete(key);
        }
      status = next;
      publish();
    },
    clear: restart,
    dispose() {
      if (closed) return;
      closed = true;
      leases = 0;
      observe(null);
      clearInterval(timer);
      restart();
      listeners.clear();
    },
  };
}
