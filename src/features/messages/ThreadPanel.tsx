// biome-ignore-all lint/a11y/noNoninteractiveTabindex: The thread region supports keyboard scrolling and Escape.
import { MessageEditScope } from "./MessageEditScope";
import { ReplySummary } from "./ReplySummary";
import { ReplyBranch } from "./ReplyBranch";
import { replyTree } from "./reply-tree";
import { useChannelIdentityNames } from "../identity-names/react";
import { formatPublicKey } from "../../shared/identity/public-key";
import { Button } from "../../shared/design-system/ui/Button";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { XIcon } from "../../shared/design-system/icons/index";
import type { ConversationExtensions } from "../conversation/contracts";
import type { ChannelMessage } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import type { ThreadView } from "../relay/threads";
import { useRowProfiles } from "../relay/react";
import { MessageRow } from "./MessageRow";
import { MessageComposer } from "./MessageComposer";
import styles from "./Messages.module.css";
import { rejectUnhandledFileDrop } from "./use-file-drop";
import { useReading } from "./use-reading";
import { useMessageReveal } from "./use-message-reveal";
import type { PageNavigation } from "../navigation/service";
import { messageViewKey } from "./view-key";
import type { MediaPlayback } from "./MediaAttachment";
import { formatMediaTime } from "./media-timecode";
import { useKnownAgentPubkeys } from "../agents/use-known";

export type ThreadPanelProps = {
  extensions?: ConversationExtensions | undefined;
  session: RelaySession;
  scope: string;
  channelName: string;
  channelId: string;
  sessionConversation?: boolean | undefined;
  messageId: string;
  replyRequest?: number | undefined;
  navigation?: PageNavigation | undefined;
  close(): void;
  onOpenLink(url: string): boolean;
  onOpenMediaReview?(
    messageId: string,
    attachment: ChannelMessage["attachments"][number],
    seconds: number,
    hasComments?: boolean,
  ): void;
  canOpenLink?: ((target: string) => boolean) | undefined;
};

