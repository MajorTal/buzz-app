import type { RelayEvent } from "./events";

export const CHANNEL_ACTIVITY_KINDS = [9, 40002, 45001, 45003] as const;
const CHANNEL_BATCH = 128;
export type ChannelActivityReader = (
  channelIds: readonly string[],
  signal: AbortSignal,
) => Promise<readonly RelayEvent[]>;

const channelOf = (event: RelayEvent) => {
  const channels = event.tags.filter(([name]) => name === "h");
  return channels.length === 1 ? channels[0]?.[1] : undefined;
};

/** One roster-scoped activity projection. Authoritative reads may clear unchanged
 * values; verified live activity can only advance them. */
export function createChannelActivity(
  read: ChannelActivityReader | undefined,
  notify = (listener: () => void) => listener(),
) {
  let values = new Map<string, number>();
  let generation = 0;
  let revision = 0;
  let closed = false;
  let active: AbortController | undefined;
  const listeners = new Set<() => void>();
  const publish = () => {
    revision++;
    for (const listener of listeners) notify(listener);
  };
  const mergeLive = (events: readonly RelayEvent[]) => {
    if (closed) return;
    let changed = false;
    for (const event of events) {
      if (!CHANNEL_ACTIVITY_KINDS.includes(event.kind as never)) continue;
      const channelId = channelOf(event);
      if (!channelId || event.created_at <= (values.get(channelId) ?? -1))
        continue;
      values.set(channelId, event.created_at);
      changed = true;
    }
    if (changed) publish();
  };
  return {
    last: (channelId: string) => values.get(channelId),
    revision: () => revision,
    subscribe(listener: () => void) {
      if (closed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    accept: mergeLive,
    async refresh(input: readonly string[]) {
      if (closed || !read) return;
      const ids = [...new Set(input)];
      const atStart = new Map(values);
      const epoch = ++generation;
      active?.abort();
      const controller = new AbortController();
      active = controller;
      const refreshed = new Map<string, number>();
      try {
        for (let offset = 0; offset < ids.length; offset += CHANNEL_BATCH) {
          const batch = ids.slice(offset, offset + CHANNEL_BATCH);
          const events = await read(
            batch,
            AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
          );
          if (closed || epoch !== generation) return;
          for (const event of events) {
            const channelId = channelOf(event);
            if (
              channelId &&
              batch.includes(channelId) &&
              CHANNEL_ACTIVITY_KINDS.includes(event.kind as never) &&
              event.created_at > (refreshed.get(channelId) ?? -1)
            )
              refreshed.set(channelId, event.created_at);
          }
        }
      } catch (error) {
        if (closed || controller.signal.aborted || epoch !== generation) return;
        throw error;
      } finally {
        if (active === controller) active = undefined;
      }
      if (closed || epoch !== generation) return;
      const wanted = new Set(ids);
      const next = new Map(values);
      for (const id of ids) {
        const displayed = values.get(id);
        const started = atStart.get(id);
        const result = refreshed.get(id);
        const changedDuringRead = displayed !== started;
        if (
          displayed !== undefined &&
          (result !== undefined ? displayed > result : changedDuringRead)
        )
          continue;
        if (result === undefined) next.delete(id);
        else next.set(id, result);
      }
      for (const id of next.keys()) if (!wanted.has(id)) next.delete(id);
      if (
        next.size === values.size &&
        [...next].every(([id, value]) => values.get(id) === value)
      )
        return;
      values = next;
      publish();
    },
    cancel() {
      generation++;
      active?.abort();
      active = undefined;
    },
    clear() {
      if (closed) return;
      generation++;
      active?.abort();
      active = undefined;
      if (!values.size) return;
      values = new Map();
      publish();
    },
    dispose() {
      closed = true;
      generation++;
      active?.abort();
      active = undefined;
      values.clear();
      listeners.clear();
    },
  };
}
