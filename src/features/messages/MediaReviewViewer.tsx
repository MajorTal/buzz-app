import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { X } from "lucide-react";
import { createPortal } from "react-dom";
import type { ConversationExtensions } from "../conversation/contracts";
import type { Attachment } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import type { ThreadView } from "../relay/threads";
import { useRowProfiles } from "../relay/react";
import { MessageComposer } from "./MessageComposer";
import { ImageReviewStage } from "./ImageReviewStage";
import { MessageRow } from "./MessageRow";
import { formatMediaTime } from "./media-timecode";
import styles from "./Messages.module.css";
import { useModalBoundary } from "./useModalBoundary";

type MediaReviewViewerProps = {
  attachment: Attachment;
  extensions?: ConversationExtensions | undefined;
  session: RelaySession;
  scope: string;
  channelId: string;
  channelName: string;
  messageId: string;
  initialTime: number;
  restoreFocus?: RefObject<HTMLElement | null>;
  close(): void;
};

export function MediaReviewViewer(props: MediaReviewViewerProps) {
  const { session, channelId, messageId } = props;
  const [active, setActive] = useState(() => ({
    attachment: props.attachment,
    initialTime: props.initialTime,
    request: 0,
  }));
  const [view, setView] = useState<ThreadView>();
  const [threadError, setThreadError] = useState<string>();
  useEffect(() => {
    try {
      const owned = session.thread(channelId, messageId, { exact: true });
      setThreadError(undefined);
      setView(owned);
      void owned.refresh();
      return () => owned.dispose();
    } catch (error) {
      setThreadError(String(error));
    }
  }, [session, channelId, messageId]);
  const activeProps = {
    ...props,
    attachment: active.attachment,
    initialTime: active.initialTime,
    selectionRequest: active.request,
    selectAttachment: (attachment: Attachment, initialTime: number) =>
      setActive((current) => ({
        attachment,
        initialTime,
        request: current.request + 1,
      })),
  };
  if (threadError) return <ReviewShell {...activeProps} error={threadError} />;
  if (!view) return <ReviewShell {...activeProps} loading />;
  return <ResolvedReview {...activeProps} view={view} />;
}

type ActiveReviewProps = MediaReviewViewerProps & {
  selectionRequest: number;
  selectAttachment(attachment: Attachment, initialTime: number): void;
};

function ResolvedReview({
  view,
  ...props
}: ActiveReviewProps & { view: ThreadView }) {
  const snapshot = useSyncExternalStore(
    view.subscribe,
    view.snapshot,
    view.snapshot,
  );
  useEffect(() => {
    if (snapshot.status === "ready" && snapshot.canLoadMore)
      void view.loadMore();
  }, [view, snapshot.status, snapshot.canLoadMore]);
  if (snapshot.error)
    return (
      <ReviewShell {...props} error={snapshot.error} retry={view.refresh} />
    );
  if (snapshot.status === "loading" || snapshot.status === "idle")
    return <ReviewShell {...props} loading />;
  if (!snapshot.root)
    return (
      <ReviewShell
        {...props}
        error="Original message unavailable."
        retry={view.refresh}
      />
    );
  const threadRows = [
    snapshot.root,
    snapshot.target,
    ...snapshot.replies,
  ].filter((row): row is NonNullable<typeof row> => !!row);
  const attachmentAvailable = threadRows.some((row) =>
    row.attachments.some((item) => item.url === props.attachment.url),
  );
  const videoUrls = new Set(
    threadRows.flatMap((row) =>
      row.attachments.filter((item) => item.video).map((item) => item.url),
    ),
  );
  if (!attachmentAvailable)
    return <ReviewShell {...props} error="Attachment unavailable." />;
  return (
    <ReviewShell
      {...props}
      view={view}
      rootId={snapshot.root.id}
      replies={
        snapshot.target &&
        snapshot.target.id !== snapshot.root.id &&
        !snapshot.replies.some((row) => row.id === snapshot.target?.id)
          ? [...snapshot.replies, snapshot.target]
          : snapshot.replies
      }
      limited={snapshot.limited}
      timecodesSeekable={videoUrls.size === 1}
    />
  );
}

