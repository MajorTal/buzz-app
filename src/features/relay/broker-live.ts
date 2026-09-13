import { observerFrame, observerGeneration } from "../agents/observer";
import { eventDto } from "./events";
import {
  liveChannels,
  liveProvenance,
  type LiveCallbacks,
  type LiveSnapshot,
  type LiveSubscription,
} from "./live";

const MAX_FRAME = 1024 * 1024;
/** A bounded POST body avoids URL/header limits and a second server-side interest registry.
 * A generation owns its fetch, parser, retry and heartbeat; replacing it fences all callbacks. */
export function subscribeBrokerTraffic(
  endpoint: string,
  callbacks: LiveCallbacks,
): LiveSubscription {
  let closed = false,
    generation = 0,
    attempts = 0;
  let channels: string[] = [];
  let priority: string[] = [];
  let priorityPending = false;
  let observer: number | null = null;
  let observerPending = false;
  let controller: AbortController | undefined;
  let streamId: string | undefined;
  let controlPending = false;
  let receiving = false;
  let latest: LiveSnapshot = { status: "connecting", routes: [] };
  const publish = (snapshot: LiveSnapshot) => {
    latest = snapshot;
    callbacks.state(snapshot);
  };
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  const state = (status: LiveSnapshot["status"], error?: string) =>
    publish({ status, routes: [], ...(error ? { error } : {}) });
  function start() {
    if (closed) return;
    const current = ++generation;
    streamId = undefined;
    controlPending = false;
    priorityPending = false;
    observerPending = false;
    receiving = true;
    controller?.abort();
    clearTimeout(retryTimer);
    clearTimeout(heartbeat);
    const owned = new AbortController();
    controller = owned;
    const valid = () =>
      !closed && current === generation && !owned.signal.aborted;
    state("connecting");
    const pulse = () => {
      clearTimeout(heartbeat);
      heartbeat = setTimeout(
        () => owned.abort(new Error("Live broker heartbeat timed out")),
        45000,
      );
    };
    pulse();
    const startingPriority = JSON.stringify(priority);
    const startingObserver = observer;
    void (async () => {
      try {
        const response = await fetch(`${endpoint}/stream`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channels, priority, observer }),
          signal: owned.signal,
        });
        if (!valid()) return;
        if (
          !response.ok ||
          !response.body ||
          !response.headers.get("content-type")?.startsWith("text/event-stream")
        ) {
          if ([400, 401, 403, 413].includes(response.status)) {
            state(
              "error",
              `Live broker rejected subscription (${response.status})`,
            );
            return;
          }
          throw new Error(`Live broker unavailable (${response.status})`);
        }
        const identity = response.headers.get("x-buzz-live-id");
        if (identity !== null && !/^[0-9a-f]{32}$/.test(identity))
          throw new Error("Invalid live broker control identity");
        streamId = identity ?? undefined;
        if (startingPriority !== JSON.stringify(priority)) sendPriority();
        if (startingObserver !== observer) sendObserver();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (valid()) {
            const { value, done } = await reader.read();
            if (!valid()) return;
            if (done) throw new Error("Live broker connection ended");
            pulse();
            buffer += decoder.decode(value, { stream: true });
            while (/\r?\n\r?\n/.test(buffer)) {
              const separator = /\r?\n\r?\n/.exec(buffer);
              if (!separator) break;
              const end = separator.index;
              if (end > MAX_FRAME)
                throw new Error("Live broker frame too large");
              const frame = buffer.slice(0, end);
              buffer = buffer.slice(end + separator[0].length);
              let kind = "message";
              const lines: string[] = [];
              for (const line of frame.split(/\r?\n/)) {
                if (line.startsWith("event:")) kind = line.slice(6).trim();
                else if (line.startsWith("data:"))
                  lines.push(line.slice(5).trimStart());
              }
              if (!lines.length) continue; // Keepalives carry no data.
              const data: unknown = JSON.parse(lines.join("\n"));
              if (!valid()) return;
              if (kind === "message") callbacks.receive([eventDto(data)]);
              else if (kind === "traffic") {
                if (
                  !data ||
                  typeof data !== "object" ||
                  !("event" in data) ||
                  !("provenance" in data)
                )
                  throw new Error("Invalid live traffic envelope");
                callbacks.receive(
                  [eventDto(data.event)],
                  liveProvenance(data.provenance),
                );
              } else if (kind === "observer") {
                const record = data as {
                  frame?: unknown;
                  generation?: unknown;
                };
                if (observer !== null && record.generation === observer)
                  callbacks.observer?.(observerFrame(record.frame), observer);
              } else if (kind === "state") {
                const snapshot = liveSnapshot(data);
                publish(snapshot);
              } else if (kind === "established") {
                const id = channelField(data);
                callbacks.established(id);
              } else if (kind === "denied") {
                const id = channelField(data);
                if (
                  !id ||
                  typeof (data as { reason?: unknown }).reason !== "string"
                )
                  throw new Error("Invalid live denial");
                callbacks.denied(id, (data as { reason: string }).reason);
              }
              if (!valid()) return;
            }
            if (buffer.length > MAX_FRAME)
              throw new Error("Live broker frame too large");
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      } catch (error) {
        if (closed || current !== generation) return;
        state(
          "retrying",
          error instanceof Error ? error.message : "Live broker interrupted",
        );
        if (attempts >= 5) {
          state(
            "error",
            "Live broker reconnect attempts exhausted; retry available",
          );
          return;
        }
        retryTimer = setTimeout(start, 500 * 2 ** attempts++);
      } finally {
        if (current === generation) {
          streamId = undefined;
          receiving = false;
          clearTimeout(heartbeat);
        }
      }
    })();
  }
  function sendPriority() {
    if (closed || !streamId || priorityPending) return;
    const current = generation;
    const sent = JSON.stringify(priority);
    priorityPending = true;
    void fetch(`${endpoint}/stream-priority`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ streamId, channels: priority }),
      signal: AbortSignal.any([
        controller?.signal ?? new AbortController().signal,
        AbortSignal.timeout(5000),
      ]),
    })
      .then((response) => {
        if (!closed && current === generation && !response.ok)
          throw new Error(`Live priority control failed (${response.status})`);
      })
      .catch((error) => {
        if (!closed && current === generation)
          publish({ ...latest, error: String(error) });
      })
      .finally(() => {
        if (current !== generation) return;
        priorityPending = false;
        if (sent !== JSON.stringify(priority)) sendPriority();
      });
  }
  function sendObserver() {
    if (closed || !streamId || observerPending) return;
    const current = generation;
    const sent = observer;
    observerPending = true;
    void fetch(`${endpoint}/stream-observer`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ streamId, observer: sent }),
      signal: AbortSignal.any([
        controller?.signal ?? new AbortController().signal,
        AbortSignal.timeout(5000),
      ]),
    })
      .then((response) => {
        if (!response.ok)
          throw new Error("Activity subscription control failed");
      })
      .catch(() => {
        if (!closed && current === generation) {
          // Unknown control outcome: fence this stream; normal bounded reconnect
          // will capture the latest desired generation (never reset chat on toggle).
          controller?.abort(new Error("Activity subscription interrupted"));
        }
      })
      .finally(() => {
        if (current !== generation) return;
        observerPending = false;
        if (sent !== observer) sendObserver();
      });
  }
  start();
  return {
    observe(value) {
      const next = observerGeneration(value);
      if (closed || observer === next) return;
      observer = next; // Fence old SSE frames synchronously, before the POST completes.
      sendObserver();
    },
    prioritize(input) {
      liveChannels(input);
      const next = [...new Set(input)].slice(0, 64);
      if (closed || JSON.stringify(next) === JSON.stringify(priority)) return;
      priority = next;
      sendPriority();
    },
    update(input) {
      const next = liveChannels(input);
      if (closed || JSON.stringify(next) === JSON.stringify(channels)) return;
      channels = next;
      start();
    },
    retry() {
      if (closed || controlPending) return;
      if (!streamId) {
        // Reconnect only when there is no open broker owner to preserve.
        if (receiving) return;
        attempts = 0;
        start();
        return;
      }
      const current = generation;
      controlPending = true;
      void fetch(`${endpoint}/stream-retry`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ streamId }),
        signal: AbortSignal.any([
          controller?.signal ?? new AbortController().signal,
          AbortSignal.timeout(5000),
        ]),
      })
        .then((response) => {
          if (!closed && current === generation && !response.ok)
            throw new Error(`Live retry control failed (${response.status})`);
        })
        .catch((error) => {
          if (!closed && current === generation)
            publish({
              ...latest,
              error:
                error instanceof Error
                  ? error.message
                  : "Live retry unavailable",
            });
        })
        .finally(() => {
          if (current === generation) controlPending = false;
        });
    },
    dispose() {
      closed = true;
      generation++;
      controller?.abort();
      clearTimeout(retryTimer);
      clearTimeout(heartbeat);
    },
  };
}
function channelField(data: unknown): string | undefined {
  if (!data || typeof data !== "object")
    throw new Error("Invalid live broker notification");
  const id = (data as { channelId?: unknown }).channelId;
  return id === undefined ? undefined : liveChannels([id])[0];
}
function liveSnapshot(value: unknown): LiveSnapshot {
  if (!value || typeof value !== "object")
    throw new Error("Invalid live broker status");
  const snapshot = value as LiveSnapshot;
  if (
    !["connecting", "connected", "retrying", "error"].includes(
      snapshot.status,
    ) ||
    !Array.isArray(snapshot.routes) ||
    // Keep limited channels visible alongside both globals and the optional observer.
    snapshot.routes.length > 1027 ||
    (snapshot.error !== undefined && typeof snapshot.error !== "string")
  )
    throw new Error("Invalid live broker status");
  for (const route of snapshot.routes) {
    if (
      !route ||
      typeof route.id !== "string" ||
      !["pending", "live", "error", "limited"].includes(route.status) ||
      !["unknown", "limited"].includes(route.replay) ||
      (route.error !== undefined && typeof route.error !== "string")
    )
      throw new Error("Invalid live route status");
    channelField(route);
  }
  return Object.freeze({
    ...snapshot,
    routes: Object.freeze(
      snapshot.routes.map((route) => Object.freeze({ ...route })),
    ),
  });
}
