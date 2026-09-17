import { newer, type RelayEvent } from "./events";
import { retainReadState, retainReadOrder } from "./read-state-retention";
import type { ReadStateHost } from "./read-state-host";
import {
  effectiveFrontier,
  EMPTY_READ_STATE,
  mergeReadStates,
  parseReadBlob,
  readBlob,
  readCoordinate,
  readVersion,
  READ_STATE_PLAINTEXT_BYTES,
  contextId,
  uint32,
  type ReadState,
  type ParsedReadBlob,
} from "./read-state-model";
import {
  newReadJournal,
  type ReadJournal,
  type ReadStateStorage,
} from "./read-state-storage";
import type { Priority, RelayReader } from "./reader";

export type ReadSyncSnapshot = Readonly<{
  capability: "unsupported" | "read-only" | "frontier-sync";
  status:
    | "loading"
    | "local"
    | "pending"
    | "accepted"
    | "reconciled"
    | "stale"
    | "error";
  /** Atomic marker enumeration only; says nothing about completeness of message history. */
  completeness: "unknown" | "snapshot" | "bounded";
  error?: string | undefined;
}>;
export type ReadMutationResult = Readonly<{
  operationId: string;
  durability: "saved";
  sync: "pending" | "local-only";
}>;
export type ReadPublisherLock = (
  signal: AbortSignal,
  work: () => Promise<void>,
) => Promise<void>;
export function browserReadPublisherLock(
  scope: string,
): ReadPublisherLock | undefined {
  if (typeof navigator === "undefined" || !navigator.locks) return;
  return (signal, work) =>
    navigator.locks.request(
      `buzz-read-state:${scope}`,
      { mode: "exclusive", signal },
      work,
    );
}
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Read state unavailable";
const same = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const left = Object.entries(a),
    right = Object.entries(b);
  return (
    left.length === right.length &&
    left.every(
      ([key, value]) =>
        Object.hasOwn(b, key) &&
        same(value, (b as Record<string, unknown>)[key]),
    )
  );
};
/** One durable domain owner. Read intent is not cache; one tab never saves over another's intent. */
export function createReadState({
  viewer,
  reader,
  host,
  storage,
  lock,
  notify = (listener) => listener(),
  now = () => Math.floor(Date.now() / 1000),
  debounceMs = 5000,
  broadcastName,
}: {
  viewer: string;
  reader: RelayReader;
  host: ReadStateHost | undefined;
  storage: ReadStateStorage;
  lock?: ReadPublisherLock | undefined;
  notify?: (listener: () => void) => void;
  now?: () => number;
  debounceMs?: number;
  broadcastName?: string | undefined;
}) {
  let closed = false;
  const lifetime = new AbortController();
  const listeners = new Set<() => void>();
  let journal: ReadJournal | undefined;
  let state: ReadState = EMPTY_READ_STATE;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refreshing: Promise<void> | undefined;
  let publishing: Promise<void> | undefined;
  // Loading a peer revision is not attempting it. Failed attempts wait for explicit retry.
  let attemptedRevision = -1;
  let failedRevision: number | undefined;
  let work: Promise<unknown> = Promise.resolve();
  let epoch = 0;
  let requested = false;
  const slots = new Map<
    string,
    { event: RelayEvent; parsed: ParsedReadBlob }
  >();
  const capability = !host
    ? "unsupported"
    : !host.sign || !host.publish || !lock
      ? "read-only"
      : "frontier-sync";
  let snapshot: ReadSyncSnapshot = Object.freeze({
    capability,
    status: "loading",
    completeness: "unknown",
  });
  const broadcast =
    broadcastName && typeof BroadcastChannel !== "undefined"
      ? new BroadcastChannel(broadcastName)
      : undefined;
  const emit = () => {
    if (!closed) for (const listener of listeners) notify(listener);
  };
  const health = (patch: Partial<ReadSyncSnapshot>) => {
    if (patch.status) failedRevision = undefined;
    const next = { ...snapshot, ...patch };
    if (!same(next, snapshot)) {
      snapshot = Object.freeze(next);
      emit();
    }
  };
  function queue<T>(job: () => Promise<T>): Promise<T> {
    const next = work.then(job);
    work = next.catch(() => {});
    return next;
  }
  async function save(
    change: (current: ReadJournal) => ReadJournal,
    announce = true,
  ) {
    if (closed) throw new Error("Read-state session closed");
    const saved = await storage.update((current) => {
      if (closed) throw new Error("Read-state session closed");
      return change(current ?? newReadJournal());
    });
    if (closed) return saved;
    journal = saved;
    state = saved.state;
    if (announce) broadcast?.postMessage("changed");
    emit();
    return saved;
  }
  const ready = queue(async () => {
    try {
      await save((current) => current, false);
      if (!closed)
        health({
          status:
            journal?.pending ||
            (journal && journal.revision > journal.acceptedRevision)
              ? "pending"
              : "local",
        });
    } catch (error) {
      health({
        status: "error",
        error: `Read-state storage: ${errorText(error)}`,
      });
    }
  });
  if (broadcast)
    broadcast.onmessage = () => {
      void queue(async () => {
        try {
          await save((current) => current, false);
          reconcileJournal();
        } catch (error) {
          health({ status: "error", error: errorText(error) });
        }
      });
    };
  function reconcileJournal() {
    if (closed || !journal) return;
    if (journal.pending || journal.revision > journal.acceptedRevision) {
      if (journal.revision > attemptedRevision) {
        health({ status: "pending", error: undefined });
        schedule();
      }
    } else if (
      snapshot.status === "pending" ||
      snapshot.status === "accepted" ||
      (failedRevision !== undefined &&
        journal.acceptedRevision >= failedRevision)
    ) {
      failedRevision = undefined;
      health({
        status: journal.lastCreatedAt > 0 ? "reconciled" : "local",
        error: undefined,
      });
    }
  }
  function schedule() {
    if (closed || capability !== "frontier-sync" || timer || publishing) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, debounceMs);
  }
  async function decode(events: readonly RelayEvent[], signal: AbortSignal) {
    if (!host) throw new Error("Read-state decoding unsupported by this host");
    const selected = new Map<string, RelayEvent>();
    for (const event of events) {
      const coordinate = readCoordinate(event);
      if (event.pubkey === viewer && coordinate)
        selected.set(coordinate, newer(selected.get(coordinate), event));
    }
    const result: { event: RelayEvent; parsed: ParsedReadBlob }[] = [];
    const values = [...selected.values()];
    // Host body bounds apply independently from the aggregate snapshot limit.
    for (let index = 0; index < values.length; index += 4) {
      const batch = values.slice(index, index + 4);
      const decoded = await host.decode(batch, signal);
      signal.throwIfAborted();
      if (!Array.isArray(decoded) || decoded.length !== batch.length)
        throw new Error("Incomplete read-state decode");
      const seen = new Set<string>();
      for (const item of decoded) {
        const event = batch.find((event) => event.id === item.eventId);
        if (!event || seen.has(event.id))
          throw new Error("Read-state decode identity mismatch");
        seen.add(event.id);
        result.push({ event, parsed: parseReadBlob(item.blob) });
      }
    }
    return result;
  }
  async function ingest(
    events: readonly RelayEvent[],
    signal: AbortSignal,
    generation = epoch,
  ) {
    const decoded = await decode(events, signal);
    if (closed || generation !== epoch)
      throw new DOMException("Read-state observation cancelled", "AbortError");
    // Merge locally before admitting slot versions. Failed storage must remain retryable.
    await save((current) => {
      if (closed || generation !== epoch)
        throw new DOMException(
          "Read-state observation cancelled",
          "AbortError",
        );
      const state = retainReadState(
        [current.state, ...decoded.map(({ parsed }) => parsed.state)],
        current.recent ?? {},
        current.clientId,
      );
      return {
        ...current,
        state,
        recent: retainReadOrder(state, current.recent ?? {}),
      };
    });
    if (closed || generation !== epoch) return;
    for (const item of decoded) {
      const coordinate = readCoordinate(item.event);
      if (!coordinate) throw new Error("Read-state coordinate missing");
      const old = slots.get(coordinate);
      if (!old || newer(old.event, item.event) === item.event)
        slots.set(coordinate, item);
    }
    if (slots.size > 4096) {
      slots.clear();
      throw new Error("Read-state coordinate capacity exceeded");
    }
  }
  async function refresh(priority: Priority = "background") {
    requested = true;
    if (closed || !host) return;
    if (refreshing) return refreshing;
    const generation = epoch;
    const signal = AbortSignal.any([
      lifetime.signal,
      AbortSignal.timeout(10000),
    ]);
    const task = queue(async () => {
      try {
        await ready;
        if (!journal) throw new Error("Saved read state unavailable");
        const complete = !!host.communityId && !!reader.readStateSnapshot;
        const events =
          complete && reader.readStateSnapshot
            ? await reader.readStateSnapshot({
                signal,
                priority,
                fresh: true,
              })
            : await reader.read(
                [
                  {
                    kinds: [30078],
                    authors: [viewer],
                    "#t": ["read-state"],
                    limit: 500,
                  },
                ],
                { signal, priority },
              );
        await ingest(events, signal, generation);
        if (closed || generation !== epoch) return;
        health({
          status:
            journal.pending || journal.revision > journal.acceptedRevision
              ? "pending"
              : "reconciled",
          completeness: complete ? "snapshot" : "bounded",
          error: undefined,
        });
        if (journal.pending || journal.revision > journal.acceptedRevision)
          schedule();
      } catch (error) {
        if (!closed && generation === epoch)
          health({ status: "error", error: errorText(error) });
      }
    });
    refreshing = task.finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  }
  async function mutate(
    key: string,
    timestamp: number | undefined,
    unread: boolean | undefined,
    valid: () => boolean,
    clearLocalKeys: readonly string[] = [key],
  ): Promise<ReadMutationResult> {
    return queue(async () => {
      await ready;
      if (!journal)
        throw new Error("Saved read state unavailable; retry storage first");
      if (timestamp !== undefined && capability !== "frontier-sync")
        throw new Error("Read-state sync unsupported by this host");
      try {
        const saved = await save((current) => {
          if (!valid()) throw new Error("Reading observation expired");
          if (
            !contextId(key) ||
            (timestamp !== undefined && !uint32(timestamp))
          )
            throw new Error("Invalid read frontier");
          const revision = current.revision + 1;
          const recent =
            timestamp === undefined
              ? (current.recent ?? {})
              : { ...current.recent, [key]: revision };
          const nextState =
            timestamp === undefined
              ? current.state
              : retainReadState(
                  [
                    current.state,
                    { frontiers: { [key]: timestamp }, overrides: {} },
                  ],
                  recent,
                  current.clientId,
                );
          const localUnread = { ...current.localUnread };
          // Automatic observations do not clear explicit local manual-unread intent.
          if (unread === false)
            for (const clearKey of clearLocalKeys) delete localUnread[clearKey];
          if (unread === true) localUnread[key] = revision;
          return {
            ...current,
            revision,
            state: nextState,
            recent: retainReadOrder(nextState, recent),
            localUnread,
            acceptedRevision:
              timestamp === undefined &&
              current.acceptedRevision === current.revision
                ? revision
                : current.acceptedRevision,
          };
        });
        health({
          status: capability === "frontier-sync" ? "pending" : "local",
          error: undefined,
        });
        if (timestamp !== undefined) schedule();
        return {
          operationId: `${saved.slot}:${saved.revision}`,
          durability: "saved",
          sync:
            capability === "frontier-sync" && timestamp !== undefined
              ? "pending"
              : "local-only",
        };
      } catch (error) {
        health({ status: "error", error: errorText(error) });
        throw error;
      }
    });
  }
  async function flush() {
    if (closed || capability !== "frontier-sync" || !lock || !host?.sign)
      return;
    if (publishing) return publishing;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    const signal = AbortSignal.any([
      lifetime.signal,
      AbortSignal.timeout(10000),
    ]);
    const sign = host.sign;
    const task = queue(async () => {
      try {
        await ready;
        attemptedRevision = journal?.revision ?? attemptedRevision;
        await lock(signal, async () => {
          await save((current) => current, false);
          if (!journal) throw new Error("Saved read state unavailable");
          attemptedRevision = journal.revision;
          // An unknown previous outcome must retry the exact saved signed bytes first.
          if (journal.pending) await publishPending(signal);
          if (journal.revision <= journal.acceptedRevision) return;
          const coordinate = `read-state:${journal.slot}`;
          const events = await reader.read(
            [
              {
                kinds: [30078],
                authors: [viewer],
                "#d": [coordinate],
                limit: 500,
              },
            ],
            { signal, priority: "background", fresh: true },
          );
          await ingest(events, signal);
          const own = slots.get(coordinate);
          if (own && own.parsed.clientId !== journal.clientId)
            throw new Error("Read-state slot conflict; publication blocked");
          // This first release does not canonicalize peer overrides on a bounded load.
          if (Object.keys(journal.state.overrides).length)
            throw new Error("Synchronized override publication is not enabled");
          const publishingState = retainReadState(
            [journal.state],
            journal.recent ?? {},
            journal.clientId,
            READ_STATE_PLAINTEXT_BYTES,
          );
          const payload = readBlob(journal.clientId, publishingState, (key) =>
            effectiveFrontier(publishingState, key),
          );
          const createdAt = readVersion(
            now(),
            Math.max(journal.lastCreatedAt, own?.event.created_at ?? 0),
          );
          const revision = journal.revision;
          attemptedRevision = revision;
          const event = await sign(
            { slot: journal.slot, createdAt, blob: payload },
            signal,
          );
          signal.throwIfAborted();
          if (
            event.pubkey !== viewer ||
            readCoordinate(event) !== coordinate ||
            event.created_at !== createdAt
          )
            throw new Error("Read-state signer changed identity or version");
          // Decode signed output too: a host response cannot acknowledge a different plaintext.
          const decoded = await decode([event], signal);
          if (
            decoded[0]?.parsed.clientId !== journal.clientId ||
            !same(decoded[0]?.parsed.state, parseReadBlob(payload).state)
          )
            throw new Error("Read-state signer changed the payload");
          await save((current) => ({
            ...current,
            lastCreatedAt: createdAt,
            pending: { event, revision },
          }));
          await publishPending(signal);
        });
      } catch (error) {
        if (!closed) {
          health({ status: "error", error: errorText(error) });
          failedRevision =
            journal &&
            (journal.pending || journal.revision > journal.acceptedRevision)
              ? journal.revision
              : undefined;
        }
      }
    });
    publishing = task.finally(() => {
      publishing = undefined;
      // Peer intent may have arrived during signing/readback, ahead of its broadcast.
      reconcileJournal();
    });
    return publishing;
  }
  async function publishPending(signal: AbortSignal) {
    const before = journal;
    const pending = before?.pending;
    if (!pending || !before) return;
    if (!host?.publish) throw new Error("Read-state publication unavailable");
    health({ status: "pending", error: undefined });
    await host.publish(pending.event, signal);
    signal.throwIfAborted();
    // Acknowledgement is not coordinate observation. Keep the same signed bytes until readback.
    health({ status: "accepted" });
    const events = await reader.read(
      [
        {
          kinds: [30078],
          authors: [viewer],
          "#d": [`read-state:${before.slot}`],
          limit: 500,
        },
      ],
      { signal, priority: "background", fresh: true },
    );
    await ingest(events, signal);
    const own = slots.get(`read-state:${before.slot}`);
    const payload = (await decode([pending.event], signal))[0]?.parsed;
    if (!payload) throw new Error("Saved read-state decode missing");
    if (
      !own ||
      own.parsed.clientId !== before.clientId ||
      !same(mergeReadStates(own.parsed.state, payload.state), own.parsed.state)
    )
      throw new Error(
        "Read-state accepted; coordinate observation still pending",
      );
    const saved = await save((current) => {
      if (current.pending?.event.id !== pending.event.id) return current;
      const { pending: _pending, ...rest } = current;
      return {
        ...rest,
        acceptedRevision: Math.max(current.acceptedRevision, pending.revision),
      };
    });
    health({
      status:
        saved.revision > saved.acceptedRevision ? "pending" : "reconciled",
      error: undefined,
    });
  }
  return {
    ready,
    snapshot: () => snapshot,
    state: () => state,
    localUnread: (key: string) => journal?.localUnread[key],
    revision: () => journal?.revision ?? 0,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    ensure: () =>
      refreshing ?? (requested ? Promise.resolve() : refresh("foreground")),
    flush,
    read: (
      key: string,
      timestamp: number,
      valid: () => boolean,
      explicit = false,
      clearLocalKeys?: readonly string[],
    ) =>
      mutate(
        key,
        timestamp,
        explicit ? false : undefined,
        valid,
        clearLocalKeys,
      ),
    clearLocalUnread: (
      key: string,
      keys: readonly string[],
      valid: () => boolean,
    ) => mutate(key, undefined, false, valid, keys),
    markLocalUnread: (key: string, valid: () => boolean) =>
      mutate(key, undefined, true, valid),
    accept(events: readonly RelayEvent[]) {
      if (
        closed ||
        !host ||
        !events.some(
          (event) => event.pubkey === viewer && readCoordinate(event),
        )
      )
        return;
      const generation = epoch;
      const signal = AbortSignal.any([
        lifetime.signal,
        AbortSignal.timeout(10000),
      ]);
      void queue(async () => {
        try {
          await ingest(events, signal, generation);
        } catch (error) {
          if (!closed && generation === epoch)
            health({ status: "error", error: errorText(error) });
        }
      });
    },
    stale() {
      epoch++;
      health({ status: "stale", completeness: "unknown" });
    },
    dispose() {
      closed = true;
      epoch++;
      lifetime.abort();
      if (timer) clearTimeout(timer);
      listeners.clear();
      slots.clear();
      broadcast?.close();
      storage.close();
    },
  };
}
