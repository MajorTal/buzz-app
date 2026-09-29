import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { readView, writeView } from "../../shared/view-state";

export const CHANNEL_SIDEBAR_DEFAULT_WIDTH = 260;
export const CHANNEL_SIDEBAR_MIN_WIDTH = 220;
export const CHANNEL_SIDEBAR_MAX_WIDTH = 520;

export function clampChannelSidebarWidth(width: number) {
  return Math.min(
    CHANNEL_SIDEBAR_MAX_WIDTH,
    Math.max(CHANNEL_SIDEBAR_MIN_WIDTH, Math.round(width)),
  );
}

type SidebarView = {
  collapsed: string[];
  scrollTop: number;
  width: number;
};

// Preserve explicit resize intent across route remounts when storage is unavailable.
const widths = new Map<string, number>();

function restore(scope: string): SidebarView {
  const raw = readView<unknown>(scope, "channel-sidebar", null);
  const saved =
    raw && typeof raw === "object" ? (raw as Partial<SidebarView>) : {};
  return {
    collapsed: Array.isArray(saved.collapsed)
      ? saved.collapsed.filter((key): key is string => typeof key === "string")
      : [],
    scrollTop:
      typeof saved.scrollTop === "number" &&
      Number.isFinite(saved.scrollTop) &&
      saved.scrollTop >= 0
        ? saved.scrollTop
        : 0,
    width:
      widths.get(scope) ??
      (typeof saved.width === "number" && Number.isFinite(saved.width)
        ? clampChannelSidebarWidth(saved.width)
        : CHANNEL_SIDEBAR_DEFAULT_WIDTH),
  };
}

/** Scoped to the ready community/viewer workspace; no roster or message cache. */
export function readChannelSidebarWidth(scope: string): number {
  return restore(scope).width;
}

export function useSidebarView(scope: string, ready: boolean) {
  const [view, setView] = useState(() => restore(scope));
  const intent = useRef(view);
  const list = useRef<HTMLElement>(null);
  const pending = useRef(true);

  // Once the viewport moves, the user owns it even if they return to the top.
  useLayoutEffect(() => {
    const viewport = list.current;
    if (!viewport) return;
    const scrolled = () => {
      pending.current = false;
    };
    viewport.addEventListener("scroll", scrolled, { passive: true });
    return () => viewport.removeEventListener("scroll", scrolled);
  }, []);

  // Wait for roster/group layout, not optional profile enrichment or messages.
  useLayoutEffect(() => {
    if (!ready || !pending.current || !list.current) return;
    // Compositor scrolling may update the position before its scroll event.
    if (list.current.scrollTop === 0)
      list.current.scrollTop = intent.current.scrollTop;
    pending.current = false;
  }, [ready]);
  useLayoutEffect(() => {
    const save = () => {
      if (!pending.current && list.current)
        intent.current = {
          ...intent.current,
          scrollTop: list.current.scrollTop,
        };
      writeView(scope, "channel-sidebar", intent.current);
    };
    window.addEventListener("pagehide", save);
    return () => {
      save();
      window.removeEventListener("pagehide", save);
    };
  }, [scope]);

  const update = useCallback((next: SidebarView) => {
    intent.current = next;
    setView(next);
  }, []);
  const toggle = useCallback(
    (key: string, open: boolean) => {
      const collapsed = intent.current.collapsed;
      if (collapsed.includes(key) === !open) return;
      pending.current = false;
      update({
        ...intent.current,
        collapsed: open
          ? collapsed.filter((id) => id !== key)
          : [...collapsed, key],
      });
    },
    [update],
  );
  return {
    list,
    collapsed: view.collapsed,
    width: view.width,
    toggle,
    setWidth: (width: number) => {
      const next = clampChannelSidebarWidth(width);
      if (intent.current.width === next) return;
      widths.set(scope, next);
      update({ ...intent.current, width: next });
      writeView(scope, "channel-sidebar", { ...intent.current, width: next });
    },
  };
}
