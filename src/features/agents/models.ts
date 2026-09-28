import type { AgentEdit } from "./control";

export interface ModelRequest {
  id?: string | undefined;
  expectedRevision?: number | undefined;
  edit?: AgentEdit | undefined;
  host: string;
  filter: string;
  action: "connect" | "refresh" | "disconnect";
  /** Blank host/filter come from write-only Agent defaults; native supplies them. */
  inheritWorkspace?: boolean;
}
export interface ModelCatalog {
  host: string;
  models: { id: string; name: string }[];
  modelOverridden: boolean;
  disconnected: boolean;
}
export interface ModelHost {
  begin(): Promise<number>;
  run(ticket: number, request: ModelRequest): Promise<ModelCatalog>;
  cancel(ticket: number): Promise<void>;
}
export interface AgentModels {
  request(request: ModelRequest, signal: AbortSignal): Promise<ModelCatalog>;
}

/** Separate lane from Save/Stop. A ticket handshake lets cancellation overtake
 * slow begin responses without launching stale auth work. No passive calls. */
export function createAgentModels(
  host: ModelHost | undefined,
): AgentModels & { dispose(): void } {
  const active = new Set<AbortController>();
  let disposed = false;
  return {
    async request(request, signal) {
      if (!host || disposed)
        throw new Error("Model connections require a rebuilt desktop app.");
      if (signal.aborted) throw new Error("Connection cancelled.");
      const local = new AbortController();
      active.add(local);
      let ticket: number | undefined;
      const cancel = () => local.abort();
      const retire = () => {
        if (ticket !== undefined) void host.cancel(ticket).catch(() => {});
      };
      signal.addEventListener("abort", cancel, { once: true });
      local.signal.addEventListener("abort", retire, { once: true });
      let rejectCancelled: (() => void) | undefined;
      const cancelled = new Promise<never>((_, reject) => {
        rejectCancelled = () => reject(new Error("Connection cancelled."));
        local.signal.addEventListener("abort", rejectCancelled, { once: true });
      });
      const timer = setTimeout(cancel, 185_000);
      try {
        const begun = host.begin().then((value) => {
          ticket = value;
          if (local.signal.aborted || disposed) retire();
          return value;
        });
        ticket = await Promise.race([begun, cancelled]);
        if (local.signal.aborted || disposed) {
          await host.cancel(ticket);
          throw new Error("Connection cancelled.");
        }
        const result = await Promise.race([
          host.run(ticket, request),
          cancelled,
        ]);
        if (local.signal.aborted || disposed)
          throw new Error("Connection cancelled.");
        return result;
      } catch (error) {
        // Native supplies deliberately safe strings. Never surface arbitrary
        // Error contents from the transport or third-party dependencies.
        throw new Error(
          local.signal.aborted
            ? "Connection cancelled."
            : typeof error === "string"
              ? error
              : "Could not load models. Retry explicitly; your model entry is unchanged.",
        );
      } finally {
        clearTimeout(timer);
        if (rejectCancelled)
          local.signal.removeEventListener("abort", rejectCancelled);
        signal.removeEventListener("abort", cancel);
        local.signal.removeEventListener("abort", retire);
        active.delete(local);
        if (ticket !== undefined) void host.cancel(ticket).catch(() => {});
      }
    },
    dispose() {
      disposed = true;
      for (const request of active) request.abort();
      active.clear();
    },
  };
}
