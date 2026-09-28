import { useEffect, useRef, useState, type RefObject } from "react";

type FeedbackKind = "play" | "pause" | "forward" | "backward" | "speed";

export function seekVideoBy(element: HTMLVideoElement, seconds: number) {
  element.currentTime = Math.max(
    0,
    Math.min(
      element.currentTime + seconds,
      Number.isFinite(element.duration) ? element.duration : Infinity,
    ),
  );
  element.dispatchEvent(new Event("timeupdate"));
}

/** Picture gestures never intercept the separate playback controls. */
export function useVideoGestures(
  video: RefObject<HTMLVideoElement | null>,
  source: string,
) {
  const [feedback, setFeedback] = useState<{
    kind: FeedbackKind;
    id: number;
  }>();
  const feedbackId = useRef(0);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const showFeedback = (kind: FeedbackKind) => {
    clearTimeout(feedbackTimer.current);
    setFeedback({ kind, id: ++feedbackId.current });
    if (kind !== "speed")
      feedbackTimer.current = setTimeout(() => setFeedback(undefined), 650);
  };
  const clickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const held = useRef<{ rate: number; paused: boolean } | undefined>(undefined);
  const suppressClick = useRef(false);
  const clickState = useRef<
    { paused: boolean; committed: boolean } | undefined
  >(undefined);
  const clearClick = () => {
    clearTimeout(clickTimer.current);
    clickTimer.current = undefined;
  };
  const endHold = () => {
    clearTimeout(holdTimer.current);
    holdTimer.current = undefined;
    const previous = held.current;
    held.current = undefined;
    const element = video.current;
    if (!previous || !element) return;
    setFeedback(undefined);
    element.playbackRate = previous.rate;
    if (previous.paused) element.pause();
  };
  const cancel = useRef(() => {});
  cancel.current = () => {
    clearClick();
    endHold();
  };
  useEffect(() => {
    void source;
    const element = video.current;
    const stop = () => {
      cancel.current();
      clearTimeout(feedbackTimer.current);
      setFeedback(undefined);
    };
    const hidden = () => {
      if (document.hidden) stop();
    };
    window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      stop();
      // StrictMode replays effects while the autoplay video is still mounted.
      if (element && !element.isConnected) element.pause();
      window.removeEventListener("blur", stop);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [source, video]);
  const handlers = {
    onClick(event: React.MouseEvent<HTMLVideoElement>) {
      if (suppressClick.current) return;
      clearClick();
      if (event.detail >= 2) return;
      const previous = { paused: event.currentTarget.paused, committed: false };
      clickState.current = previous;
      showFeedback(previous.paused ? "play" : "pause");
      // Feedback is immediate; only playback waits for double-click detection.
      // Let the browser's double-click gesture seek without toggling playback.
      clickTimer.current = setTimeout(() => {
        const element = video.current;
        if (!element || element.closest("[data-review-closing]")) return;
        previous.committed = true;
        const paused = element.paused;
        if (paused) void element.play().catch(() => {});
        else element.pause();
      }, 250);
    },
    onDoubleClick(event: React.MouseEvent<HTMLVideoElement>) {
      clearClick();
      if (suppressClick.current) return;
      const element = event.currentTarget;
      // Slow OS double-clicks may arrive after the snappy single-click delay.
      // Undo that toggle so seeking still preserves the original playback state.
      const previous = clickState.current;
      clickState.current = undefined;
      if (previous?.committed) {
        if (previous.paused) element.pause();
        else void element.play().catch(() => {});
      }
      const bounds = element.getBoundingClientRect();
      const seconds = event.clientX < bounds.left + bounds.width / 2 ? -10 : 10;
      seekVideoBy(element, seconds);
      showFeedback(seconds > 0 ? "forward" : "backward");
    },
    onPointerDown(event: React.PointerEvent<HTMLVideoElement>) {
      if (event.button !== 0 || !event.isPrimary) return;
      suppressClick.current = false;
      clearClick();
      endHold();
      const element = event.currentTarget;
      const bounds = element.getBoundingClientRect();
      if (event.clientX < bounds.left + bounds.width / 2) return;
      holdTimer.current = setTimeout(() => {
        if (element.closest("[data-review-closing]")) return;
        clearClick();
        suppressClick.current = true;
        clickState.current = undefined;
        const previous = { rate: element.playbackRate, paused: element.paused };
        held.current = previous;
        element.playbackRate = 2;
        showFeedback("speed");
        void element.play().catch(() => {
          if (held.current === previous) endHold();
        });
      }, 350);
    },
    onPointerUp: endHold,
    onPointerLeave: endHold,
    onPointerCancel: endHold,
  };
  return { handlers, feedback };
}
