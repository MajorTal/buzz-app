import type {
  SidebarAssignmentMutator,
  SidebarStarMutator,
  SidebarPreferences,
} from "./sidebar-preferences";

type Snapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "error" | "unsupported";
  data?: SidebarPreferences;
  error?: string;
}>;

/** One bounded account-preference projection per relay session, not per page. */
export function createSidebarPreferencesStore(
  read: (signal?: AbortSignal) => Promise<SidebarPreferences>,
  available: boolean,
  write?: SidebarAssignmentMutator,
  writeStar?: SidebarStarMutator,
  notify = (listener: () => void) => listener(),
) {
  const listeners = new Set<() => void>();
  const empty = (): Snapshot =>
    Object.freeze({ status: available ? "idle" : "unsupported" });
  let snapshot = empty();
  let closed = false;
  let active:
    | { controller: AbortController; promise: Promise<void> }
    | undefined;
  let writeQueue = Promise.resolve();
  let writeLifetime = new AbortController();
  let mutation = 0;
  let generation = 0;
  const retained = (data: SidebarPreferences): SidebarPreferences =>
    Object.freeze({
      sections: Object.freeze(
        data.sections.map((section) => Object.freeze({ ...section })),
      ),
      assignments: Object.freeze({ ...data.assignments }),
      starred: Object.freeze([...data.starred]),
    });
  const publish = (next: Snapshot) => {
    snapshot = Object.freeze(next);
    for (const listener of listeners) notify(listener);
  };
  function refresh(): Promise<void> {
    if (closed || !available) return Promise.resolve();
    if (active) return active.promise;
    const controller = new AbortController();
    const refreshMutation = mutation;
    const job = { controller, promise: Promise.resolve() };
    active = job;
    job.promise = Promise.resolve().then(async () => {
      if (closed || controller.signal.aborted) return;
      try {
        const data = await read(controller.signal);
        if (
          closed ||
          controller.signal.aborted ||
          active !== job ||
          mutation !== refreshMutation
        )
          return;
        publish({ status: "ready", data: retained(data) });
      } catch (error) {
        if (
          !closed &&
          !controller.signal.aborted &&
          active === job &&
          mutation === refreshMutation
        )
          publish({
            ...snapshot,
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          });
      } finally {
        if (active === job) active = undefined;
      }
    });
    publish({
      status: "loading",
      ...(snapshot.data ? { data: snapshot.data } : {}),
    });
    return job.promise;
  }
  return {
    queries: Object.freeze({
      available,
      writable: !!write,
      assign(channelId: string, sectionId?: string, signal?: AbortSignal) {
        if (closed || !write || !snapshot.data)
          return Promise.reject(
            new Error("Saved sidebar groups are read-only in this host"),
          );
        const writeGeneration = generation;
        const writeSignal = AbortSignal.any([
          writeLifetime.signal,
          ...(signal ? [signal] : []),
        ]);
        const run = writeQueue
          .catch(() => {})
          .then(async () => {
            if (closed || generation !== writeGeneration)
              throw new Error("Saved sidebar groups are unavailable");
            writeSignal.throwIfAborted();
            const groups = await write(
              { channelId, ...(sectionId ? { sectionId } : {}) },
              writeSignal,
            );
            if (closed || generation !== writeGeneration)
              throw new Error("Saved sidebar groups are unavailable");
            writeSignal.throwIfAborted();
            mutation++;
            const current = snapshot.data;
            publish({
              status: "ready",
              data: retained({
                sections: groups.sections,
                assignments: groups.assignments,
                starred: current?.starred ?? [],
              }),
            });
            return groups;
          });
        writeQueue = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
      starWritable: !!writeStar,
      setStar(channelId: string, starred: boolean, signal?: AbortSignal) {
        if (closed || !writeStar || !snapshot.data)
          return Promise.reject(
            new Error("Sidebar stars are unavailable in this host"),
          );
        const writeGeneration = generation;
        const writeSignal = AbortSignal.any([
          writeLifetime.signal,
          ...(signal ? [signal] : []),
        ]);
        const run = writeQueue
          .catch(() => {})
          .then(async () => {
            if (closed || generation !== writeGeneration)
              throw new Error("Sidebar stars are unavailable");
            writeSignal.throwIfAborted();
            const stars = await writeStar({ channelId, starred }, writeSignal);
            if (closed || generation !== writeGeneration)
              throw new Error("Sidebar stars are unavailable");
            writeSignal.throwIfAborted();
            const current = snapshot.data;
            if (!current) throw new Error("Sidebar stars are unavailable");
            mutation++;
            publish({
              status: "ready",
              data: retained({ ...current, starred: stars }),
            });
            return stars;
          });
        writeQueue = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
      // Keep explicit one-shot reads compatible; views use the retained snapshot.
      read,
      snapshot: () => snapshot,
      subscribe(listener: () => void) {
        if (closed) return () => {};
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      ensure: () =>
        snapshot.status === "idle"
          ? refresh()
          : (active?.promise ?? Promise.resolve()),
      refresh,
    }),
    clear() {
      if (closed) return;
      generation++;
      mutation++;
      writeLifetime.abort();
      writeLifetime = new AbortController();
      active?.controller.abort();
      active = undefined;
      publish(empty());
    },
    dispose() {
      closed = true;
      writeLifetime.abort();
      generation++;
      mutation++;
      active?.controller.abort();
      active = undefined;
      snapshot = empty();
      listeners.clear();
    },
  };
}
