import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { Expand, Pause, Play, X } from "lucide-react";
import { createPortal } from "react-dom";
import type { Attachment } from "../relay/contracts";
import { formatMediaTime } from "./media-timecode";
import styles from "./Messages.module.css";
import { useModalBoundary } from "./useModalBoundary";

export type MediaPlayback = Readonly<{
  attachmentUrl: string;
  seconds: number;
}>;

type MediaAttachmentProps = {
  attachment: Attachment;
  media(url: string): string | undefined;
  mode?: "inline" | "thread";
  seekTo?: number;
  seekRequest?: number;
  onPlayback?(playback: MediaPlayback): void;
  onOpenReview?(attachment: Attachment, seconds: number): void;
};

function useVideoPosition(
  video: RefObject<HTMLVideoElement | null>,
  seekTo: number | undefined,
  seekRequest: number | undefined,
) {
  useEffect(() => {
    // A monotonically increasing request lets the same timecode seek again.
    void seekRequest;
    if (seekTo === undefined || !video.current) return;
    const seek = () => {
      if (!video.current) return;
      video.current.currentTime = Math.max(0, seekTo);
      void video.current.play().catch(() => {});
    };
    if (video.current.readyState >= HTMLMediaElement.HAVE_METADATA) seek();
    else video.current.addEventListener("loadedmetadata", seek, { once: true });
  }, [seekTo, seekRequest, video]);
}

