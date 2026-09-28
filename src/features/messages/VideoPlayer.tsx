import { useVideoGestures } from "./use-video-gestures";
import { useMediaControls } from "./use-media-controls";
import { useMediaCorners } from "./use-media-corners";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import {
  PauseIcon,
  PlayIcon,
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  SpeakerHighIcon,
  SpeakerSlashIcon,
} from "../../shared/design-system/icons";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { formatMediaTime } from "./media-timecode";
import styles from "./VideoPlayer.module.css";

export type VideoMarker = {
  id: string;
  seconds: number;
  label: string;
  author: string;
  picture?: string | undefined;
  text: string;
};
const speeds = [2, 1.75, 1.5, 1.25, 1, 0.75, 0.5, 0.25];
const speedKey = "buzz.video.playback-speed";
const speedEvent = "buzz:video-playback-speed";
function savedSpeed() {
  try {
    const value = Number(localStorage.getItem(speedKey));
    return speeds.includes(value) ? value : 1;
  } catch {
    return 1;
  }
}
export function videoTime(seconds: number) {
  return formatMediaTime(seconds).padStart(5, "0");
}

/** The same controls serve chat previews and review; the caller owns the video. */
export function VideoControls({
  videoRef,
  inline = false,
  markers = [],
  onMarker,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  inline?: boolean;
  markers?: readonly VideoMarker[];
  onMarker?(id: string, seconds: number): void;
}) {
  const corners = useMediaCorners();
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(savedSpeed);
  const [menu, setMenu] = useState(false);
  const [hover, setHover] = useState<number>();
  const [notice, setNotice] = useState<string>();
  const speedButton = useRef<HTMLButtonElement>(null);
  const speedMenu = useRef<HTMLFieldSetElement>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let frame = 0;
    const syncTime = () => setTime(video.currentTime);
    const tick = () => {
      syncTime();
      frame = requestAnimationFrame(tick);
    };
    const play = () => {
      setPlaying(true);
      setNotice(undefined);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(tick);
    };
    const pause = () => {
      setPlaying(false);
      cancelAnimationFrame(frame);
      syncTime();
    };
    const metadata = () => {
      setDuration(Number.isFinite(video.duration) ? video.duration : 0);
    };
    const sound = () => {
      setVolume(video.volume);
      setMuted(video.muted);
    };
    const speed = () => setRate(video.playbackRate);
    const restoreSpeed = () => {
      video.playbackRate = savedSpeed();
      speed();
    };
    const receiveSpeed = (event: Event) => {
      video.playbackRate = (event as CustomEvent<number>).detail;
      speed();
    };
    const storage = (event: StorageEvent) => {
      if (event.key === speedKey || event.key === null) restoreSpeed();
    };
    restoreSpeed();
    window.addEventListener(speedEvent, receiveSpeed);
    window.addEventListener("storage", storage);
    const events = {
      timeupdate: syncTime,
      seeked: syncTime,
      play,
      pause,
      ended: pause,
      durationchange: metadata,
      loadedmetadata: metadata,
      volumechange: sound,
      ratechange: speed,
    };
    for (const [event, listener] of Object.entries(events))
      video.addEventListener(event, listener);
    metadata();
    syncTime();
    sound();
    speed();
    if (!video.paused) play();
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener(speedEvent, receiveSpeed);
      window.removeEventListener("storage", storage);
      for (const [event, listener] of Object.entries(events))
        video.removeEventListener(event, listener);
    };
  }, [videoRef]);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent) => {
      if (
        !speedMenu.current?.contains(event.target as Node) &&
        !speedButton.current?.contains(event.target as Node)
      )
        setMenu(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [menu]);
  const toggle = () => {
    const video = videoRef.current;
    if (!video) return;
    if (playing) video.pause();
    else
      void video
        .play()
        .catch(() => setNotice("Playback paused. Press play to try again."));
  };
  const seek = (seconds: number) => {
    if (!videoRef.current || !duration) return;
    const next = Math.max(0, Math.min(seconds, duration));
    videoRef.current.currentTime = next;
    setTime(next);
    // Keep authoring time and inline handoff synchronized even while paused.
    videoRef.current.dispatchEvent(new Event("timeupdate"));
  };
  const playButton = (
    <button
      data-buzz-ui=""
      type="button"
      className={inline ? styles.center : styles.play}
      aria-label={playing ? "Pause video" : "Play video"}
      onClick={toggle}
    >
      {playing ? (
        <PauseIcon
          size={inline ? 24 : 18}
          weight="fill"
          color="var(--text-standard)"
        />
      ) : (
        <PlayIcon
          size={inline ? 24 : 18}
          weight="fill"
          color="var(--text-standard)"
        />
      )}
    </button>
  );
  return (
    <>
      {inline && playButton}
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      <div
        ref={inline ? corners : undefined}
        className={styles.controls}
        data-inline={inline || undefined}
        data-review-chrome={inline ? undefined : ""}
      >
        {!inline && playButton}
        <span className={styles.time}>{videoTime(time)}</span>
        <div
          className={styles.timeline}
          onPointerMove={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            setHover(
              Math.max(
                0,
                Math.min(1, (event.clientX - bounds.left) / bounds.width),
              ),
            );
          }}
          onPointerLeave={() => setHover(undefined)}
        >
          <input
            type="range"
            aria-label={inline ? "Video progress" : "Video timeline"}
            aria-valuetext={`${videoTime(time)} / ${videoTime(duration)}`}
            min={0}
            max={duration || 1}
            step={0.1}
            value={Math.min(time, duration)}
            disabled={!duration}
            style={
              {
                "--progress": `${duration ? (time / duration) * 100 : 0}%`,
              } as CSSProperties
            }
            onChange={(event) => seek(Number(event.currentTarget.value))}
          />
          {!inline && hover !== undefined && duration > 0 && (
            <span
              className={styles.hoverTime}
              style={{ left: `${hover * 100}%` }}
            >
              {videoTime(hover * duration)} / {videoTime(duration)}
            </span>
          )}
          {duration > 0 &&
            markers
              .filter((marker) => marker.seconds <= duration)
              .map((marker) => (
                <button
                  data-buzz-ui=""
                  key={marker.id}
                  type="button"
                  className={styles.marker}
                  style={{ left: `${(marker.seconds / duration) * 100}%` }}
                  aria-label={`Seek to ${marker.label}, ${marker.author}`}
                  title={`${marker.label} · ${marker.author}: ${marker.text}`}
                  onClick={() => {
                    seek(marker.seconds);
                    onMarker?.(marker.id, marker.seconds);
                  }}
                >
                  <Avatar
                    size="fill"
                    src={marker.picture}
                    alt=""
                    fallback={marker.author}
                  />
                </button>
              ))}
        </div>
        <span className={`${styles.time} ${styles.duration}`}>
          {videoTime(duration)}
        </span>
        <div className={styles.speed}>
          <button
            data-buzz-ui=""
            ref={speedButton}
            type="button"
            aria-label={`Playback speed: ${rate}x`}
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            {rate}x
          </button>
          {menu && (
            <fieldset
              ref={speedMenu}
              className={styles.speedMenu}
              aria-label="Playback speed"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setMenu(false);
                  speedButton.current?.focus();
                }
              }}
            >
              <span>Speed</span>
              {speeds.map((speed) => (
                <button
                  data-buzz-ui=""
                  type="button"
                  key={speed}
                  aria-pressed={rate === speed}
                  onClick={() => {
                    if (videoRef.current) videoRef.current.playbackRate = speed;
                    setRate(speed);
                    try {
                      localStorage.setItem(speedKey, String(speed));
                    } catch {
                      /* Playback works without storage. */
                    }
                    window.dispatchEvent(
                      new CustomEvent(speedEvent, { detail: speed }),
                    );
                    setMenu(false);
                    speedButton.current?.focus();
                  }}
                >
                  {speed}x {rate === speed ? "✓" : ""}
                </button>
              ))}
            </fieldset>
          )}
        </div>
        <div className={styles.volume}>
          <button
            data-buzz-ui=""
            type="button"
            aria-label={muted || volume === 0 ? "Unmute video" : "Mute video"}
            onClick={() => {
              const video = videoRef.current;
              if (!video) return;
              video.muted = !(muted || volume === 0);
              if (!video.muted && video.volume === 0) video.volume = 1;
            }}
          >
            {muted || volume === 0 ? (
              <SpeakerSlashIcon size={18} />
            ) : (
              <SpeakerHighIcon size={18} />
            )}
          </button>
          <input
            type="range"
            aria-label="Video volume"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            style={
              {
                "--progress": `${(muted ? 0 : volume) * 100}%`,
              } as CSSProperties
            }
            onChange={(event) => {
              if (!videoRef.current) return;
              videoRef.current.volume = Number(event.currentTarget.value);
              videoRef.current.muted = false;
            }}
          />
        </div>
      </div>
    </>
  );
}

