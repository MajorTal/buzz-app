import { isWorkflowOperation } from "../workflows/protocol";
import { yieldToHost } from "./yield";
import { getEventHash, type EventTemplate } from "nostr-tools";
import { eventDto, type EventData, type RelayEvent } from "./events";
import type { RelayWriter } from "./transport";
import { ByteLru, byteSize } from "./budget";
import { createRelayProfiler, type RelayProfiler } from "./profiling";

export type Delivery = "sending" | "accepted" | "unknown" | "failed" | "seen";
export type OutgoingEvent = Readonly<{
  event: EventData;
  signed?: RelayEvent;
  delivery: Delivery;
  error?: string | undefined;
}>;
export interface Outbox {
  /** Outstanding operations only. Confirmed events live in the session's retained data. */
  snapshot(): readonly OutgoingEvent[];
  subscribe(listener: () => void): () => void;
  supports(kind: number): boolean;
  send(input: Pick<EventTemplate, "kind" | "content" | "tags">): string;
  retry(id: string): void;
  dismiss(id: string): Promise<void>;
}
export type LocalEvents = Pick<Outbox, "snapshot" | "subscribe">;
export interface OutboxStorage {
  close?(): void;
  load(): readonly OutgoingEvent[] | Promise<readonly OutgoingEvent[]>;
  save(operations: readonly OutgoingEvent[]): void | Promise<void>;
}
export class PublishRejected extends Error {}

export { browserOutboxStorage } from "./outbox-storage";
const abortError = () => new DOMException("Relay session closed", "AbortError");
const MAX_PENDING = 256;
const MAX_CONFIRMED = 2048;

