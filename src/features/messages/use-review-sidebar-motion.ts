import { useLayoutEffect, useRef, type RefObject } from "react";

function pictureBounds(media: HTMLImageElement | HTMLVideoElement) {
  const bounds = media.getBoundingClientRect();
  // Account for an interrupted scale and the space reserved for video controls.
  const scale = media.offsetHeight ? bounds.height / media.offsetHeight : 1;
  const padding =
    (Number.parseFloat(getComputedStyle(media).paddingBottom) || 0) * scale;
  const naturalWidth =
    media instanceof HTMLImageElement ? media.naturalWidth : media.videoWidth;
  const naturalHeight =
    media instanceof HTMLImageElement ? media.naturalHeight : media.videoHeight;
  const height = bounds.height - padding;
  if (bounds.width <= 0 || height <= 0) return undefined;
  const aspect =
    naturalWidth && naturalHeight
      ? naturalWidth / naturalHeight
      : bounds.width / height;
  const width = Math.min(bounds.width, height * aspect);
  return {
    left: bounds.left + (bounds.width - width) / 2,
    top: bounds.top + (height - width / aspect) / 2,
    width,
    height: width / aspect,
  };
}

/** Resize the layout once; move the live picture instead of resizing a GIF every frame. */
export function useReviewSidebarMotion(
  frame: RefObject<HTMLElement | null>,
  open: boolean,
) {
  const previous = useRef<ReturnType<typeof pictureBounds> | undefined>(
    undefined,
  );
  const cancel = useRef<() => void>(() => {});
  const prepare = (pointer: boolean) => {
    const media = frame.current?.querySelector<
      HTMLImageElement | HTMLVideoElement
    >("[data-review-media]");
    previous.current =
      pointer &&
      media &&
      !media.closest("[data-review-zoomed]") &&
      !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
        ? pictureBounds(media)
        : undefined;
    cancel.current();
  };
  useLayoutEffect(() => {
    void open;
    const from = previous.current;
    previous.current = undefined;
    const panel = frame.current;
    const media = panel?.querySelector<HTMLImageElement | HTMLVideoElement>(
      "[data-review-media]",
    );
    if (!from || !panel || !media?.animate) return;
    const to = pictureBounds(media);
    if (!to || from.width <= 0 || to.width <= 0) return;
    const bounds = media.getBoundingClientRect();
    const origin = `${to.left + to.width / 2 - bounds.left}px ${to.top + to.height / 2 - bounds.top}px`;
    panel.dataset.reviewResizing = "";
    const animation = media.animate(
      [
        {
          transformOrigin: origin,
          transform: `translate(${from.left + from.width / 2 - to.left - to.width / 2}px, ${from.top + from.height / 2 - to.top - to.height / 2}px) scale(${from.width / to.width})`,
        },
        { transformOrigin: origin, transform: "none" },
      ],
      { duration: 200, easing: "cubic-bezier(0.19, 1, 0.22, 1)" },
    );
    const settle = () => {
      delete panel.dataset.reviewResizing;
    };
    const stop = () => {
      animation.cancel();
      settle();
    };
    animation.onfinish = settle;
    animation.oncancel = settle;
    cancel.current = stop;
    panel.addEventListener("pointerdown", stop, { once: true });
    panel.addEventListener("wheel", stop, { once: true, passive: true });
    panel.addEventListener("keydown", stop, { once: true });
    window.addEventListener("resize", stop, { once: true });
    const reducedMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    );
    reducedMotion?.addEventListener("change", stop);
    return () => {
      stop();
      panel.removeEventListener("pointerdown", stop);
      panel.removeEventListener("wheel", stop);
      panel.removeEventListener("keydown", stop);
      window.removeEventListener("resize", stop);
      reducedMotion?.removeEventListener("change", stop);
      cancel.current = () => {};
    };
  }, [frame, open]);
  return prepare;
}
