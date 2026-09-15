/** A display-only projection of the existing local Buzz library, not proof of
 * ownership, membership, custody or running state. No prompts/configuration. */
export type AgentLibrary = Readonly<{
  definitions: readonly Readonly<{
    id: string;
    name: string;
    avatar?: string;
  }>[];
  identities: readonly Readonly<{
    pubkey: string;
    name: string;
    avatar?: string;
    definitionId?: string;
  }>[];
}>;
export type AgentLibraryReader = (signal: AbortSignal) => Promise<AgentLibrary>;
export type AgentLibrarySnapshot = AgentLibrary &
  Readonly<{
    status: "unavailable" | "idle" | "loading" | "ready" | "error";
    error?: string;
  }>;
const empty = { definitions: Object.freeze([]), identities: Object.freeze([]) };
export function createAgentLibrary(
  read: AgentLibraryReader | undefined,
  notify = (listener: () => void) => listener(),
) {
  let closed = false;
  let controller: AbortController | undefined;
  let pending: Promise<void> | undefined;
  let snapshot: AgentLibrarySnapshot = {
    ...empty,
    status: read ? "idle" : "unavailable",
  };
  const listeners = new Set<() => void>();
  function publish(next: AgentLibrarySnapshot) {
    snapshot = Object.freeze(next);
    for (const listener of listeners) notify(listener);
  }
  function refresh(): Promise<void> {
    if (closed || !read) return Promise.resolve();
    if (pending) return pending;
    const owned = new AbortController();
    controller = owned;
    publish({ ...snapshot, status: "loading" });
    pending = Promise.resolve()
      .then(() => {
        if (closed || owned.signal.aborted)
          throw new Error("Library read cancelled");
        return read(owned.signal);
      })
      .then((library) => {
        if (!closed && !owned.signal.aborted)
          publish({ ...library, status: "ready" });
      })
      .catch(() => {
        if (!closed && !owned.signal.aborted)
          publish({
            ...snapshot,
            status: "error",
            error:
              "Could not read the current Buzz agent library. Open Buzz and retry; its saved library is left unchanged.",
          });
      })
      .finally(() => {
        if (controller === owned) {
          controller = undefined;
          pending = undefined;
        }
      });
    return pending;
  }
  function clear() {
    controller?.abort();
    controller = undefined;
    pending = undefined;
    publish({ ...empty, status: closed || !read ? "unavailable" : "idle" });
  }
  return {
    queries: Object.freeze({
      snapshot: () => snapshot,
      refresh,
      subscribe(listener: () => void) {
        if (closed) return () => {};
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    }),
    clear,
    dispose() {
      closed = true;
      clear();
      listeners.clear();
    },
  };
}
/** Match legacy buildUnifiedGroups, but show all linked keys rather than choosing
 * a runtime-dependent representative. Unknown archive evidence does not erase
 * library entries, and this grouping never supplies mention recipients. */
export function groupAgentLibrary(
  library: AgentLibrary,
  archived: (key: string) => boolean,
) {
  const selected = new Set(library.definitions.map((row) => row.id));
  const visible = library.identities.filter((row) => !archived(row.pubkey));
  return {
    groups: library.definitions.map((definition) => ({
      ...definition,
      identities: visible.filter(
        (identity) => identity.definitionId === definition.id,
      ),
    })),
    custom: visible.filter((row) => !row.definitionId),
    unknown: visible.filter(
      (row) => row.definitionId && !selected.has(row.definitionId),
    ),
  };
}
