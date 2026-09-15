import type { ComposerInputElement } from "../messages/composer-dom";
import { useLayoutEffect, useRef, type RefObject } from "react";

/** Portal positioning belongs to the host, not provider previews. The available
 * visual viewport bounds the menu even inside clipped/narrow conversation panels. */
export function useCompletionPosition(
  input: RefObject<ComposerInputElement | null>,
  widthRatio = 1,
) {
  const popup = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = input.current;
    const menu = popup.current;
    if (!element || !menu) return;
    const window = element.ownerDocument.defaultView;
    if (!window) return;
    const anchor = element.closest("form") ?? element;
    const viewport = window.visualViewport;
    const position = () => {
      const rect = anchor.getBoundingClientRect();
      const x = viewport?.offsetLeft ?? 0;
      const y = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const gap = 8;
      const clamp = (value: number) =>
        Math.max(y + gap, Math.min(value, y + height - gap));
      const top = clamp(rect.top - gap);
      const bottom = clamp(rect.bottom + gap);
      const above = Math.max(0, top - y - gap);
      const below = Math.max(0, y + height - bottom - gap);
      const up = above >= below;
      const size = Math.max(
        0,
        Math.min(rect.width * widthRatio, width - gap * 2),
      );
      Object.assign(menu.style, {
        left: `${Math.max(x + gap, Math.min(rect.left, x + width - size - gap))}px`,
        top: `${up ? top : bottom}px`,
        width: `${size}px`,
        maxHeight: `${up ? above : below}px`,
        transform: up ? "translateY(-100%)" : "none",
      });
    };
    position();
    const resize = new ResizeObserver(position);
    resize.observe(anchor);
    // Capture scroll from any containing pane; menu's own scrolling needs no reposition.
    const scroll = (event: Event) => {
      if (!(event.target instanceof Node) || !menu.contains(event.target))
        position();
    };
    window.addEventListener("resize", position);
    window.addEventListener("scroll", scroll, true);
    viewport?.addEventListener("resize", position);
    viewport?.addEventListener("scroll", position);
    return () => {
      resize.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", scroll, true);
      viewport?.removeEventListener("resize", position);
      viewport?.removeEventListener("scroll", position);
    };
  });
  return popup;
}
