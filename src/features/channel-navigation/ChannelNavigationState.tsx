import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useRef,
  type RefObject,
  type ReactNode,
} from "react";
import { useRelayConnection } from "../relay/react";
import type { RelayData } from "../relay/service";
import type { RelaySession } from "../relay/session";
import type { ChannelSummary } from "../relay/contracts";
import type { ChannelLifecycleAction } from "../relay/channel-lifecycle-protocol";
import { readView, writeView } from "../../shared/view-state";

type PreparingDm = { existing: Set<string>; members: Set<string | undefined> };
type State = {
  session: RelaySession;
  scope: string;
  draftParents: string[];
  preparingDm: PreparingDm | undefined;
  lifecycleDialog:
    | {
        channel: ChannelSummary;
        action: ChannelLifecycleAction;
        trigger?: HTMLElement;
      }
    | undefined;
};
type ActivityThread = {
  channelId: string;
  rootId: string;
  trigger: HTMLElement | null;
};
type Handoff = State & {
  activityThread: RefObject<ActivityThread | undefined>;
  updateDraftParents(update: (previous: string[]) => string[]): void;
  prepareDm(members: readonly string[]): void;
  clearPreparingDm(): void;
  openLifecycle(
    channel: ChannelSummary,
    action: ChannelLifecycleAction,
    trigger?: HTMLElement,
  ): void;
  closeLifecycle(): void;
};
const ChannelNavigationContext = createContext<Handoff | undefined>(undefined);
export const useChannelNavigation = () => useContext(ChannelNavigationContext);

// UI intent shared by the persistent sidebar and the visible conversation page.
// Session replacement resets this state, not the independent page subtree.
export function ChannelNavigationProvider({
  relay,
  children,
}: {
  relay: RelayData;
  children: ReactNode;
}) {
  const connection = useRelayConnection(relay);
  const scope = connection.scope ?? "disconnected";
  const activityThread = useRef<ActivityThread | undefined>(undefined);
  const [state, setState] = useState<State>(() =>
    restore(connection.session, scope),
  );
  if (state.session !== connection.session || state.scope !== scope) {
    activityThread.current = undefined;
    setState(restore(connection.session, scope));
  }
  const update = useCallback(
    (change: (previous: State) => State) => {
      // Retired page/dialog completions cannot mutate a replacement session.
      if (relay.snapshot().session !== connection.session) return;
      setState((previous) =>
        previous.session === connection.session ? change(previous) : previous,
      );
    },
    [relay, connection.session],
  );
  const clearPreparingDm = useCallback(() => {
    update((previous) =>
      previous.preparingDm ? { ...previous, preparingDm: undefined } : previous,
    );
  }, [update]);
  const value = useMemo<Handoff>(
    () => ({
      ...state,
      activityThread,
      updateDraftParents(change) {
        update((previous) => {
          const draftParents = change(previous.draftParents);
          writeView(previous.scope, "sessions:channel-drafts", draftParents);
          return { ...previous, draftParents };
        });
      },
      prepareDm(members) {
        // Capture before the caller starts opening the DM, not in a deferred updater.
        const existing = new Set(
          connection.session.channels
            .list()
            .channels.map((channel) => channel.id),
        );
        update((previous) => ({
          ...previous,
          preparingDm: {
            existing: previous.preparingDm?.existing ?? existing,
            members: new Set([connection.viewer, ...members]),
          },
        }));
      },
      openLifecycle(channel, action, trigger) {
        update((previous) =>
          previous.lifecycleDialog
            ? previous
            : {
                ...previous,
                lifecycleDialog: {
                  channel,
                  action,
                  ...(trigger ? { trigger } : {}),
                },
              },
        );
      },
      closeLifecycle() {
        update((previous) => ({ ...previous, lifecycleDialog: undefined }));
      },
      clearPreparingDm,
    }),
    [state, connection.session, connection.viewer, update, clearPreparingDm],
  );
  return (
    <ChannelNavigationContext value={value}>
      {children}
    </ChannelNavigationContext>
  );
}
function restore(session: RelaySession, scope: string): State {
  const saved = readView<unknown>(scope, "sessions:channel-drafts", []);
  return {
    session,
    scope,
    preparingDm: undefined,
    lifecycleDialog: undefined,
    draftParents: Array.isArray(saved)
      ? saved.filter((id): id is string => typeof id === "string")
      : [],
  };
}
