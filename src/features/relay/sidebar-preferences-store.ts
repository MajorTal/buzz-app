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
  let writing = false;
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
    if (writing) return writeQueue;
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
  // The legacy format uses two coordinates. Keep a move in one session queue,
  // confirm the destination assignment before clearing Star, and expose the new
  // placement only after both writes succeed. Failure is explicitly retryable;
  // this is not an atomic cross-host transaction.
  function move(
    channelId: string,
    destination: { starred: true } | { sectionId?: string },
    signal?: AbortSignal,
  ): Promise<SidebarPreferences> {
    const starring = "starred" in destination;
    if (closed || !snapshot.data || !writeStar || !write)
      return Promise.reject(
        new Error("Sidebar group moves are unavailable in this host"),
      );
    const writeGeneration = generation;
    const writeSignal = AbortSignal.any([
      writeLifetime.signal,
      ...(signal ? [signal] : []),
    ]);
    const check = () => {
      if (closed || generation !== writeGeneration)
        throw new Error("Sidebar group moves are unavailable");
      writeSignal.throwIfAborted();
    };
    const run = writeQueue
      .catch(() => {})
      .then(async () => {
        check();
        mutation++;
        writing = true;
        try {
          // Always re-read/write the assignment on removal, even if the cached
          // projection has no assignment (another client may have added one).
          const groups = starring
            ? undefined
            : await write(
                {
                  channelId,
                  ...(destination.sectionId
                    ? { sectionId: destination.sectionId }
                    : {}),
                },
                writeSignal,
              );
          check();
          const stars = await writeStar(
            { channelId, starred: starring },
            writeSignal,
          );
          check();
          const current = snapshot.data;
          if (!current) throw new Error("Sidebar group moves are unavailable");
          const data = retained({ ...current, ...groups, starred: stars });
          publish({ status: "ready", data });
          return data;
        } catch (error) {
          // A refresh fenced by this move must not leave a permanent loading
          // state if the move fails too. Retain its last confirmed placement.
          if (
            generation === writeGeneration &&
            !closed &&
            snapshot.status === "loading"
          )
            publish({
              ...snapshot,
              status: "error",
              error: error instanceof Error ? error.message : String(error),
            });
          throw error;
        } finally {
          if (generation === writeGeneration) {
            mutation++;
            writing = false;
          }
        }
      });
    writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  return {
    queries: Object.freeze({
      available,
      writable: !!write && !!writeStar,
      assign(channelId: string, sectionId?: string, signal?: AbortSignal) {
        return move(channelId, sectionId ? { sectionId } : {}, signal);
      },
      starWritable: !!write && !!writeStar,
      async setStar(channelId: string, starred: boolean, signal?: AbortSignal) {
        const data = await move(
          channelId,
          starred ? { starred: true } : {},
          signal,
        );
        return data.starred;
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
      writing = false;
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
      writing = false;
      mutation++;
      active?.controller.abort();
      active = undefined;
      snapshot = empty();
      listeners.clear();
    },
  };
}