export function MediaAttachment({
  attachment,
  media,
  mode = "inline",
  seekTo,
  seekRequest,
  onPlayback,
  onOpenReview,
}: MediaAttachmentProps) {
  const source = media(attachment.url);
  const preview = attachment.previewUrl
    ? media(attachment.previewUrl)
    : undefined;
  const video = useRef<HTMLVideoElement>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [currentTime, setCurrentTime] = useState(seekTo ?? 0);
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [capturedPreview, setCapturedPreview] = useState<string>();
  const [measuredDimensions, setMeasuredDimensions] = useState<{
    width: number;
    height: number;
  }>();
  const dimensions = attachment.dimensions ?? measuredDimensions;
  const previewStyle = dimensions
    ? ({
        "--media-ratio": `${dimensions.width} / ${dimensions.height}`,
        aspectRatio: "var(--media-ratio)",
      } as CSSProperties)
    : undefined;
  const visiblePreview = preview ?? capturedPreview;
  useVideoPosition(video, seekTo, seekRequest);

  if (!source)
    return (
      <span className={styles.attachmentUnavailable} role="status">
        {attachment.video ? "Video unavailable" : "Image unavailable"}
      </span>
    );

  if (failed)
    return (
      <span className={styles.attachmentUnavailable} role="status">
        {attachment.video ? "Video unavailable" : "Image unavailable"}
      </span>
    );

  if (!attachment.video)
    return (
      <>
        <button
          className={`${styles.mediaPreview} ${mode === "thread" ? styles.mediaPreviewThread : ""}`}
          style={previewStyle}
          type="button"
          aria-label="Open image fullscreen"
          onClick={() =>
            onOpenReview ? onOpenReview(attachment, 0) : setViewerOpen(true)
          }
        >
          <img
            src={source}
            alt="Attachment preview"
            loading="lazy"
            onLoad={(event) =>
              setMeasuredDimensions({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
            onError={() => setFailed(true)}
          />
        </button>
        {viewerOpen &&
          createPortal(
            <MediaViewer
              title="Image attachment"
              close={() => setViewerOpen(false)}
            >
              <img
                className={styles.mediaViewerImage}
                src={source}
                alt="Attachment preview"
              />
            </MediaViewer>,
            document.body,
          )}
      </>
    );

  const videoElement = (
    // biome-ignore lint/a11y/useMediaCaption: signed attachment metadata has no caption track URL.
    <video
      ref={video}
      className={styles.mediaVideo}
      src={source}
      poster={visiblePreview}
      preload="auto"
      playsInline
      style={previewStyle}
      onLoadedData={(event) => {
        const element = event.currentTarget;
        setMeasuredDimensions({
          width: element.videoWidth,
          height: element.videoHeight,
        });
        if (!preview && element.currentTime === 0) {
          // WebKit often paints no frame at exactly zero. Seeking after actual
          // frame data arrives forces a decodable opening frame.
          element.currentTime = Math.min(0.1, element.duration || 0.1);
          return;
        }
      }}
      onSeeked={(event) => {
        const element = event.currentTarget;
        if (!preview && !capturedPreview && element.videoWidth > 0) {
          try {
            const canvas = document.createElement("canvas");
            const scale = Math.min(1, 640 / element.videoWidth);
            canvas.width = Math.max(1, Math.round(element.videoWidth * scale));
            canvas.height = Math.max(
              1,
              Math.round(element.videoHeight * scale),
            );
            canvas
              .getContext("2d")
              ?.drawImage(element, 0, 0, canvas.width, canvas.height);
            setCapturedPreview(canvas.toDataURL("image/jpeg", 0.8));
          } catch {
            // A decoded frame may still paint in the video when canvas export
            // is unavailable; the poster capture is only a compatibility aid.
          }
        }
      }}
      onError={() => setFailed(true)}
      onPause={() => setPlaying(false)}
      onPlay={() => {
        setStarted(true);
        setPlaying(true);
      }}
      onTimeUpdate={(event) => {
        const seconds = event.currentTarget.currentTime;
        setCurrentTime(seconds);
        onPlayback?.({ attachmentUrl: attachment.url, seconds });
      }}
    />
  );

  return (
    <>
      <div
        className={`${styles.mediaPreview} ${mode === "thread" ? styles.mediaPreviewThread : ""}`}
        style={previewStyle}
      >
        {visiblePreview && !started && (
          <img
            className={styles.mediaPoster}
            src={visiblePreview}
            alt=""
            aria-hidden="true"
          />
        )}
        {videoElement}
        <button
          type="button"
          className={styles.mediaPlay}
          aria-label={playing ? "Pause video" : "Play video"}
          onClick={() => {
            if (!video.current) return;
            if (video.current.paused) void video.current.play();
            else video.current.pause();
          }}
        >
          {playing ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <span className={styles.mediaTime}>{formatMediaTime(currentTime)}</span>
        <button
          type="button"
          className={styles.mediaExpand}
          aria-label="Open video fullscreen"
          onClick={() => {
            video.current?.pause();
            if (onOpenReview) onOpenReview(attachment, currentTime);
            else setViewerOpen(true);
          }}
        >
          <Expand size={16} aria-hidden="true" />
        </button>
      </div>
      {viewerOpen &&
        createPortal(
          <MediaViewer
            title="Video attachment"
            close={() => setViewerOpen(false)}
          >
            {/* biome-ignore lint/a11y/useMediaCaption: signed attachment metadata has no caption track URL. */}
            <video
              className={styles.mediaViewerVideo}
              src={source}
              controls
              autoPlay
              playsInline
              onLoadedMetadata={(event) => {
                event.currentTarget.currentTime = currentTime;
              }}
              onTimeUpdate={(event) => {
                const seconds = event.currentTarget.currentTime;
                setCurrentTime(seconds);
                onPlayback?.({ attachmentUrl: attachment.url, seconds });
              }}
            />
          </MediaViewer>,
          document.body,
        )}
    </>
  );
}

function MediaViewer({
  title,
  close,
  children,
}: {
  title: string;
  close(): void;
  children: ReactNode;
}) {
  const backdrop = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useModalBoundary(backdrop, closeButton, close);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click is a pointer-only shortcut; the dialog has an explicit close button and Escape behavior.
    <div
      ref={backdrop}
      className={styles.mediaViewerBackdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        className={styles.mediaViewer}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className={styles.mediaViewerDragRegion} data-tauri-drag-region />
        <button
          ref={closeButton}
          type="button"
          className={styles.mediaViewerClose}
          aria-label="Close fullscreen viewer"
          onClick={close}
        >
          <X size={20} aria-hidden="true" />
        </button>
        {children}
      </section>
    </div>
  );
}
