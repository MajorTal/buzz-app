import { useCallback } from "react";
import { mediaCornerClip } from "./media-corners";

/** CSS chooses where to clip, so floating menus can escape the media surface. */
export function useMediaCorners() {
  return useCallback((element: HTMLElement | null) => {
    if (!element || typeof ResizeObserver === "undefined") return;
    const sync = () => {
      const { offsetWidth: width, offsetHeight: height } = element;
      if (!width || !height) return;
      const radius = Number.parseFloat(
        getComputedStyle(element).borderTopLeftRadius,
      );
      const clip = mediaCornerClip(width, height, radius || 0);
      if (element.style.getPropertyValue("--media-corner-clip") !== clip)
        element.style.setProperty("--media-corner-clip", clip);
      element.dataset.smoothCorners = "";
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => {
      observer.disconnect();
      element.style.removeProperty("--media-corner-clip");
      delete element.dataset.smoothCorners;
    };
  }, []);
}