function ReviewShell({
  attachment,
  extensions,
  session,
  scope,
  channelId,
  channelName,
  initialTime,
  close,
  view,
  rootId,
  replies = [],
  limited = false,
  timecodesSeekable = false,
  loading = false,
  error,
  retry,
  restoreFocus,
  selectAttachment,
  selectionRequest,
}: ActiveReviewProps & {
  view?: ThreadView;
  rootId?: string;
  replies?: ReturnType<ThreadView["snapshot"]>["replies"];
  limited?: boolean;
  timecodesSeekable?: boolean;
  loading?: boolean;
  error?: string;
  retry?: () => void | Promise<void>;
}) {
  const source = session.media(attachment.url);
  const backdrop = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [currentTime, setCurrentTime] = useState(initialTime);
  const [includeTime, setIncludeTime] = useState(true);
  const [selectedImageUrl, setSelectedImageUrl] = useState(attachment.url);
  // selectionRequest intentionally re-applies a seek when the same URL/time is selected again.
  useEffect(() => {
    void selectionRequest;
    setSelectedImageUrl(attachment.url);
    const seconds = Math.max(0, initialTime);
    const element = video.current;
    if (!attachment.video || !element) {
      setCurrentTime(seconds);
      return;
    }
    const apply = () => {
      if (!video.current) return;
      video.current.currentTime = seconds;
      setCurrentTime(video.current.currentTime);
    };
    if (element.readyState >= HTMLMediaElement.HAVE_METADATA) apply();
    else element.addEventListener("loadedmetadata", apply, { once: true });
    return () => element.removeEventListener("loadedmetadata", apply);
  }, [attachment.url, attachment.video, initialTime, selectionRequest]);
  useModalBoundary(backdrop, closeButton, close, restoreFocus);
  const seek = (seconds: number) => {
    if (!video.current) return;
    video.current.currentTime = seconds;
    void video.current.play().catch(() => {});
  };
  return createPortal(
    <div ref={backdrop} className={styles.mediaReviewBackdrop}>
      <section
        className={styles.mediaReviewViewer}
        role="dialog"
        aria-modal="true"
        aria-label={attachment.video ? "Video review" : "Image viewer"}
      >
        <header className={styles.mediaReviewHeading} data-tauri-drag-region>
          <span data-tauri-drag-region>
            {attachment.video ? "Video review" : "Image"}
          </span>
          <button
            ref={closeButton}
            type="button"
            aria-label="Close fullscreen viewer"
            onClick={close}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        <div className={styles.mediaReviewStage}>
          {!source || !rootId ? (
            <p
              className={styles.mediaReviewUnavailable}
              role={error ? "alert" : "status"}
            >
              {error ?? (loading ? "Loading media…" : "Media unavailable")}
              {retry && (
                <button type="button" onClick={() => void retry()}>
                  Retry
                </button>
              )}
            </p>
          ) : attachment.video ? (
            // biome-ignore lint/a11y/useMediaCaption: signed attachment metadata has no caption track URL.
            <video
              ref={video}
              src={source}
              controls
              autoPlay
              playsInline
              onLoadedMetadata={(event) => {
                event.currentTarget.currentTime = initialTime;
              }}
              onTimeUpdate={(event) =>
                setCurrentTime(event.currentTarget.currentTime)
              }
            />
          ) : view ? (
            <ImageReviewGallery
              view={view}
              selectedUrl={selectedImageUrl}
              select={setSelectedImageUrl}
              media={session.media}
            />
          ) : null}
        </div>
        <aside className={styles.mediaReviewConversation}>
          {rootId && source ? (
            <>
              <ReviewComments
                replies={replies}
                limited={limited}
                session={session}
                scope={scope}
                extensions={extensions}
                selectAttachment={selectAttachment}
                {...(attachment.video && timecodesSeekable ? { seek } : {})}
              />
              {attachment.video && (
                <div className={styles.mediaReviewTimeOption}>
                  <span>{formatMediaTime(currentTime)}</span>
                  <label>
                    <input
                      type="checkbox"
                      checked={includeTime}
                      onChange={(event) =>
                        setIncludeTime(event.currentTarget.checked)
                      }
                    />
                    Comment at current frame
                  </label>
                </div>
              )}
              <MessageComposer
                extensions={extensions}
                session={session}
                scope={scope}
                channelId={channelId}
                channelName={channelName}
                threadRootId={rootId}
                {...(attachment.video && includeTime
                  ? { mediaTimeSeconds: currentTime }
                  : {})}
                hideMediaTimeIndicator
              />
            </>
          ) : (
            <p className={styles.empty} role={error ? "alert" : "status"}>
              {error ?? "Loading comments…"}
            </p>
          )}
        </aside>
      </section>
    </div>,
    document.body,
  );
}

function ImageReviewGallery({
  view,
  selectedUrl,
  select,
  media,
}: {
  view: ThreadView;
  selectedUrl: string;
  select(url: string): void;
  media(url: string): string | undefined;
}) {
  const thread = useSyncExternalStore(
    view.subscribe,
    view.snapshot,
    view.snapshot,
  );
  const attachments = useMemo(() => {
    const seen = new Set<string>();
    return [thread.root, thread.target, ...thread.replies]
      .flatMap((row) => row?.attachments ?? [])
      .filter(
        (item) => !item.video && !seen.has(item.url) && !!seen.add(item.url),
      );
  }, [thread.root, thread.target, thread.replies]);
  return (
    <ImageReviewStage
      attachments={attachments}
      selectedUrl={selectedUrl}
      media={media}
      select={select}
    />
  );
}

function ReviewComments({
  replies,
  limited,
  session,
  scope,
  extensions,
  seek,
  selectAttachment,
}: {
  replies: ReturnType<ThreadView["snapshot"]>["replies"];
  limited: boolean;
  session: RelaySession;
  scope: string;
  extensions?: ConversationExtensions | undefined;
  seek?: (seconds: number) => void;
  selectAttachment(attachment: Attachment, initialTime: number): void;
}) {
  const profiles = useRowProfiles(session.profiles, replies);
  const authors = [...new Set(replies.map((row) => row.authorId))]
    .sort()
    .join(":");
  useEffect(() => {
    if (authors)
      void session.profiles
        .ensure(authors.split(":"), "background")
        .catch(() => {});
  }, [session.profiles, authors]);
  return (
    <section className={styles.mediaReviewThread} aria-label="Media comments">
      <div className={styles.mediaReviewThreadHeading}>
        <strong>Comments</strong>
        <span>{replies.length}</span>
      </div>
      {replies.map((row) => (
        <MessageRow
          key={row.id}
          row={row}
          extensions={extensions}
          session={session}
          scope={scope}
          profile={profiles.get(row.authorId)}
          media={session.media}
          onOpenLink={() => false}
          day={false}
          retry={session.messages.retry}
          onOpenMediaReview={(_rowId, attachment, seconds) =>
            selectAttachment(attachment, seconds)
          }
          {...(seek ? { onMediaTime: seek } : {})}
        />
      ))}
      {!replies.length && <p className={styles.threadNote}>No comments yet.</p>}
      {limited && (
        <p className={styles.threadNote}>Thread history limit reached.</p>
      )}
    </section>
  );
}
