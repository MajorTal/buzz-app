import { useChannelPanels } from "./useChannelPanels";
import type { PageNavigation } from "../../features/navigation/service";
import type { Navigation } from "../../features/navigation/controller";
import {
  buzzLinkTarget,
  isBuzzLink,
} from "../../features/navigation/buzz-links";
import { ChannelSidebarRow } from "./ChannelSidebarRow";
import { NewSessionComposer } from "../../features/sessions/NewSessionComposer";
import {
  NewSessionView,
  SessionHeading,
} from "../../features/sessions/SessionPresentation";
import { UnreadBadge, UnreadOptions } from "./UnreadBadge";
import { SidebarUnread } from "./SidebarUnread";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  Hash,
  Search,
  MoreHorizontal,
  PlugZap,
  MessageCircle,
  Users,
} from "lucide-react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import {
  useChannelList,
  useChannelWindow,
  useRelayConnection,
} from "../../features/relay/react";
import type { Panels, RegisteredPanel } from "../../features/panels/service";
import { PanelCard } from "../../features/panels/PanelCard";
import { PanelFrame } from "../../features/panels/PanelFrame";
import { OutboxStatus } from "./OutboxStatus";
import { RelayTimings } from "./RelayTimings";
import { LiveStatus } from "./LiveStatus";
import { MessageComposer } from "../../features/messages/MessageComposer";
import { ChannelTimeline } from "../../features/messages/ChannelTimeline";
import { ThreadPanel } from "../../features/messages/ThreadPanel";
import { readView, writeView } from "../../shared/view-state";
import { useChannelLabels } from "./useChannelLabels";
import { useSidebarPreferences } from "./useSidebarPreferences";
import { useSidebarView } from "./useSidebarView";
import { sidebarSections } from "./sidebar-sections";
import styles from "./Channels.module.css";

export function ChannelsPage({
  extensions,
  relay,
  panels,
  companion,
  navigation,
  navigator,
}: {
  extensions?: ConversationExtensions | undefined;
  relay: RelayData;
  navigation?: PageNavigation | undefined;
  navigator?: Navigation | undefined;
  panels: Panels;
  companion?: ReactNode;
}) {
  const session = useRelayConnection(relay);
  const sessionNavigation = navigation?.forSession(relay, session);
  useEffect(() => {
    if (!navigation || !sessionNavigation) return;
    if (session.status === "disconnected" && navigation.target.kind === "page")
      sessionNavigation.complete({ status: "opened" });
    else if (session.status === "error")
      sessionNavigation.complete({ status: "failed", reason: "unavailable" });
  }, [navigation, sessionNavigation, session.status]);
  return (
    <section className={styles.root} aria-label="Channels">
      {session.status !== "ready" ? (
        <PanelFrame companion={companion}>
          <div className={styles.connect}>
            <div className={styles.connectIcon}>
              <PlugZap size={30} />
            </div>
            <h1>Your channels, one conversation.</h1>
            <p>
              {session.status === "connecting"
                ? "Connecting to your relay…"
                : (session.error ??
                  "Use Switch community at the top left to choose or add a community. Your profile and settings work without a community.")}
            </p>
            {session.status === "error" && (
              <>
                <button type="button" onClick={relay.retry}>
                  Connect relay
                </button>
                <p className={styles.note}>
                  For development, set <code>BUZZ_DEV_VIEWER</code> to your Buzz
                  public key in <code>.env.local</code>, then restart{" "}
                  <code>just web</code> or <code>just desktop</code>. See
                  README.md for requirements.
                </p>
              </>
            )}
          </div>
        </PanelFrame>
      ) : (
        <ChannelWorkspace
          extensions={extensions}
          key={`${session.scope ?? "disconnected"}:${session.generation}`}
          scope={session.scope ?? "disconnected"}
          queries={session.session}
          relay={relay}
          navigation={sessionNavigation}
          navigator={navigator}
          viewer={session.viewer}
          panels={panels}
          companion={companion}
        />
      )}
    </section>
  );
}

