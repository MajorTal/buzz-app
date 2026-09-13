// biome-ignore-all lint/a11y/noNoninteractiveTabindex: The thread region supports keyboard scrolling and Escape.
import {
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
import { messageViewKey } from "./view-key";
import { useKnownAgentPubkeys } from "../agents/use-known";

export type ThreadPanelProps = {
  extensions?: ConversationExtensions | undefined;
  session: RelaySession;
  scope: string;
  channelName: string;
  channelId: string;
  messageId: string;
  close(): void;
  onOpenLink(url: string): boolean;
  canOpenLink?: ((target: string) => boolean) | undefined;
};

/** Safe to retarget through ordinary props; callers do not own internal remount keys. */
export function ThreadPanel(props: ThreadPanelProps) {
  return (
    <OwnedThreadPanel
      key={messageViewKey(
        props.session,
        props.scope,
        props.channelId,
        props.messageId,
      )}
      {...props}
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
  close,
  onOpenLink,
  canOpenLink,
}: ThreadPanelProps) {
  const [view, setView] = useState<ThreadView>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeButton.current?.focus();
  }, []);
  // Allocate in the effect, not render/useMemo: StrictMode must not leak owned views.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is explicit recovery after view allocation fails.
  useEffect(() => {
    try {
      const owned = session.thread(channelId, messageId);
      setError(undefined);
      setView(owned);
      void owned.refresh();
      return () => owned.dispose();
    } catch (error) {
      setError(String(error));
    }
  }, [session, channelId, messageId, attempt]);
  return (
    <aside
      className={styles.thread}
      aria-label="Thread"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          close();
        }
      }}
    >
      <header className={styles.heading}>
        <strong>Thread</strong>
        <button
          ref={closeButton}
          type="button"
          aria-label="Close thread"
          onClick={close}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </header>
      {error ? (
        <div className={styles.empty} role="alert">
          <p>{error}</p>
          <button
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
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
          onOpenLink={onOpenLink}
          canOpenLink={canOpenLink}
        />
      ) : (
        <p className={styles.empty} role="status">
          Loading thread…
        </p>
      )}
    </aside>
  );
}
function ThreadMessages({
  session,
  extensions,
  scope,
  channelId,
  channelName,
  view,
  onOpenLink,
  canOpenLink,
}: {
  extensions?: ConversationExtensions | undefined;
  session: RelaySession;
  scope: string;
  channelId: string;
  channelName: string;
  view: ThreadView;
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
      (!positioned.current &&
        (snapshot.status !== "ready" || snapshot.canLoadMore))
    )
      return;
    // Initial positioning waits for automatic history loading. User intent wins;
    // subsequent live changes follow only while the reader is at the bottom.
    if (follow.current) element.scrollTop = element.scrollHeight;
    positioned.current = true;
  }, [snapshot.status, snapshot.canLoadMore, rows, profiles, sent]);
  const keepReadingPosition = () => {
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
        {snapshot.error && <p role="alert">{snapshot.error}</p>}
        {snapshot.limited && !snapshot.error && (
          <p className={styles.threadNote}>Thread history limit reached.</p>
        )}
        {snapshot.error && (
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
            positioned.current = true;
            follow.current = true;
            setSent(id);
          }}
        />
      )}
    </>
  );
}
