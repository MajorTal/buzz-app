import type { EventTemplate, VerifiedEvent } from "nostr-tools";
import { eventDto } from "./events.ts";
import type { LiveAdmission, LiveCallbacks } from "./live.ts";
import {
  presenceAuthors,
  presenceStatus,
  type PresenceState,
  type PresenceStatus,
} from "./presence-contract.ts";

export class PresenceOwnerDisposed extends Error {
  constructor() {
    super("Presence owner disposed");
    this.name = "PresenceOwnerDisposed";
  }
}

type Route = {
  wire: string;
  authors: string[];
  deadline?: ReturnType<typeof setTimeout>;
};
type Publication = {
  status: PresenceStatus;
  event?: VerifiedEvent;
  signing: boolean;
  sent: boolean;
  release?: () => void;
  finish(error?: unknown): void;
};
const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);
/** Socket-owned ephemeral lane. No reconnect, snapshots, renewal clock or event history.
 * The ordinary route pump calls dispatch only after foreground setup has yielded. */
export function createPresenceLive(host: {
  sign(event: EventTemplate): Promise<VerifiedEvent>;
  viewer: string;
  callbacks: LiveCallbacks;
  admission: LiveAdmission;
  connected(): boolean;
  send(frame: unknown): void;
  wake(): void;
  cooldown(reason: string): boolean | undefined;
}) {
  let closed = false,
    serial = 0,
    failures = 0;
  let desired: string[] = [];
  let confirmed: Route | undefined, candidate: Route | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let due = 0;
  let error: string | undefined;
  let lastState = "";
  let publication: Publication | undefined;
  function notify() {
    if (closed) return;
    const ready = confirmed && same(confirmed.authors, desired);
    const state: PresenceState = Object.freeze({
      status: !desired.length
        ? "idle"
        : ready
          ? "ready"
          : error
            ? "error"
            : "pending",
      authors: Object.freeze([...desired]),
      ...(!ready && desired.length && error ? { error } : {}),
    });
    const key = JSON.stringify(state);
    if (key === lastState) return;
    lastState = key;
    host.callbacks.presenceState?.(state);
  }
  function remove(route: Route | undefined) {
    if (!route) return;
    // Fence first: even a reentrant transport cannot deliver after CLOSE.
    if (confirmed === route) confirmed = undefined;
    if (candidate === route) candidate = undefined;
    clearTimeout(route.deadline);
    host.send(["CLOSE", route.wire]);
  }
  function schedule() {
    if (!due) due = performance.now() + 100;
    notify();
    host.wake();
  }
  function failed(route: Route, reason: string) {
    remove(route);
    error = reason;
    const retryable = host.cooldown(reason);
    failures = retryable === false ? 4 : failures + 1;
    due = performance.now() + 1000 * 2 ** Math.min(failures - 1, 3);
    notify();
    host.wake();
  }
  function dispatch(blocked: boolean) {
    clearTimeout(timer);
    if (closed || !host.connected() || blocked) return;
    const needsRoute =
      desired.length > 0 &&
      !candidate &&
      failures <= 3 &&
      (!confirmed || !same(confirmed.authors, desired));
    const pendingWrite =
      publication && !publication.sent && !publication.signing;
    if (!needsRoute && !pendingWrite) return;
    const routeDelay = needsRoute
      ? Math.max(0, due - performance.now(), host.admission.presenceDelay())
      : Infinity;
    const writeDelay = pendingWrite ? host.admission.publishDelay() : Infinity;
    const delay = Math.min(routeDelay, writeDelay);
    if (delay > 0) {
      timer = setTimeout(host.wake, delay);
      return;
    }
    if (needsRoute && routeDelay === 0) {
      const route: Route = {
        wire: `presence-${++serial}`,
        authors: [...desired],
      };
      candidate = route;
      due = 0;
      host.admission.takePresence();
      route.deadline = setTimeout(() => {
        if (candidate === route)
          failed(route, "Presence setup timed out; retry available");
      }, 10000);
      host.send([
        "REQ",
        route.wire,
        { kinds: [20001], authors: route.authors, limit: 0 },
      ]);
      host.wake();
      return;
    }
    const operation = publication;
    if (!operation || operation.sent || operation.signing) return;
    if (!operation.event) {
      try {
        operation.release = host.admission.acquirePublication();
      } catch (error) {
        operation.finish(error);
        return;
      }
      operation.signing = true;
      const template = {
        kind: 20001,
        content: operation.status,
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      };
      void (async () => {
        const raw = await host.sign(template);
        if (publication !== operation || closed) return;
        const event = eventDto(raw);
        if (
          event.pubkey !== host.viewer ||
          event.kind !== template.kind ||
          event.content !== template.content ||
          event.created_at !== template.created_at ||
          event.tags.length
        )
          throw new Error("Presence signer changed the publication");
        operation.event = event;
      })()
        .catch((error) => operation.finish(error))
        .finally(() => {
          operation.signing = false;
          if (publication !== operation) operation.release?.();
          else host.wake(); // Recheck foreground work and cooldown learned during signing.
        });
      return;
    }
    operation.sent = true;
    host.admission.takePublish();
    host.send(["EVENT", operation.event]);
  }
  return {
    capability: {
      update(input: readonly string[]) {
        const next = presenceAuthors(input);
        if (closed || same(next, desired)) return;
        desired = next;
        if (failures <= 3) error = undefined;
        if (!desired.length) {
          remove(candidate);
          remove(confirmed);
          failures = 0;
          due = 0;
        } else if (confirmed && same(confirmed.authors, desired))
          remove(candidate);
        schedule();
      },
      publish(status: PresenceStatus, signal: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
          presenceStatus(status);
          signal.throwIfAborted();
          if (closed || !host.connected())
            throw new Error("Presence socket is not authenticated");
          if (publication)
            throw new Error("Presence publication already in flight");
          const deadline = setTimeout(
            () =>
              operation.finish(
                new Error(
                  "Presence publication outcome unknown (deadline exceeded)",
                ),
              ),
            10000,
          );
          const abort = () =>
            operation.finish(
              signal.reason ??
                new DOMException("Presence cancelled", "AbortError"),
            );
          const operation: Publication = {
            status,
            signing: false,
            sent: false,
            finish(error) {
              if (publication !== operation) return;
              publication = undefined;
              clearTimeout(deadline);
              signal.removeEventListener("abort", abort);
              if (!operation.signing) operation.release?.();
              if (error === undefined) resolve();
              else reject(error);
            },
          };
          publication = operation;
          signal.addEventListener("abort", abort, { once: true });
          host.wake();
        });
      },
    },
    dispatch,
    message(data: unknown[]) {
      if (closed || !host.connected()) return;
      if (
        data[0] === "OK" &&
        publication?.sent &&
        data[1] === publication.event?.id &&
        typeof data[2] === "boolean"
      ) {
        const reason =
          typeof data[3] === "string"
            ? data[3].slice(0, 512)
            : "Presence publication rejected";
        if (!data[2]) host.cooldown(reason);
        publication.finish(data[2] ? undefined : new Error(reason));
        host.wake();
        return;
      }
      const route =
        candidate?.wire === data[1]
          ? candidate
          : confirmed?.wire === data[1]
            ? confirmed
            : undefined;
      if (!route) return;
      if (data[0] === "EVENT") {
        let event: VerifiedEvent;
        try {
          event = eventDto(data[2]);
        } catch {
          failed(route, "Invalid presence signature");
          return;
        }
        if (
          event.kind === 20001 &&
          route.authors.includes(event.pubkey) &&
          desired.includes(event.pubkey)
        )
          host.callbacks.presence?.([event]);
      } else if (data[0] === "EOSE" && candidate === route) {
        clearTimeout(route.deadline);
        if (!same(route.authors, desired)) {
          remove(route);
          schedule();
          return;
        }
        remove(confirmed);
        confirmed = route;
        candidate = undefined;
        failures = 0;
        error = undefined;
        notify();
        host.wake();
      } else if (data[0] === "CLOSED") {
        failed(
          route,
          typeof data[2] === "string"
            ? data[2].slice(0, 512)
            : "Presence subscription closed",
        );
      }
    },
    retry() {
      failures = 0;
      error = undefined;
      schedule();
    },
    reset(reason: string) {
      clearTimeout(timer);
      // Socket generation owns the wires. No CLOSE on a dead/replaced socket.
      clearTimeout(candidate?.deadline);
      clearTimeout(confirmed?.deadline);
      candidate = confirmed = undefined;
      publication?.finish(new Error(reason));
      error = reason;
      notify();
    },
    dispose() {
      closed = true;
      clearTimeout(timer);
      remove(candidate);
      remove(confirmed);
      // finish owns the winner; later disposal cannot relabel an earlier failure.
      publication?.finish(new PresenceOwnerDisposed());
    },
  };
}