function ChannelWorkspace({
  extensions,
  queries,
  relay,
  panels,
  scope,
  companion,
  navigation,
  navigator,
  viewer,
}: {
  extensions?: ConversationExtensions | undefined;
  companion?: ReactNode;
  scope: string;
  navigation?: PageNavigation | undefined;
  navigator?: Navigation | undefined;
  viewer?: string | undefined;
  queries: RelaySession;
  relay: RelayData;
  panels: Panels;
}) {
  const list = useChannelList(queries.channels);
  const preferences = useSidebarPreferences(queries.sidebarPreferences);
  useEffect(() => {
    if (list.status === "ready") void queries.unread.ensure();
  }, [queries, list.status]);
  const available = useSyncExternalStore(
    panels.subscribe,
    panels.snapshot,
    panels.snapshot,
  );
  const [selected, setSelected] = useState<string | undefined>(() =>
    readView(scope, "selected-channel", undefined),
  );
  const [draftParent, setDraftParent] = useState<string>();
  const [draftParents, setDraftParents] = useState<string[]>(() => {
    const saved = readView<unknown>(scope, "sessions:channel-drafts", []);
    return Array.isArray(saved)
      ? saved.filter((id): id is string => typeof id === "string")
      : [];
  });
  const updateDraftParents = (update: (previous: string[]) => string[]) => {
    setDraftParents((previous) => {
      const next = update(previous);
      writeView(scope, "sessions:channel-drafts", next);
      return next;
    });
  };
  const select = useCallback(
    (id: string) => {
      setDraftParent(undefined);
      if (navigator && viewer) {
        void navigator.open({
          version: 1,
          kind: "conversation",
          channelId: id,
          scope: {
            viewer,
            communityOrigin: scope.slice(0, -(viewer.length + 1)),
          },
        });
      }
      setSelected(id);
      writeView(scope, "selected-channel", id);
    },
    [navigator, viewer, scope],
  );
  const [thread, setThread] = useState<{
    channelId: string;
    messageId: string;
  }>();
  const threadTrigger = useRef<HTMLElement | null>(null);
  const [sent, setSent] = useState<{ channelId: string; id: string }>();
  const sidebar = useSidebarView(
    scope,
    list.status === "ready" && preferences.status !== "loading",
  );
  const { search } = sidebar;
  const channels = useChannelLabels(list.channels, queries.profiles);
  const childrenByParent = useMemo(() => {
    const children = new Map<string, typeof channels>();
    for (const item of channels) {
      if (item.channelType !== "session" || !item.parentChannelId) continue;
      const siblings = children.get(item.parentChannelId) ?? [];
      siblings.push(item);
      children.set(item.parentChannelId, siblings);
    }
    for (const siblings of children.values())
      siblings.sort(
        (a, b) =>
          (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id),
      );
    return children;
  }, [channels]);
  const requestedChannel =
    navigation?.target.kind === "conversation"
      ? navigation.target.channelId
      : undefined;
  const current = requestedChannel
    ? (channels.find((channel) => channel.id === requestedChannel) ??
      (list.coverage === "partial"
        ? { id: requestedChannel, name: "Conversation" }
        : undefined))
    : (channels.find((channel) => channel.id === selected) ??
      channels.find((item) => item.channelType !== "session"));
  useEffect(() => {
    if (navigation?.signal.aborted) return;
    if (requestedChannel && list.status === "ready" && !current)
      navigation?.complete({ status: "failed", reason: "unavailable" });
    if (!requestedChannel && !current && list.status === "ready")
      navigation?.complete({ status: "opened" });
    if (!requestedChannel && current && navigation && viewer) {
      // Resolve the saved default within this attempt, keeping its caller and deadline.
      navigation.resolve({
        version: 1,
        kind: "conversation",
        channelId: current.id,
        scope: {
          viewer,
          communityOrigin: scope.slice(0, -(viewer.length + 1)),
        },
      });
    }
  }, [requestedChannel, current, list.status, navigation, viewer, scope]);
  const requestedMessage =
    navigation?.target.kind === "conversation"
      ? navigation.target.messageId
      : undefined;
  const requestedThread =
    navigation?.target.kind === "conversation"
      ? navigation.target.threadRootId
      : undefined;
  const currentId = current?.id;
  const drafting =
    !!draftParent && draftParent === currentId && !requestedMessage;
  const startSession = (parentId: string) => {
    select(parentId);
    setDraftParent(parentId);
    sidebar.toggle(`session-children:${parentId}`, true);
    updateDraftParents((previous) =>
      previous.includes(parentId) ? previous : [...previous, parentId],
    );
    setThread(undefined);
    open(undefined);
  };
  useEffect(() => {
    if (
      drafting &&
      navigation?.target.kind === "conversation" &&
      !navigation.target.messageId
    )
      navigation.complete({ status: "opened" });
  }, [drafting, navigation]);
  const [exactOpening, setExactOpening] = useState<{
    request: PageNavigation;
    inTimeline: boolean;
  }>();
  useEffect(() => {
    if (
      !navigation ||
      !requestedMessage ||
      requestedThread === requestedMessage ||
      !currentId ||
      navigation.signal.aborted
    )
      return;
    let selected = false;
    const choose = () => {
      if (selected || navigation.signal.aborted) return;
      const window = queries.channels.window(currentId);
      if (window.status === "idle" || window.status === "loading") return;
      selected = true;
      // Freeze the presentation for this attempt. An isolated lookup or later
      // live event must not move an already-opened thread into the timeline.
      setExactOpening({
        request: navigation,
        inTimeline:
          requestedThread !== requestedMessage &&
          window.status === "ready" &&
          window.freshness !== "cached" &&
          window.rows.some(
            (row) => row.id === requestedMessage && !row.threadRootId,
          ),
      });
    };
    const stop = queries.channels.subscribeWindow(currentId, choose);
    choose();
    return stop;
  }, [navigation, requestedMessage, requestedThread, currentId, queries]);
  const flatSession = current?.channelType === "session";
  const exact =
    navigation && requestedMessage && requestedThread === requestedMessage
      ? { request: navigation, inTimeline: false }
      : exactOpening?.request === navigation
        ? exactOpening
        : undefined;
  type ShowingThread = {
    channelId: string;
    messageId: string;
    navigation?: PageNavigation | undefined;
  };
  const priorRoutedThread = useRef<ShowingThread | undefined>(undefined);
  let showingThread: ShowingThread | undefined = requestedMessage
    ? exact && !exact.inTimeline && current
      ? { channelId: current.id, messageId: requestedMessage, navigation }
      : undefined
    : thread && thread.channelId === current?.id
      ? { ...thread, navigation: undefined }
      : undefined;
  if (flatSession) {
    showingThread = undefined;
    priorRoutedThread.current = undefined;
  }
  if (showingThread?.navigation) priorRoutedThread.current = showingThread;
  else if (!showingThread && (!navigation || (requestedMessage && !exact)))
    showingThread = priorRoutedThread.current;
  else priorRoutedThread.current = undefined;
  useEffect(() => {
    if (thread && !showingThread) setThread(undefined);
  }, [thread, showingThread]);
  type Opening = { channelId: string; panel: RegisteredPanel; target: string };
  const [opened, setOpened] = useState<Opening>();
  const opening = useRef<Opening | undefined>(undefined);
  const open = useCallback((next: Opening | undefined) => {
    // Retire callbacks synchronously, before React commits the next opening.
    opening.current = next;
    setOpened(next);
  }, []);
  const panel =
    opened &&
    opened.channelId === current?.id &&
    available.includes(opened.panel)
      ? opened.panel
      : undefined;
  const mounted = useRef(false);
  const channel = useRef(current?.id);
  useLayoutEffect(() => {
    channel.current = current?.id;
  }, [current?.id]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (opened && !panel) open(undefined);
  }, [opened, panel, open]);
  const openThread = useCallback(
    (messageId: string, threadRootId: string) => {
      if (!currentId) return;
      const target = navigator?.snapshot().entry.target;
      if (
        target?.kind === "conversation" &&
        target.channelId === currentId &&
        target.messageId === messageId &&
        target.threadRootId === threadRootId
      )
        return;
      threadTrigger.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      if (navigator && viewer) {
        setThread(undefined);
        void navigator.open({
          version: 1,
          kind: "conversation",
          channelId: currentId,
          messageId,
          threadRootId,
          scope: {
            viewer,
            communityOrigin: scope.slice(0, -(viewer.length + 1)),
          },
        });
      } else setThread({ channelId: currentId, messageId });
      open(undefined);
    },
    [currentId, navigator, viewer, scope, open],
  );
  const closeThread = () => {
    if (showingThread?.navigation && current) select(current.id);
    setThread(undefined);
    if (threadTrigger.current?.isConnected) threadTrigger.current.focus();
  };
  const panelTrigger = useRef<HTMLElement | null>(null);
  const close = useCallback(() => {
    open(undefined);
    if (panelTrigger.current?.isConnected)
      panelTrigger.current.focus({ preventScroll: true });
    else if (threadTrigger.current?.isConnected) threadTrigger.current.focus();
  }, [open]);
  // Availability follows active contributions; dispatch still re-resolves at click time.
  const canOpenLink = useCallback(
    (target: string) =>
      available.some((candidate) => {
        try {
          return candidate.matches(target);
        } catch {
          return false;
        }
      }),
    [available],
  );
  const linkContext = useRef({
    channelId: currentId,
    routedThread: !!showingThread?.navigation,
  });
  useLayoutEffect(() => {
    linkContext.current = {
      channelId: currentId,
      routedThread: !!showingThread?.navigation,
    };
  }, [currentId, showingThread?.navigation]);
  const openLink = useCallback(
    (url: string) => {
      if (isBuzzLink(url)) {
        if (!navigator || !viewer) return false;
        const target = buzzLinkTarget(url, {
          viewer,
          communityOrigin: scope.slice(0, -(viewer.length + 1)),
        });
        if (!target) return false;
        if (target.kind === "conversation" && target.messageId)
          threadTrigger.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
        setThread(undefined);
        open(undefined);
        void navigator.open(target);
        return true;
      }
      const candidate = panels.resolve(url);
      const context = linkContext.current;
      if (context.channelId && candidate) {
        panelTrigger.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        if (context.routedThread) select(context.channelId);
        setThread(undefined);
        open({
          channelId: context.channelId,
          panel: candidate,
          target: url,
        });
        return true;
      }
      return false;
    },
    [panels, open, select, navigator, viewer, scope],
  );
  const panelActive = () => {
    const connection = relay.snapshot();
    return !!(
      mounted.current &&
      opened &&
      panel &&
      opening.current === opened &&
      channel.current === opened.channelId &&
      panels.snapshot().includes(panel) &&
      connection.status === "ready" &&
      connection.session === queries &&
      !navigation?.signal.aborted
    );
  };
  const panelContext =
    opened && panel
      ? {
          channelId: opened.channelId,
          canOpen: (target: string) => !!panels.resolve(target),
          open: (target: string) => {
            if (!panelActive()) return false;
            const next = panels.resolve(target);
            if (!next) return false;
            // Keep the original conversation trigger for close/focus restoration.
            open({ channelId: opened.channelId, panel: next, target });
            return true;
          },
        }
      : undefined;
  const drawerContext = useMemo(
    () =>
      current && viewer
        ? {
            scope,
            viewer,
            channelId: current.id,
            channelName: current.name,
            relayUrl: scope
              .slice(0, -(viewer.length + 1))
              .replace(/^https:/, "wss:")
              .replace(/^http:/, "ws:"),
            ...(showingThread && { threadId: showingThread.messageId }),
          }
        : undefined,
    [scope, viewer, current, showingThread],
  );
  const drawer = useChannelPanels(panels, drawerContext);
  const visible = useMemo(
    () =>
      channels.filter(
        (channel) =>
          channel.name.toLowerCase().includes(search.toLowerCase()) ||
          childrenByParent
            .get(channel.id)
            ?.some((child) =>
              child.name.toLowerCase().includes(search.toLowerCase()),
            ),
      ),
    [channels, search, childrenByParent],
  );
  return (
    <div
      className={`${styles.board} ${panel || showingThread || companion ? styles.withPanel : ""}`}
    >
      <aside className={styles.sidebar} aria-label="Channel sidebar">
        <div className={styles.search}>
          <Search size={17} />
          <input
            aria-label="Search channels"
            placeholder="Search"
            value={search}
            onChange={(event) => sidebar.setSearch(event.target.value)}
          />
        </div>
        <SidebarUnread listRef={sidebar.list}>
          {sidebarSections(visible, preferences.data).map((section) => (
            <details
              key={section.key}
              className={styles.channelSection}
              open={!sidebar.collapsed.includes(section.key)}
              onToggle={(event) =>
                sidebar.toggle(section.key, event.currentTarget.open)
              }
            >
              <summary>
                {section.icon && (
                  <span aria-hidden="true">{section.icon} </span>
                )}
                {section.title}
              </summary>
              {section.rows.map((channel) => {
                const Icon =
                  channel.channelType === "dm"
                    ? (channel.participants?.length ?? 0) > 1
                      ? Users
                      : MessageCircle
                    : Hash;
                return (
                  <ChannelSidebarRow
                    key={channel.id}
                    channel={channel}
                    icon={<Icon size={17} />}
                    badge={
                      <UnreadBadge session={queries} channelId={channel.id} />
                    }
                    selected={current?.id}
                    collapsed={sidebar.collapsed.includes(
                      `session-children:${channel.id}`,
                    )}
                    onToggle={(open) =>
                      sidebar.toggle(`session-children:${channel.id}`, open)
                    }
                    draft={draftParents.includes(channel.id)}
                    draftSelected={drafting && draftParent === channel.id}
                    sessions={(childrenByParent.get(channel.id) ?? []).filter(
                      (child) =>
                        channel.name
                          .toLowerCase()
                          .includes(search.toLowerCase()) ||
                        child.name.toLowerCase().includes(search.toLowerCase()),
                    )}
                    onPrepare={(id) => queries.channels.prepare?.(id)}
                    onSelect={select}
                    onNewSession={startSession}
                  />
                );
              })}
            </details>
          ))}
          {list.status === "loading" && !list.channels.length && (
            <p className={styles.empty}>Loading your channels…</p>
          )}
          {list.status === "error" && (
            <p role="alert" className={styles.empty}>
              {list.error}
            </p>
          )}
          {list.status === "ready" && !visible.length && (
            <p className={styles.empty}>
              {search ? "No matching channels." : "No channels yet."}
            </p>
          )}
        </SidebarUnread>
        {preferences.status !== "ready" && (
          <div className={styles.preferenceNotice} role="status">
            {preferences.status === "loading"
              ? "Loading saved groups and stars…"
              : preferences.status === "unsupported"
                ? "Saved groups and stars aren’t supported by this host yet."
                : "Couldn’t refresh saved groups and stars. Your conversations are still available."}
            {preferences.status === "error" && (
              <button type="button" onClick={preferences.reload}>
                Retry
              </button>
            )}
          </div>
        )}
      </aside>
      <article className={styles.conversation} aria-label="Conversation">
        {drafting && current ? (
          <NewSessionView parentName={current.name}>
            <NewSessionComposer
              extensions={extensions}
              key={current.id}
              session={queries}
              scope={scope}
              parent={current}
              onStarted={(id) => {
                updateDraftParents((previous) =>
                  previous.filter((parent) => parent !== current.id),
                );
                select(id);
              }}
            />
          </NewSessionView>
        ) : (
          <>
            {current?.channelType === "session" ? (
              <SessionHeading
                channel={current}
                parentName={
                  channels.find(
                    (parent) => parent.id === current.parentChannelId,
                  )?.name
                }
              />
            ) : (
              <header className={styles.heading}>
                <div className={styles.channelTitle}>
                  {current?.channelType === "dm" ? (
                    <MessageCircle size={20} />
                  ) : (
                    <Hash size={20} />
                  )}
                  <strong>{current?.name ?? "Channels"}</strong>
                </div>
                {drawer.launchers}
                <details className={styles.diagnostics}>
                  <summary
                    aria-label="Conversation options"
                    title="Conversation options"
                  >
                    <MoreHorizontal size={19} aria-hidden="true" />
                  </summary>
                  <div className={styles.diagnosticsMenu}>
                    <UnreadOptions session={queries} channelId={current?.id} />
                    <details>
                      <summary>Diagnostics</summary>
                      <LiveStatus
                        live={queries.live}
                        channelId={current?.id}
                        partialRoster={list.coverage === "partial"}
                        diagnostics
                      />
                      <p>
                        {list.coverage === "partial"
                          ? "Partial roster"
                          : "Roster"}{" "}
                        · {channels.length} channels
                      </p>
                      <button
                        type="button"
                        onClick={() => queries.channels.refreshList?.()}
                      >
                        Refresh channels
                      </button>
                      {preferences.error && (
                        <p>Saved groups and stars: {preferences.error}</p>
                      )}
                      {preferences.status !== "unsupported" && (
                        <button
                          type="button"
                          disabled={preferences.status === "loading"}
                          onClick={preferences.reload}
                        >
                          Refresh groups and stars
                        </button>
                      )}
                      {current && (
                        <button
                          type="button"
                          onClick={() => queries.channels.refresh?.(current.id)}
                        >
                          Refresh messages
                        </button>
                      )}
                      {queries.outbox ? (
                        <OutboxStatus
                          outbox={queries.outbox}
                          profiling={queries.profiling}
                        />
                      ) : (
                        <RelayTimings profiling={queries.profiling} />
                      )}
                    </details>
                  </div>
                </details>
              </header>
            )}
            <LiveStatus
              live={queries.live}
              channelId={current?.id}
              partialRoster={list.coverage === "partial"}
            />
            {current ? (
              <ChannelBody
                viewer={viewer}
                extensions={extensions}
                key={current.id}
                queries={queries}
                scope={scope}
                channelId={current.id}
                navigation={
                  flatSession || !requestedMessage || exact?.inTimeline
                    ? navigation
                    : undefined
                }
                onOpenLink={openLink}
                canOpenLink={canOpenLink}
                onOpenThread={flatSession ? undefined : openThread}
                revealMessageId={
                  sent?.channelId === current.id ? sent.id : undefined
                }
              />
            ) : (
              <div className={styles.empty}>Select a channel to read it.</div>
            )}
            {current && (
              <MessageComposer
                sessionConversation={current.channelType === "session"}
                extensions={extensions}
                key={`composer:${current.id}`}
                session={queries}
                scope={scope}
                channelId={current.id}
                channelName={current.name}
                label={
                  current.channelType === "session"
                    ? "Message this session"
                    : undefined
                }
                onSend={(id) => setSent({ channelId: current.id, id })}
              />
            )}
            {drawer.content}
          </>
        )}
      </article>
      {(panel || showingThread || companion) && (
        <div className={styles.panelStack}>
          {showingThread && (
            <ThreadPanel
              sessionConversation={current?.channelType === "session"}
              extensions={extensions}
              session={queries}
              scope={scope}
              channelName={current?.name ?? ""}
              channelId={showingThread.channelId}
              messageId={showingThread.messageId}
              navigation={showingThread.navigation}
              close={closeThread}
              onOpenLink={openLink}
              canOpenLink={canOpenLink}
            />
          )}

          {panel && opened && (
            <PanelCard
              key="target"
              panel={panel}
              target={opened.target}
              context={panelContext}
              close={close}
              closeLabel="Close channel panel"
            />
          )}
          {companion && (
            <div key="companion" className={styles.companion}>
              {companion}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const ChannelBody = memo(function ChannelBody({
  viewer,
  extensions,
  scope,
  queries,
  channelId,
  onOpenLink,
  canOpenLink,
  revealMessageId,
  onOpenThread,
  navigation,
}: {
  extensions?: ConversationExtensions | undefined;
  scope: string;
  queries: RelaySession;
  viewer?: string | undefined;
  channelId: string;
  navigation?: PageNavigation | undefined;
  onOpenLink(url: string): boolean;
  canOpenLink?: ((target: string) => boolean) | undefined;
  revealMessageId?: string | undefined;
  onOpenThread?:
    | ((messageId: string, threadRootId: string) => void)
    | undefined;
}) {
  const window = useChannelWindow(queries.channels, channelId);
  useEffect(() => {
    // Only the normalized conversation attempt can acknowledge its channel.
    // A warm child effect runs before the parent's default resolution effect.
    if (
      navigation?.target.kind !== "conversation" ||
      navigation.target.messageId
    )
      return;
    if (window.status === "ready") navigation?.complete({ status: "opened" });
    else if (window.status === "error")
      navigation?.complete({ status: "failed", reason: "unavailable" });
  }, [navigation, window.status]);
  if (window.status === "error" && !window.rows.length)
    return (
      <div className={styles.empty} role="alert">
        <p>{window.error}</p>
        <button
          type="button"
          onClick={() => queries.channels.ensure(channelId)}
        >
          Retry messages
        </button>
      </div>
    );
  if (window.status !== "ready" && !window.rows.length)
    return (
      <div className={styles.empty} role="status">
        Loading messages…
      </div>
    );
  return (
    <ChannelTimeline
      viewer={viewer}
      extensions={extensions}
      scope={scope}
      channelId={channelId}
      queries={queries}
      window={window}
      onOpenLink={onOpenLink}
      canOpenLink={canOpenLink}
      {...(onOpenThread ? { onOpenThread } : {})}
      revealMessageId={revealMessageId}
      navigation={navigation}
    />
  );
});
