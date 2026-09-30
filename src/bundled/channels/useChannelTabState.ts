import { useCallback, useSyncExternalStore } from "react";
import type { RelaySession } from "../../features/relay/session";
import type {
  ChannelPanelContext,
  RegisteredPanel,
} from "../../features/panels/service";

export type PanelOpening = {
  channelId: string;
  panel: RegisteredPanel;
  target: string;
  channelContext?: ChannelPanelContext;
};
export type ConversationTab =
  | { id: string; kind: "new" }
  | { id: string; kind: "conversation"; channelId: string }
  | {
      id: string;
      kind: "thread";
      channelId: string;
      messageId: string;
      replyRequest?: number | undefined;
    };
type State = {
  entries: PanelOpening[];
  tabs: ConversationTab[];
  selected: string;
  paneOpen: boolean;
  thread: { channelId: string; messageId: string } | undefined;
  settings: { id: string; channelId: string | undefined } | undefined;
};
const empty: State = {
  entries: [],
  tabs: [],
  selected: "thread",
  paneOpen: true,
  thread: undefined,
  settings: undefined,
};
export const panelTabId = (entry: PanelOpening) =>
  `${entry.panel.key}:${entry.target}`;

// Pages mount and unmount during navigation; their tab descriptors belong to
// the community session. Weak ownership retires them with that session.
const sessions = new WeakMap<RelaySession, ReturnType<typeof createTabStore>>();
function createTabStore() {
  let channels: Record<string, State> = {};
  const listeners = new Set<() => void>();
  return {
    snapshot: () => channels,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update(change: (previous: Record<string, State>) => Record<string, State>) {
      const next = change(channels);
      if (next === channels) return;
      channels = next;
      for (const listener of listeners) listener();
    },
  };
}

/** No credentials, page callbacks, or DOM elements are retained. */
export function useChannelTabState(
  session: RelaySession,
  channelId: string | undefined,
) {
  let store = sessions.get(session);
  if (!store) {
    store = createTabStore();
    sessions.set(session, store);
  }
  const channels = useSyncExternalStore(store.subscribe, store.snapshot);
  const setChannels = store.update;
  const key = channelId ?? "";
  const state = channels[key] ?? empty;
  const update = useCallback(
    (change: (previous: State) => State) => {
      setChannels((all) => {
        const previous = all[key] ?? empty;
        const next = change(previous);
        return next === previous ? all : { ...all, [key]: next };
      });
    },
    [key, setChannels],
  );
  const setEntries = useCallback(
    (entries: PanelOpening[]) => update((s) => ({ ...s, entries })),
    [update],
  );
  const setTabs = useCallback(
    (change: (tabs: ConversationTab[]) => ConversationTab[]) =>
      update((s) => ({ ...s, tabs: change(s.tabs) })),
    [update],
  );
  const select = useCallback(
    (selected: string) =>
      update((s) => ({
        ...s,
        selected,
        ...(selected ? { paneOpen: true } : {}),
      })),
    [update],
  );
  const setThread = useCallback(
    (thread: State["thread"]) =>
      update((s) =>
        s.thread?.channelId === thread?.channelId &&
        s.thread?.messageId === thread?.messageId
          ? s
          : { ...s, thread },
      ),
    [update],
  );
  const setSettings = useCallback(
    (settings: { channelId: string | undefined } | undefined) =>
      update((s) => ({
        ...s,
        settings: settings
          ? s.settings && s.settings.channelId === settings.channelId
            ? s.settings
            : { ...settings, id: crypto.randomUUID() }
          : undefined,
        ...(settings ? { selected: "settings", paneOpen: true } : {}),
      })),
    [update],
  );
  const setPaneOpen = useCallback(
    (paneOpen: boolean) => update((s) => ({ ...s, paneOpen })),
    [update],
  );
  return {
    ...state,
    setEntries,
    setTabs,
    select,
    setThread,
    setSettings,
    setPaneOpen,
  };
}