export function VideoPlayer({
  source,
  poster,
  videoRef,
  initialTime = 0,
  onTime,
  onError,
  markers,
  onMarker,
  children,
}: {
  source: string;
  poster?: string | undefined;
  videoRef: RefObject<HTMLVideoElement | null>;
  initialTime?: number;
  onTime(seconds: number): void;
  onError(): void;
  markers?: readonly VideoMarker[];
  onMarker?(id: string, seconds: number): void;
  children?: ReactNode;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const idle = useMediaControls(stage, source);
  const { handlers: gestures, feedback } = useVideoGestures(videoRef, source);
  return (
    <div
      ref={stage}
      className={`${styles.player} dark`}
      data-color-mode="dark"
      data-controls-idle={idle || undefined}
    >
      <video
        ref={videoRef}
        {...gestures}
        data-review-media=""
        src={source}
        poster={poster}
        playsInline
        autoPlay
        preload="auto"
        onPlay={(event) => {
          // A pending play request can settle after dismissal has begun.
          if (event.currentTarget.closest("[data-review-closing]"))
            event.currentTarget.pause();
        }}
        onLoadedMetadata={(event) => {
          const element = event.currentTarget;
          element.currentTime = Math.max(
            0,
            Math.min(
              initialTime,
              Number.isFinite(element.duration)
                ? element.duration
                : initialTime,
            ),
          );
          onTime(element.currentTime);
        }}
        onTimeUpdate={(event) => onTime(event.currentTarget.currentTime)}
        onError={onError}
      />
      {feedback && (
        <div
          key={feedback.id}
          className={`${styles.center} ${styles.gestureFeedback}`}
          data-video-feedback={feedback.kind}
          data-review-chrome=""
          aria-hidden="true"
        >
          {feedback.kind === "play" ? (
            <PlayIcon size={24} weight="fill" />
          ) : feedback.kind === "pause" ? (
            <PauseIcon size={24} weight="fill" />
          ) : feedback.kind === "speed" ? (
            <span>2×</span>
          ) : (
            <>
              {feedback.kind === "forward" ? (
                <ArrowClockwiseIcon size={36} />
              ) : (
                <ArrowCounterClockwiseIcon size={36} />
              )}
              <span className={styles.seekAmount}>10</span>
            </>
          )}
        </div>
      )}
      <VideoControls
        videoRef={videoRef}
        {...(markers ? { markers } : {})}
        {...(onMarker ? { onMarker } : {})}
      />
      {children}
    </div>
  );
}
