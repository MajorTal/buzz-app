import type { PresenceActivity } from "../presence/activity";
import type { Context } from "@deepseek-ai/cordis";
import { createRelaySession, type RelaySession } from "./session";
import { createHeadPersistence } from "./persistence";
import type { ReadTransport } from "./transport";

export type RelaySnapshot = Readonly<{
  status: "disconnected" | "connecting" | "ready" | "error";
  generation: number;
  scope?: string;
  session: RelaySession;
  viewer?: string;
  error?: string;
}>;
export type RelayData = {
  snapshot(): RelaySnapshot;
  subscribe(listener: () => void): () => void;
  retry(): void;
  disconnect(): void;
  clearCache(): Promise<void>;
};
declare module "@deepseek-ai/cordis" {
  interface Context {
    relay: RelayData;
  }
}

/** App-owned session. Plugins receive read models, never a signer or transport.
 * Reconnection replaces the session and invalidates all old async work. */
export function provideRelay(
  ctx: Context,
  connect?: (signal: AbortSignal) => Promise<ReadTransport>,
  presenceActivity?: PresenceActivity,
) {
  let disposed = false;
  let generation = 0;
  let controller: AbortController | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let store = createRelaySession(null);
  let snapshot: RelaySnapshot = Object.freeze({
    status: "disconnected",
    generation,
    session: store.session,
  });
  const listeners = new Set<() => void>();
  const publish = (next: RelaySnapshot) => {
    snapshot = Object.freeze(next);
    for (const listener of listeners) listener();
  };
  const reset = () => {
    generation++;
    controller?.abort();
    clearTimeout(deadline);
    store.dispose();
    store = createRelaySession(null);
  };
  const service: RelayData = {
    snapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retry() {
      if (disposed || !connect || snapshot.status === "connecting") return;
      reset();
      const current = generation;
      controller = new AbortController();
      const signal = controller.signal;
      publish({ status: "connecting", generation, session: store.session });
      const timer = setTimeout(() => {
        if (disposed || current !== generation) return;
        controller?.abort();
        publish({
          status: "error",
          generation,
          session: store.session,
          error: "Relay connection timed out. Try again.",
        });
      }, 8_000);
      deadline = timer;
      void Promise.resolve()
        .then(() => connect(signal))
        .then(
          (transport) => {
            if (disposed || signal.aborted || current !== generation) return;
            store.dispose();
            store = createRelaySession(transport, {
              ...(presenceActivity ? { presenceActivity } : {}),
              prepared: true,
              warm: true,
              persistence: createHeadPersistence(
                transport.viewer,
                transport.scope ?? transport.relayAuthor,
              ),
            });
            publish({
              status: "ready",
              generation,
              viewer: transport.viewer,
              scope: `${transport.scope ?? transport.relayAuthor}:${transport.viewer}`,
              session: store.session,
            });
            store.session.channels.ensureList();
          },
          (error) => {
            if (disposed || signal.aborted || current !== generation) return;
            publish({
              status: "error",
              generation,
              session: store.session,
              error: String(error),
            });
          },
        )
        .finally(() => clearTimeout(timer));
    },
    disconnect() {
      if (disposed) return;
      reset();
      publish({ status: "disconnected", generation, session: store.session });
    },
    async clearCache() {
      await store.clearCache();
    },
  };
  ctx.provide("relay", service);
  ctx.effect(() => {
    const visible = () => {
      if (document.visibilityState === "visible")
        store.session.channels.refreshList?.();
    };
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      reset();
      listeners.clear();
      if (typeof document !== "undefined")
        document.removeEventListener("visibilitychange", visible);
    };
  });
  service.retry();
  return service;
}
