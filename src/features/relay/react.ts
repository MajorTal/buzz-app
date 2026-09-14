import { rowProfileIds } from "./membership";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { ChannelMessage, ChannelQueries } from "./contracts";
import type { ProfileQueries } from "./profile-directory";
import { selectProfiles } from "./profile-selection";

export function useChannelList(queries: ChannelQueries) {
  useEffect(() => queries.ensureList(), [queries]);
  return useSyncExternalStore(
    queries.subscribeList,
    queries.list,
    queries.list,
  );
}
export function useChannelWindow(queries: ChannelQueries, channelId: string) {
  useEffect(() => queries.ensure(channelId), [queries, channelId]);
  const subscribe = useCallback(
    (listener: () => void) => queries.subscribeWindow(channelId, listener),
    [queries, channelId],
  );
  const snapshot = useCallback(
    () => queries.window(channelId),
    [queries, channelId],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
export function useRowProfiles(
  queries: ProfileQueries,
  rows: readonly ChannelMessage[],
) {
  const selection = useMemo(
    () => selectProfiles(queries, [...new Set(rows.flatMap(rowProfileIds))]),
    [queries, rows],
  );
  return useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
}

/** Subscribe to replacement as well as connection readiness; never capture a startup session once. */
export function useRelayConnection(relay: import("./service").RelayData) {
  return useSyncExternalStore(relay.subscribe, relay.snapshot, relay.snapshot);
}