/** Safe to retarget through ordinary props; callers do not own internal remount keys. */
export function ThreadPanel(props: ThreadPanelProps) {
  return (
    <aside
      className={styles.thread}
      data-attachment-drop-zone=""
      onDragOver={rejectUnhandledFileDrop}
      onDrop={rejectUnhandledFileDrop}
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
          icon={<XIcon size={18} aria-hidden="true" />}
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
  onOpenMediaReview,
  canOpenLink,
  sessionConversation,
  replyRequest,
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
      <Button type="button" onClick={() => setAttempt((value) => value + 1)}>
        Retry thread
      </Button>
    </div>
  ) : view ? (
    <ThreadMessages
      sessionConversation={sessionConversation}
      extensions={extensions}
      session={session}
      scope={scope}
      channelId={channelId}
      channelName={channelName}
      view={view}
      navigation={navigation}
      messageId={messageId}
      replyRequest={replyRequest}
      onOpenLink={onOpenLink}
      onOpenMediaReview={onOpenMediaReview}
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
  messageId,
  view,
  navigation,
  onOpenLink,
  onOpenMediaReview,
  canOpenLink,
  sessionConversation,
  replyRequest,
}: {
  sessionConversation?: boolean | undefined;
  extensions?: ConversationExtensions | undefined;
  session: RelaySession;
  scope: string;
  channelId: string;
  channelName: string;
  messageId: string;
  view: ThreadView;
  replyRequest?: number | undefined;
  navigation?: PageNavigation | undefined;
  onOpenLink(url: string): boolean;
  onOpenMediaReview?: ThreadPanelProps["onOpenMediaReview"];
  canOpenLink?: ((target: string) => boolean) | undefined;
}) {
  const snapshot = useSyncExternalStore(
    view.subscribe,
    view.snapshot,
    view.snapshot,
  );
  const tree = useMemo(
    () => replyTree(snapshot.replies, snapshot.root?.id),
    [snapshot.replies, snapshot.root?.id],
  );
  const branchReplies = useMemo(() => {
    const branches = new Map<string, ChannelMessage[]>();
    for (const reply of snapshot.replies) {
      for (const ancestor of tree.ancestors(reply.id)) {
        const replies = branches.get(ancestor) ?? [];
        replies.push(reply);
        branches.set(ancestor, replies);
      }
    }
    return branches;
  }, [tree, snapshot.replies]);
  const subscribeUnread = useCallback(
    (listener: () => void) =>
      session.unread.subscribe(
        { kind: "thread", channelId, rootId: snapshot.root?.id ?? messageId },
        listener,
      ),
    [session.unread, channelId, snapshot.root?.id, messageId],
  );
  const unreadSnapshot = useCallback(
    () =>
      session.unread.snapshot({
        kind: "thread",
        channelId,
        rootId: snapshot.root?.id ?? messageId,
      }),
    [session.unread, channelId, snapshot.root?.id, messageId],
  );
  useSyncExternalStore(subscribeUnread, unreadSnapshot, unreadSnapshot);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [replyParent, setReplyParent] = useState<string>();
  const resolveName = useChannelIdentityNames(session, channelId);
  const rows = useMemo(
    () =>
      snapshot.root ? [snapshot.root, ...snapshot.replies] : snapshot.replies,
    [snapshot.root, snapshot.replies],
  );
  const authors = [
    ...new Set(
      rows.flatMap((row) => [
        row.authorId,
        ...row.mentions,
        ...(row.mentionReferences ?? []),
      ]),
    ),
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
  // A late ancestor reparents the exact row. Transfer only focus owned at detach,
  // within this commit/layout expansion; a later user expansion must not restore it.
  const selectedBranchRef = useMemo(() => {
    let restore = false;
    return (branch: HTMLLIElement | null) => {
      if (!branch) return;
      const row = branch.querySelector<HTMLElement>("[data-message-id]");
      if (
        restore &&
        row &&
        !navigation?.signal.aborted &&
        !branch.closest("[inert]") &&
        document.activeElement === document.body
      ) {
        row.tabIndex = -1;
        row.focus({ preventScroll: true });
      }
      restore = false;
      return () => {
        restore =
          row?.dataset.messageId === messageId &&
          document.activeElement === row;
        // Ancestor expansion happens synchronously in a layout effect. Do not
        // retain focus intent after this update (collapse, deletion, or unmount).
        queueMicrotask(() => {
          restore = false;
        });
      };
    };
  }, [messageId, navigation?.signal]);
  const selectedOffset = useCallback(() => {
    const row = selectedRow();
    const container = scroller.current;
    return row && container
      ? row.getBoundingClientRect().top -
          container.getBoundingClientRect().top +
          container.scrollTop
      : undefined;
  }, [selectedRow]);
  const completeTarget = useCallback(() => {
    // Exact lookup can finish before context. Preserve this row's reading
    // position through prepended history without refocusing it after opening.
    targetAnchor.current = selectedOffset();
    navigation?.complete({ status: "opened" });
  }, [navigation, selectedOffset]);
  const prepareTarget = useCallback(() => {
    follow.current = false;
  }, []);
  const revealedAncestors = useRef(new Set<string>());
  // Exact targets may precede their ancestors in bounded history. Reveal every
  // available ancestor as it arrives; missing parents remain visible at the top.
  useLayoutEffect(() => {
    if (navigation?.signal.aborted) return;
    const ancestors = tree
      .ancestors(messageId)
      .filter((id) => !revealedAncestors.current.has(id));
    for (const id of ancestors) revealedAncestors.current.add(id);
    if (ancestors.length)
      setExpanded((current) => {
        if (ancestors.every((id) => current.has(id))) return current;
        return new Set([...current, ...ancestors]);
      });
  }, [tree, messageId, navigation]);
  const rootTarget =
    navigation?.target.kind === "conversation" &&
    navigation.target.threadRootId === messageId;
  const revealed = useMessageReveal({
    scroller,
    settled: positioned,
    messageId,
    signal: rootTarget ? undefined : navigation?.signal,
    ready:
      snapshot.targetStatus === "ready" && snapshot.target?.id === messageId,
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
  const [replyFocus, setReplyFocus] = useState(0);
  const focusReply = useCallback(() => {
    setReplyParent(undefined);
    setReplyFocus((value) => value + 1);
  }, []);
  const targetReply = useCallback((id: string) => {
    setReplyParent((current) => (current === id ? undefined : id));
    setReplyFocus((value) => value + 1);
  }, []);
  useEffect(() => {
    if (replyRequest) focusReply();
  }, [replyRequest, focusReply]);
  const [mediaPlayback, setMediaPlayback] = useState<MediaPlayback>();
  const [mediaCommentTime, setMediaCommentTime] = useState<number>();
  const [mediaSeek, setMediaSeek] = useState<{
    seconds: number;
    request: number;
  }>();
  const rootId = snapshot.root?.id;
  const hasMediaComments =
    (snapshot.root?.replyCount ?? 0) > 0 ||
    snapshot.replies.length > 0 ||
    (!!snapshot.target && snapshot.target.id !== rootId);
  const openRootMedia = useCallback(
    (
      _rowId: string,
      attachment: ChannelMessage["attachments"][number],
      seconds: number,
    ) => {
      if (rootId)
        onOpenMediaReview?.(_rowId, attachment, seconds, hasMediaComments);
    },
    [rootId, onOpenMediaReview, hasMediaComments],
  );
  // Without a selected viewer, bare timecodes need one unambiguous video.
  const videoUrls = new Set(
    [snapshot.root, snapshot.target, ...snapshot.replies].flatMap(
      (row) =>
        row?.attachments
          .filter((item) => item.kind === "video")
          .map((item) => item.url) ?? [],
    ),
  );
  const videoOwner =
    videoUrls.size === 1
      ? [snapshot.root, snapshot.target, ...snapshot.replies].find((row) =>
          row?.attachments.some((item) => item.kind === "video"),
        )
      : undefined;
  const videoAttachment = videoOwner?.attachments.find(
    (item) => item.kind === "video",
  );
  const canSeekVideo =
    !!videoAttachment && (videoOwner?.id === rootId || !!onOpenMediaReview);
  const handleMediaTime = useCallback(
    (seconds: number) => {
      if (!videoOwner || !videoAttachment) return;
      if (videoOwner.id !== rootId) {
        // A reply's video may be inside a collapsed branch. Open its canonical
        // viewer instead of seeking an absent preview or an unrelated root.
        openRootMedia(videoOwner.id, videoAttachment, seconds);
        return;
      }
      setMediaSeek((current) => ({
        seconds,
        request: (current?.request ?? 0) + 1,
      }));
    },
    [videoOwner, videoAttachment, rootId, openRootMedia],
  );
  // The bridge walks oldest-first. Finish its bounded range automatically, rather
  // than exposing transport pagination as a conversation control.
  useEffect(() => {
    if (snapshot.status === "ready" && snapshot.canLoadMore)
      void view.loadMore();
  }, [view, snapshot]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Rendered rows/profiles change scroll height; sending is explicit navigation intent.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || navigation?.signal.aborted) return;
    // A mounted ordinary thread acknowledges the visit before slow history can
    // exhaust navigation's deadline. Positioning still waits for bounded loading.
    if (
      rootTarget &&
      snapshot.status !== "error" &&
      snapshot.root?.id === messageId &&
      revealed.current !== navigation.signal
    ) {
      revealed.current = navigation.signal;
      navigation.complete({ status: "opened" });
    }
    if (
      (navigation && !rootTarget && revealed.current !== navigation.signal) ||
      (!positioned.current &&
        (snapshot.status !== "ready" || snapshot.canLoadMore))
    )
      return;
    if (targetAnchor.current !== undefined) {
      const offset = selectedOffset();
      if (offset !== undefined) {
        element.scrollTop += offset - targetAnchor.current;
        targetAnchor.current = offset;
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
    snapshot.root,
    messageId,
    rows,
    profiles,
    sent,
    navigation,
    rootTarget,
    revealed,
    selectedOffset,
  ]);
  // An own send can land in the middle of a branch, not at the list bottom.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry DOM lookup after history or branch visibility changes.
  useLayoutEffect(() => {
    if (!sent) return;
    const row = [
      ...(scroller.current?.querySelectorAll<HTMLElement>(
        "[data-message-id]",
      ) ?? []),
    ].find((element) => element.dataset.messageId === sent);
    if (row) {
      row.scrollIntoView({ block: "nearest" });
      setSent(undefined);
    }
  }, [sent, snapshot.replies, expanded]);
  const keepReadingPosition = () => {
    targetAnchor.current = undefined;
    if (positioned.current) return;
    positioned.current = true;
    follow.current = false;
  };
  let previousReply: ChannelMessage | undefined = snapshot.root;
  function renderReplies(parent: string | undefined, depth = 0): ReactNode {
    return (tree.children.get(parent) ?? []).map((row) => {
      const children = tree.children.get(row.id);
      const continuation =
        previousReply?.authorId === row.authorId &&
        row.createdAt >= previousReply.createdAt &&
        row.createdAt - previousReply.createdAt <= 10 * 60 &&
        !row.membership;
      previousReply =
        children?.length && !expanded.has(row.id) ? undefined : row;
      const descendants = branchReplies.get(row.id) ?? [];
      const unreadCount = descendants.filter(
        (reply) => session.unread.attention(channelId, reply.id).unread,
      ).length;
      const unreadLabel = unreadCount
        ? `${unreadCount} new in available replies`
        : undefined;
      const message = (branchControl?: ReactNode) => (
        <MessageRow
          branchControl={branchControl}
          extensions={extensions}
          session={session}
          scope={scope}
          onReply={snapshot.root ? targetReply : undefined}
          row={row}
          profile={profiles.get(row.authorId)}
          participantProfiles={profiles}
          agentPubkeys={agentPubkeys}
          media={session.media}
          onOpenLink={onOpenLink}
          canOpenLink={canOpenLink}
          day={false}
          layout={continuation ? "continuation" : "thread"}
          retry={session.messages.retry}
          {...(canSeekVideo ? { onMediaTime: handleMediaTime } : {})}
          {...(onOpenMediaReview && rootId
            ? { onOpenMediaReview: openRootMedia }
            : {})}
        />
      );
      return (
        <li
          key={row.id}
          ref={row.id === messageId ? selectedBranchRef : undefined}
          className={styles.replyItem}
          data-layout={continuation ? "continuation" : "thread"}
        >
          {!parent && row.replyParentId && row.replyParentId !== rootId && (
            <p className={styles.threadNote}>
              Earlier reply unavailable in loaded history.
            </p>
          )}

          <ReplyBranch
            message={message}
            collapsible={!!children?.length}
            layout={continuation ? "continuation" : "thread"}
            label={`View ${descendants.length} ${descendants.length === 1 ? "reply" : "replies"}${unreadLabel ? `. ${unreadLabel}` : ""}`}
            summary={
              <ReplySummary
                count={descendants.length}
                participants={[
                  ...new Set(descendants.map((reply) => reply.authorId)),
                ]}
                profiles={profiles}
                agentPubkeys={agentPubkeys}
                resolveName={resolveName}
                media={session.media}
                unreadLabel={unreadLabel}
                unreadCount={unreadCount}
              />
            }
            depth={depth}
            open={expanded.has(row.id)}
            onOpenChange={(open) => {
              follow.current = false;
              targetAnchor.current = undefined;
              setExpanded((current) => {
                const next = new Set(current);
                if (open) next.add(row.id);
                else {
                  next.delete(row.id);
                  for (const id of current)
                    if (tree.ancestors(id).includes(row.id)) next.delete(id);
                }
                return next;
              });
            }}
          >
            {expanded.has(row.id) && (
              <ol>{renderReplies(row.id, depth + 1)}</ol>
            )}
          </ReplyBranch>
        </li>
      );
    });
  }
  const selectedParent = snapshot.replies.find((row) => row.id === replyParent);
  return (
    <MessageEditScope>
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
          <>
            <MessageRow
              extensions={extensions}
              session={session}
              scope={scope}
              onReply={focusReply}
              row={snapshot.root}
              profile={profiles.get(snapshot.root.authorId)}
              participantProfiles={profiles}
              agentPubkeys={agentPubkeys}
              media={session.media}
              onOpenLink={onOpenLink}
              canOpenLink={canOpenLink}
              day={false}
              layout="thread"
              retry={session.messages.retry}
              mediaMode="thread"
              {...(mediaSeek
                ? {
                    mediaSeekTo: mediaSeek.seconds,
                    mediaSeekRequest: mediaSeek.request,
                  }
                : {})}
              onMediaPlayback={setMediaPlayback}
              {...(onOpenMediaReview
                ? { onOpenMediaReview: openRootMedia }
                : {})}
            />
            {videoOwner?.id === rootId && videoAttachment && mediaPlayback && (
              <span className={styles.mediaCommentAction}>
                <Button
                  size="sm"
                  type="button"
                  onClick={() => setMediaCommentTime(mediaPlayback.seconds)}
                >
                  Comment at {formatMediaTime(mediaPlayback.seconds)}
                </Button>
              </span>
            )}
          </>
        ) : snapshot.status !== "loading" ? (
          <p className={styles.empty}>Original message unavailable.</p>
        ) : null}
        <ol>{renderReplies(undefined)}</ol>
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
            <Button type="button" onClick={() => void view.refresh()}>
              Retry thread
            </Button>
          </div>
        )}
      </section>
      {snapshot.root && (
        <MessageComposer
          sessionConversation={sessionConversation}
          key={`${scope}:${channelId}:${snapshot.root.id}`}
          extensions={extensions}
          session={session}
          scope={scope}
          channelId={channelId}
          channelName={channelName}
          placeholder={`Reply in thread to ${resolveName(snapshot.root.authorId, profiles.get(snapshot.root.authorId)?.name ?? formatPublicKey(snapshot.root.authorId) ?? "Unknown author")}`}
          threadRootId={snapshot.root.id}
          replyParentId={replyParent}
          disabled={!!replyParent && !selectedParent}
          replyContext={
            replyParent && !selectedParent ? (
              <div className={styles.replyContext}>
                <span>Reply target is no longer available.</span>
                <Button size="sm" onClick={focusReply}>
                  Cancel reply target
                </Button>
              </div>
            ) : (
              selectedParent && (
                <div className={styles.replyContext}>
                  <div>
                    <span>
                      Replying to{" "}
                      {resolveName(
                        selectedParent.authorId,
                        profiles.get(selectedParent.authorId)?.name ??
                          formatPublicKey(selectedParent.authorId) ??
                          "Unknown author",
                      )}
                    </span>
                    <p>{selectedParent.content}</p>
                  </div>
                  <IconButton
                    size="sm"
                    aria-label="Cancel reply target"
                    onClick={focusReply}
                    icon={<XIcon size={16} aria-hidden="true" />}
                  />
                </div>
              )
            )
          }
          editMessages={rows}
          focusRequest={replyFocus}
          onOpenLink={onOpenLink}
          canOpenLink={canOpenLink}
          {...(videoAttachment && mediaCommentTime !== undefined
            ? { mediaTimeSeconds: mediaCommentTime }
            : {})}
          clearMediaTime={() => setMediaCommentTime(undefined)}
          onSend={(id) => {
            targetAnchor.current = undefined;
            positioned.current = true;
            follow.current = !selectedParent;
            if (selectedParent)
              setExpanded(
                (current) =>
                  new Set([
                    ...current,
                    selectedParent.id,
                    ...tree.ancestors(selectedParent.id),
                  ]),
              );
            setReplyParent(undefined);
            setSent(id);
          }}
        />
      )}
    </MessageEditScope>
  );
}
