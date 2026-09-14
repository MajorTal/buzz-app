// biome-ignore-all lint/a11y/noNoninteractiveTabindex: The thread region supports keyboard scrolling and Escape.
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { X } from "lucide-react";
import type { ConversationExtensions } from "../conversation/contracts";
import type { RelaySession } from "../relay/session";
import type { ThreadView } from "../relay/threads";
import { useRowProfiles } from "../relay/react";
import { MessageRow } from "./MessageRow";
import { MessageComposer } from "./MessageComposer";
import styles from "./Messages.module.css";
import { useReading } from "./use-reading";
import { useMessageReveal } from "./use-message-reveal";
import type { PageNavigation } from "../navigation/service";
import { messageViewKey } from "./view-key";
import { useKnownAgentPubkeys } from "../agents/use-known";

export type ThreadPanelProps = {
  extensions?: ConversationExtensions | undefined;
  session: RelaySession;
  scope: string;
  channelName: string;
  channelId: string;
  messageId: string;
  navigation?: PageNavigation | undefined;
  close(): void;
  onOpenLink(url: string): boolean;
  canOpenLink?: ((target: string) => boolean) | undefined;
};

/** Safe to retarget through ordinary props; callers do not own internal remount keys. */
export function ThreadPanel(props: ThreadPanelProps) {
  return (
    <aside
      className={styles.thread}
      aria-label="Thread"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          props.close();
        }
      }}
    >
      <ThreadHeader close={props.close} />
      <OwnedThreadPanel
        key={messageViewKey(
          props.session,
          props.scope,
          props.channelId,
          props.messageId,
        )}
        {...props}
      />
    </aside>
  );
}
function ThreadHeader({ close }: Pick<ThreadPanelProps, "close">) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeButton.current?.focus();
  }, []);
  return (
    <PanelHeader
      variant="compact"
      title="Thread"
      actions={
        <IconButton
          ref={closeButton}
          size="toolbar"
          aria-label="Close thread"
          onClick={close}
          icon={<X size={18} aria-hidden="true" />}
        />
      }
    />
  );
}
function OwnedThreadPanel({
  session,
  extensions,
  scope,
  channelName,
  channelId,
  messageId,
  navigation,
  onOpenLink,
  canOpenLink,
}: ThreadPanelProps) {
  const [view, setView] = useState<ThreadView>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  // Allocate in the effect, not render/useMemo: StrictMode must not leak owned views.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is explicit recovery after view allocation fails.
  useEffect(() => {
    try {
      if (navigation?.signal.aborted) return;
      const exact =
        navigation?.target.kind === "conversation" &&
        navigation.target.threadRootId !== messageId;
      const owned = exact
        ? session.thread(channelId, messageId, { exact: true })
        : session.thread(channelId, messageId);
      const cancel = () => {
        owned.dispose();
        setView(undefined);
      };
      setError(undefined);
      setView(owned);
      navigation?.signal.addEventListener("abort", cancel, { once: true });
      void owned.refresh();
      return () => {
        navigation?.signal.removeEventListener("abort", cancel);
        owned.dispose();
      };
    } catch (error) {
      setError(String(error));
      navigation?.complete({ status: "failed", reason: "unavailable" });
    }
  }, [session, channelId, messageId, attempt, navigation]);
  return error ? (
    <div className={styles.empty} role="alert">
      <p>{error}</p>
      <button type="button" onClick={() => setAttempt((value) => value + 1)}>
        Retry thread
      </button>
    </div>
  ) : view ? (
    <ThreadMessages
      extensions={extensions}
      session={session}
      scope={scope}
      channelId={channelId}
      channelName={channelName}
      view={view}
      navigation={navigation}
      messageId={messageId}
      onOpenLink={onOpenLink}
      canOpenLink={canOpenLink}
    />
  ) : (
    <p className={styles.empty} role="status">
      Loading thread…
    </p>
  );
}
function ThreadMessages({
  session,
  extensions,
  scope,
  channelId,
  channelName,
  view,
  navigation,
  messageId,
  onOpenLink,
  canOpenLink,
}: {
  extensions?: ConversationExtensions | undefined;
  session: RelaySession;
  scope: string;
  channelId: string;
  channelName: string;
  view: ThreadView;
  messageId: string;
  navigation?: PageNavigation | undefined;
  onOpenLink(url: string): boolean;
  canOpenLink?: ((target: string) => boolean) | undefined;
}) {
  const snapshot = useSyncExternalStore(
    view.subscribe,
    view.snapshot,
    view.snapshot,
  );
  const rows = useMemo(
    () =>
      snapshot.root ? [snapshot.root, ...snapshot.replies] : snapshot.replies,
    [snapshot.root, snapshot.replies],
  );
  const authors = [
    ...new Set(rows.flatMap((row) => [row.authorId, ...row.mentions])),
  ]
    .sort()
    .join(":");
  useEffect(() => {
    if (authors)
      void session.profiles
        .ensure(authors.split(":"), "background")
        .catch(() => {});
  }, [session.profiles, authors]);
  const profiles = useRowProfiles(session.profiles, rows);
  const agentPubkeys = useKnownAgentPubkeys(session, profiles);
  const scroller = useRef<HTMLElement>(null);
  const positioned = useRef(false);
  const follow = useRef(true);
  const targetAnchor = useRef<number | undefined>(undefined);
  const selectedRow = useCallback(
    () =>
      [
        ...(scroller.current?.querySelectorAll<HTMLElement>(
          "[data-message-id]",
        ) ?? []),
      ].find((row) => row.dataset.messageId === messageId),
    [messageId],
  );
  const completeTarget = useCallback(() => {
    // Exact lookup can finish before context. Preserve this row's reading
    // position through prepended history without refocusing it after opening.
    targetAnchor.current = selectedRow()?.offsetTop;
    navigation?.complete({ status: "opened" });
  }, [navigation, selectedRow]);
  const prepareTarget = useCallback(() => {
    follow.current = false;
  }, []);
  const rootTarget =
    navigation?.target.kind === "conversation" &&
    navigation.target.threadRootId === messageId;
  const revealed = useMessageReveal({
    scroller,
    settled: positioned,
    messageId,
    signal: navigation?.signal,
    ready: rootTarget
      ? snapshot.root?.id === messageId
      : snapshot.targetStatus === "ready" && snapshot.target?.id === messageId,
    complete: completeTarget,
    prepare: prepareTarget,
  });
  useEffect(() => {
    if (!navigation || navigation.signal.aborted) return;
    if (rootTarget && snapshot.status === "error")
      navigation.complete({ status: "failed", reason: "unavailable" });
    else if (snapshot.targetStatus === "unavailable")
      navigation.complete({ status: "failed", reason: "not-found" });
    else if (snapshot.targetStatus === "error")
      navigation.complete({ status: "failed", reason: "unavailable" });
  }, [navigation, rootTarget, snapshot.status, snapshot.targetStatus]);
  useReading({ session, channelId, scroller, settled: positioned });
  const [sent, setSent] = useState<string>();
  // The bridge walks oldest-first. Finish its bounded range automatically, rather
  // than exposing transport pagination as a conversation control.
  useEffect(() => {
    if (snapshot.status === "ready" && snapshot.canLoadMore)
      void view.loadMore();
  }, [view, snapshot]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Rendered rows/profiles change scroll height; sending is explicit navigation intent.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (
      !element ||
      (navigation && revealed.current !== navigation.signal) ||
      (!positioned.current &&
        (snapshot.status !== "ready" || snapshot.canLoadMore))
    )
      return;
    if (targetAnchor.current !== undefined) {
      const row = selectedRow();
      if (row) {
        element.scrollTop += row.offsetTop - targetAnchor.current;
        targetAnchor.current = row.offsetTop;
        follow.current = false;
      }
      if (snapshot.status !== "loading" && !snapshot.canLoadMore)
        targetAnchor.current = undefined;
    }
    // Initial positioning waits for automatic history loading. User intent wins;
    // subsequent live changes follow only while the reader is at the bottom.
    if (follow.current) element.scrollTop = element.scrollHeight;
    positioned.current = true;
  }, [
    snapshot.status,
    snapshot.canLoadMore,
    rows,
    profiles,
    sent,
    navigation,
    revealed,
    selectedRow,
  ]);
  const keepReadingPosition = () => {
    targetAnchor.current = undefined;
    if (positioned.current) return;
    positioned.current = true;
    follow.current = false;
  };
  return (
    <>
      <section
        ref={scroller}
        className={styles.threadHistory}
        aria-label="Thread messages"
        onScroll={(event) => {
          if (!positioned.current) return;
          const element = event.currentTarget;
          follow.current =
            element.scrollHeight - element.clientHeight - element.scrollTop <
            80;
        }}
        onWheel={keepReadingPosition}
        onTouchMove={keepReadingPosition}
        onPointerDown={keepReadingPosition}
        onKeyDown={(event) => {
          if (
            [
              "ArrowUp",
              "ArrowDown",
              "PageUp",
              "PageDown",
              "Home",
              "End",
              " ",
            ].includes(event.key)
          )
            keepReadingPosition();
        }}
        tabIndex={0}
      >
        {snapshot.root ? (
          <MessageRow
            extensions={extensions}
            session={session}
            scope={scope}
            row={snapshot.root}
            profile={profiles.get(snapshot.root.authorId)}
            participantProfiles={profiles}
            agentPubkeys={agentPubkeys}
            media={session.media}
            onOpenLink={onOpenLink}
            canOpenLink={canOpenLink}
            day={false}
            retry={session.messages.retry}
          />
        ) : (
          snapshot.status !== "loading" && (
            <p className={styles.empty}>Original message unavailable.</p>
          )
        )}
        <div className={styles.threadDivider}>
          {snapshot.replies.length}{" "}
          {snapshot.replies.length === 1 ? "reply shown" : "replies shown"}
        </div>
        <ol>
          {snapshot.replies.map((row) => (
            <li key={row.id}>
              <MessageRow
                extensions={extensions}
                session={session}
                scope={scope}
                row={row}
                profile={profiles.get(row.authorId)}
                participantProfiles={profiles}
                agentPubkeys={agentPubkeys}
                media={session.media}
                onOpenLink={onOpenLink}
                canOpenLink={canOpenLink}
                day={false}
                retry={session.messages.retry}
              />
            </li>
          ))}
        </ol>
        {(snapshot.status === "loading" ||
          (snapshot.status === "ready" && snapshot.canLoadMore)) && (
          <p role="status">Loading thread…</p>
        )}
        {snapshot.targetStatus === "unavailable" && (
          <p role="status">Selected message unavailable.</p>
        )}
        {snapshot.error && <p role="alert">{snapshot.error}</p>}
        {snapshot.limited && !snapshot.error && (
          <p className={styles.threadNote}>Thread history limit reached.</p>
        )}
        {(snapshot.error || snapshot.targetStatus === "unavailable") && (
          <div className={styles.threadHistoryControls}>
            <button type="button" onClick={() => void view.refresh()}>
              Retry thread
            </button>
          </div>
        )}
      </section>
      {snapshot.root && (
        <MessageComposer
          key={`${scope}:${channelId}:${snapshot.root.id}`}
          extensions={extensions}
          session={session}
          scope={scope}
          channelId={channelId}
          channelName={channelName}
          threadRootId={snapshot.root.id}
          onSend={(id) => {
            targetAnchor.current = undefined;
            positioned.current = true;
            follow.current = true;
            setSent(id);
          }}
        />
      )}
    </>
  );
}