/** One journal owns pending delivery and bounded confirmed retention. Views receive one change stream. */
export function createOutbox(
  viewer: string,
  writer: RelayWriter,
  storage: OutboxStorage,
  {
    timeoutMs = 10_000,
    onAccepted = (_event: RelayEvent) => {},
    profiling = createRelayProfiler(),
    notifyListener = (listener: () => void) => listener(),
    preparePublish,
    needsReceipt = () => false,
    onReceipt = (_event: EventData, _message: string | undefined) => {},
  }: {
    timeoutMs?: number;
    /** Commands await their receipt even after a verified echo. Never persisted. */
    needsReceipt?: (event: EventData) => boolean;
    onReceipt?: (event: EventData, message: string | undefined) => void;
    onAccepted?: (event: RelayEvent) => void;
    profiling?: RelayProfiler;
    notifyListener?: (listener: () => void) => void;
    /** Read-only pre-dispatch work under the attempt deadline. The returned
     * synchronous check runs with no await between it and publisher entry. */
    preparePublish?: (
      event: RelayEvent,
      signal: AbortSignal,
    ) => Promise<(() => void) | undefined>;
  } = {},
) {
  const awaitsReceipt = needsReceipt;
  let snapshot: readonly OutgoingEvent[] = Object.freeze([]);
  let visible: readonly OutgoingEvent[] = snapshot;
  let finalSnapshot: readonly OutgoingEvent[] | undefined;
  let finalVisible: readonly OutgoingEvent[] | undefined;
  const completed = new ByteLru<OutgoingEvent>(MAX_CONFIRMED, 8 * 1024 * 1024);
  const sizes = new WeakMap<OutgoingEvent, number>();
  let pendingBytes = 0;
  const listeners = new Set<() => void>();
  const localListeners = new Set<() => void>();
  /** One record per queued or active delivery. Its deadline starts at enqueue; a
   * controller exists only while the attempt is signing or publishing. */
  type Attempt = {
    expiresAt: number;
    /** A failed retry cannot disprove an earlier dispatched/accepted attempt. */
    previousDelivery: Delivery;
    timer: ReturnType<typeof setTimeout>;
    intent?: Promise<void>;
    controller?: AbortController;
  };
  const attempts = new Map<string, Attempt>();
  const inflight = () =>
    [...attempts.values()].filter((attempt) => attempt.controller).length;
  let closed = false;
  let confirmedInvalidated = false;
  let storageError: string | undefined;
  let durable = Promise.resolve();
  const notify = () => {
    pendingBytes = snapshot.reduce(
      (sum, item) => {
        let size = sizes.get(item);
        if (size === undefined) {
          size = byteSize(item);
          sizes.set(item, size);
        }
        return sum + size;
      },
      2 + Math.max(0, snapshot.length - 1),
    );
    visible = Object.freeze([
      ...completed.entries().map(([, item]) => item),
      ...snapshot,
    ]);
    for (const listener of localListeners) notifyListener(listener);
    for (const listener of listeners) notifyListener(listener);
  };
  const persist = (id: string) => {
    const queued = profiling.start("outbox.queue", id);
    const work = durable
      .catch(() => {})
      .then(() => ready)
      .then(() => {
        if (storageError) {
          queued("error");
          throw new Error(storageError);
        }
        queued();
        // Hydration may have added restored intent while this commit waited.
        // Commit current state so no intermediate transaction erases that intent.
        const records = visible;
        const bytes = pendingBytes;
        return profiling.measureAsync("outbox.persist", id, async () => {
          if (bytes > 2 * 1024 * 1024)
            throw new Error("Outbox storage is full");
          await storage.save(records);
        });
      });
    durable = work;
    return work;
  };
  const find = (id: string) => snapshot.find((item) => item.event.id === id);
  function replace(item: OutgoingEvent) {
    snapshot = Object.freeze(
      snapshot.map((old) =>
        old.event.id === item.event.id ? Object.freeze(item) : old,
      ),
    );
    notify();
  }
  function saveStatus(item: OutgoingEvent) {
    replace(item);
    void persist(item.event.id).catch(() => {
      /* Durable intent restores as unknown. */
    });
  }
  function validateSaved(loaded: readonly OutgoingEvent[]) {
    if (
      !Array.isArray(loaded) ||
      loaded.length > MAX_PENDING + MAX_CONFIRMED ||
      byteSize(loaded) > 10 * 1024 * 1024
    )
      throw new Error("Saved outbox exceeds its budget");
  }
  function decode(item: OutgoingEvent): OutgoingEvent {
    const signed = item.signed
      ? eventDto(JSON.parse(JSON.stringify(item.signed)))
      : undefined;
    const event = signed ?? item.event;
    if (!event || event.pubkey !== viewer || getEventHash(event) !== event.id)
      throw new Error("Saved outbox event is invalid");
    return Object.freeze({
      event: Object.freeze({
        ...event,
        tags: Object.freeze(
          event.tags.map((tag: string[]) => Object.freeze([...tag])),
        ) as unknown as string[][],
      }),
      ...(signed ? { signed } : {}),
      delivery:
        item.delivery === "seen" && signed
          ? "seen"
          : item.delivery === "failed"
            ? "failed"
            : "unknown",
      ...(item.error ? { error: item.error } : {}),
    });
  }
  function restore(restored: readonly OutgoingEvent[]) {
    const pending = restored.filter((item) => item.delivery !== "seen");
    if (pending.length > MAX_PENDING)
      throw new Error("Saved pending outbox exceeds its budget");
    for (const item of restored)
      if (item.delivery === "seen" && !confirmedInvalidated)
        completed.set(item.event.id, item);
    snapshot = Object.freeze([...pending, ...snapshot]);
    notify();
  }
  const loadedTiming = profiling.start("outbox.load", "journal");
  let ready: Promise<void>;
  try {
    const loaded = storage.load();
    if (loaded instanceof Promise)
      ready = loaded.then(async (records) => {
        validateSaved(records);
        const decoded: OutgoingEvent[] = [];
        for (let offset = 0; offset < records.length; offset += 12) {
          decoded.push(...records.slice(offset, offset + 12).map(decode));
          if (offset + 12 < records.length) await yieldToHost();
        }
        restore(decoded);
      });
    else {
      validateSaved(loaded);
      restore(loaded.map(decode));
      ready = Promise.resolve();
    }
  } catch (error) {
    ready = Promise.reject(error);
  }
  ready = ready.then(
    () => loadedTiming(),
    (error) => {
      loadedTiming("error");
      storageError = `Could not load the outbox: ${String(error)}`;
    },
  );

  function expire(id: string) {
    const attempt = attempts.get(id);
    if (!attempt) return;
    const error = new Error("Delivery timed out; check or retry this message");
    if (attempt.controller) attempt.controller.abort(error);
    else {
      clearTimeout(attempt.timer);
      attempts.delete(id);
      const item = find(id);
      if (!closed && item) {
        if (awaitsReceipt(item.event)) onReceipt(item.event, undefined);
        saveStatus({
          ...item,
          delivery: failedDelivery(attempt),
          error: error.message,
        });
      }
    }
  }
  function failedDelivery(attempt: Attempt): Delivery {
    return attempt.previousDelivery === "unknown" ||
      attempt.previousDelivery === "accepted" ||
      attempt.previousDelivery === "seen"
      ? attempt.previousDelivery
      : "failed";
  }
  function schedule(
    id: string,
    intent?: Promise<void>,
    previousDelivery: Delivery = "failed",
  ) {
    if (closed || attempts.has(id)) return;
    attempts.set(id, {
      expiresAt: Date.now() + timeoutMs,
      previousDelivery,
      timer: setTimeout(() => expire(id), timeoutMs),
      ...(intent ? { intent } : {}),
    });
    void deliver(id);
  }
  async function deliver(id: string) {
    const attempt = attempts.get(id);
    if (closed || !attempt || attempt.controller || inflight() >= 3) return;
    if (!find(id)) return;
    if (Date.now() >= attempt.expiresAt) {
      expire(id);
      return;
    }
    const controller = new AbortController();
    attempt.controller = controller;
    const signal = controller.signal;
    let publishing = false;
    const total = profiling.start("send.delivery", id);
    const aborted = new Promise<never>((_, reject) =>
      signal.addEventListener(
        "abort",
        () => reject(signal.reason ?? abortError()),
        { once: true },
      ),
    );
    try {
      await Promise.race([
        attempt.intent ??
          ready.then(() => {
            if (storageError) throw new Error(storageError);
            return persist(id);
          }),
        aborted,
      ]);
      if (storageError) throw new Error(storageError);
      const initial = find(id);
      if (!initial || closed || signal.aborted) return;
      const signedResult =
        initial.signed ??
        (await profiling.measureAsync("send.sign", id, () =>
          Promise.race([writer.sign(initial.event, signal), aborted]),
        ));
      const signed = profiling.measure("send.verify", id, () =>
        eventDto(signedResult),
      );
      if (closed || signal.aborted) throw abortError();
      if (signed.id !== id || signed.pubkey !== viewer)
        throw new Error("Signer changed the outgoing event");
      const current = find(id);
      if (!current) return; // A verified echo already completed delivery.
      replace({ ...current, signed });
      await Promise.race([persist(id), aborted]);
      if (closed || signal.aborted || !find(id)) return;
      const check = preparePublish
        ? await profiling.measureAsync("send.prepare", id, () =>
            Promise.race([preparePublish(signed, signal), aborted]),
          )
        : undefined;
      // Preparation cannot make delivery uncertain. Only entering the actual
      // transport publisher crosses that boundary, including for signed retries.
      if (closed || !find(id)) return;
      signal.throwIfAborted();
      const receipt = await profiling.measureAsync("send.publish", id, () => {
        check?.();
        publishing = true;
        return Promise.race([writer.publish(signed, signal), aborted]);
      });
      if (closed || signal.aborted) return;
      if (awaitsReceipt(signed))
        onReceipt(signed, typeof receipt === "string" ? receipt : undefined);
      const latest = find(id);
      if (latest)
        saveStatus({
          ...latest,
          delivery:
            latest.delivery === "seen" || attempt.previousDelivery === "seen"
              ? "seen"
              : "accepted",
          error: undefined,
        });
      onAccepted(signed);
    } catch (error) {
      const latest = find(id);
      // A verified observation ends the attempt even if its HTTP ACK never arrives.
      total(!closed && !latest ? "ok" : "error");
      if (closed) return;
      if (latest && awaitsReceipt(latest.event))
        onReceipt(latest.signed ?? latest.event, undefined);
      if (latest)
        saveStatus({
          ...latest,
          delivery:
            latest.delivery === "seen" || attempt.previousDelivery === "seen"
              ? "seen"
              : attempt.previousDelivery === "accepted"
                ? "accepted"
                : publishing && !(error instanceof PublishRejected)
                  ? "unknown"
                  : failedDelivery(attempt),
          error: awaitsReceipt(latest.event)
            ? publishing && !(error instanceof PublishRejected)
              ? "Workflow delivery could not be confirmed; inspect recent activity before submitting another command."
              : "Workflow command rejected; retain the draft and refresh the saved configuration."
            : `${
                attempt.previousDelivery === "unknown" ||
                attempt.previousDelivery === "accepted"
                  ? error instanceof PublishRejected
                    ? "Retry blocked: "
                    : "Retry failed: "
                  : ""
              }${error instanceof Error ? error.message : String(error)}`,
        });
      if (publishing && latest?.signed && !(error instanceof PublishRejected))
        onAccepted(latest.signed);
    } finally {
      total();
      clearTimeout(attempt.timer);
      if (attempts.get(id) === attempt) attempts.delete(id);
      const observed = find(id);
      if (!closed && observed?.delivery === "seen") {
        completed.set(id, observed);
        snapshot = Object.freeze(
          snapshot.filter((item) => item.event.id !== id),
        );
        notify();
        void persist(id).catch(() => {});
      }
      if (!closed)
        for (const queued of snapshot)
          if (queued.delivery === "sending") void deliver(queued.event.id);
    }
  }
  const subscribe = (set: Set<() => void>, listener: () => void) => {
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  };
  const outbox: Outbox = Object.freeze({
    snapshot: () => finalSnapshot ?? snapshot,
    subscribe: (listener: () => void) => subscribe(listeners, listener),
    supports: (kind: number) =>
      !closed && (!writer.kinds || writer.kinds.includes(kind)),
    send(input: Pick<EventTemplate, "kind" | "content" | "tags">) {
      if (closed) throw abortError();
      if (storageError) throw new Error(storageError);
      if (
        !Number.isInteger(input.kind) ||
        input.kind < 0 ||
        input.kind > 65535 ||
        !outbox.supports(input.kind)
      )
        throw new Error("This relay connection cannot publish that event kind");
      if (
        (input.kind === 9 && !input.content.trim()) ||
        byteSize(input) > 32 * 1024
      )
        throw new Error("Message is empty or too large");
      if (snapshot.length >= MAX_PENDING)
        throw new Error(
          "Too many outstanding operations; resolve or dismiss a pending operation",
        );
      const template = {
        ...input,
        pubkey: viewer,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ...input.tags.map((tag) => [...tag]),
          ["client-id", crypto.randomUUID()],
        ],
      };
      const event = Object.freeze({
        ...template,
        tags: Object.freeze(
          template.tags.map((tag) => Object.freeze(tag)),
        ) as unknown as string[][],
        id: getEventHash(template),
      });
      profiling.measure("send.local", event.id, () => {
        snapshot = Object.freeze([
          ...snapshot,
          Object.freeze({ event, delivery: "sending" as const }),
        ]);
        notify();
      });
      const intent = ready.then(() => {
        if (storageError) throw new Error(storageError);
        return persist(event.id);
      });
      void intent.catch(() => {}); // Delivery reports persistence errors; disposal still saves queued intent.
      schedule(event.id, intent);
      return event.id;
    },
    retry(id: string) {
      const item = find(id);
      // Workflow recovery is inspect/dismiss only, including restored intents.
      if (
        !closed &&
        item &&
        !isWorkflowOperation(item.event) &&
        !attempts.has(id)
      ) {
        replace({ ...item, delivery: "sending", error: undefined });
        schedule(id, undefined, item.delivery);
      }
    },
    async dismiss(id: string) {
      if (closed || attempts.has(id)) return;
      const retained = completed.peek(id);
      const previous =
        find(id) ??
        (retained && awaitsReceipt(retained.event) ? retained : undefined);
      if (previous && awaitsReceipt(previous.event)) completed.delete(id);
      snapshot = Object.freeze(snapshot.filter((item) => item.event.id !== id));
      notify();
      try {
        await persist(id);
      } catch (error) {
        if (!closed && previous && !find(id)) {
          snapshot = Object.freeze([...snapshot, previous]);
          notify();
          void persist(id).catch(() => {});
        }
        throw error;
      }
    },
  });
  return {
    outbox,
    local: Object.freeze({
      snapshot: () => finalVisible ?? visible,
      subscribe: (listener: () => void) => subscribe(localListeners, listener),
    }),
    ready,
    /** Fetched/confirmed evidence is disposable; pending intent is not. A revoke
     * during async hydration fences that old confirmed cache, not its writes. */
    purgeConfirmed(keep: (event: EventData) => boolean) {
      confirmedInvalidated = true;
      const removed = completed
        .entries()
        .filter(([, item]) => !keep(item.event))
        .map(([id]) => id);
      for (const id of removed) completed.delete(id);
      if (removed.length) notify();
      // Queue behind hydration so a revoke cannot be undone by an old disk load.
      void persist("access-revoked").catch(() => {});
    },
    observe(events: readonly RelayEvent[]) {
      if (closed) return;
      const byId = new Map(events.map((event) => [event.id, event]));
      const confirmed = snapshot.flatMap((item) => {
        const event = byId.get(item.event.id);
        return event ? [event] : [];
      });
      const [first] = confirmed;
      if (!first) return;
      for (const event of confirmed) {
        if (awaitsReceipt(event) && attempts.has(event.id)) {
          snapshot = Object.freeze(
            snapshot.map((item) =>
              item.event.id === event.id
                ? Object.freeze({
                    ...item,
                    signed: event,
                    delivery: "seen" as const,
                  })
                : item,
            ),
          );
        } else
          completed.set(
            event.id,
            Object.freeze({ event, signed: event, delivery: "seen" }),
          );
      }
      snapshot = Object.freeze(
        snapshot.filter(
          (item) =>
            !byId.has(item.event.id) ||
            (awaitsReceipt(item.event) && attempts.has(item.event.id)),
        ),
      );
      for (const event of confirmed) {
        if (awaitsReceipt(event) && attempts.has(event.id)) continue;
        const attempt = attempts.get(event.id);
        attempt?.controller?.abort();
        clearTimeout(attempt?.timer);
        attempts.delete(event.id);
      }
      notify();
      void persist(first.id).catch(() => {});
    },
    dispose() {
      if (closed) return;
      finalSnapshot = snapshot;
      finalVisible = visible;
      closed = true;
      for (const attempt of attempts.values()) {
        attempt.controller?.abort(abortError());
        clearTimeout(attempt.timer);
      }
      attempts.clear();
      listeners.clear();
      localListeners.clear();
      void ready
        .then(() => durable)
        .catch(() => {})
        .finally(() => storage.close?.());
    },
  };
}
