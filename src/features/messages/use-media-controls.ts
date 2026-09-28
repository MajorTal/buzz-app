import { useEffect, useState, type RefObject } from "react";

/** Pointer activity reveals controls; CSS keeps keyboard and touch access intact. */
export function useMediaControls(
  stage: RefObject<HTMLElement | null>,
  source?: string,
) {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    void source;
    const element = stage.current;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout>;
    const activity = () => {
      clearTimeout(timer);
      setIdle(false);
      timer = setTimeout(() => setIdle(true), 2200);
    };
    const leave = () => {
      clearTimeout(timer);
      setIdle(true);
    };
    const events = ["pointerenter", "pointermove", "pointerdown", "wheel"];
    for (const event of events)
      element.addEventListener(event, activity, { passive: true });
    element.addEventListener("pointerleave", leave);
    activity();
    return () => {
      clearTimeout(timer);
      for (const event of events) element.removeEventListener(event, activity);
      element.removeEventListener("pointerleave", leave);
    };
  }, [stage, source]);
  return idle;
}
