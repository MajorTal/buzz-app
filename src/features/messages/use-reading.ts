import { useEffect, type RefObject } from "react";
import type { RelaySession } from "../relay/session";
import type { ReadingHandle } from "../relay/unread";

/** Consumer-owned observation: focused, visible, settled rows, never virtualizer overscan. */
export function useReading({
  session,
  channelId,
  scroller,
  settled,
}: {
  session: RelaySession;
  channelId: string;
  scroller: RefObject<HTMLElement | null>;
  settled: RefObject<boolean>;
}) {
  useEffect(() => {
    if (!scroller.current) return;
    const element: HTMLElement = scroller.current;
    let handle: ReadingHandle | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const active = () =>
      !stopped &&
      element.isConnected &&
      settled.current &&
      document.visibilityState === "visible" &&
      document.hasFocus() &&
      element.contains(document.activeElement) &&
      element.getClientRects().length > 0;
    function cancel() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      handle?.dispose();
      handle = undefined;
    }
    function visibleIds() {
      const viewport = element.getBoundingClientRect();
      return [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
        .flatMap((row) => {
          const bounds = row.getBoundingClientRect();
          return row.dataset.membershipRow === undefined &&
            row.dataset.messageId &&
            bounds.height > 0 &&
            bounds.width > 0 &&
            bounds.top >= Math.max(viewport.top, 0) &&
            bounds.bottom <= Math.min(viewport.bottom, window.innerHeight) &&
            bounds.left >= Math.max(viewport.left, 0) &&
            bounds.right <= Math.min(viewport.right, window.innerWidth)
            ? [row.dataset.messageId]
            : [];
        })
        .slice(0, 128);
    }
    function schedule() {
      cancel();
      if (!active()) return;
      const ids = visibleIds();
      if (!ids.length) return;
      try {
        // Capture the lease BEFORE dwell: a newer manual action invalidates it.
        handle = session.unread.reading(channelId);
        handle.view(ids, active);
      } catch {
        return; // Membership may disappear between commit and observation.
      }
      timer = setTimeout(() => {
        timer = undefined;
        if (!active()) {
          cancel();
          return;
        }
        const visible = new Set(visibleIds());
        // A row appearing only at the end of the interval has not had a dwell.
        const remained = ids.filter((id) => visible.has(id));
        if (
          remained.length &&
          session.unread.sync().capability === "frontier-sync"
        )
          void handle?.observe(remained).catch(() => {});
      }, 750);
    }
    for (const event of [
      "scroll",
      "focusin",
      "focusout",
      "pointerdown",
      "keydown",
    ])
      element.addEventListener(event, schedule);
    window.addEventListener("blur", cancel);
    window.addEventListener("focus", schedule);
    document.addEventListener("visibilitychange", schedule);
    const mutation = new MutationObserver(schedule);
    mutation.observe(element, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    schedule();
    return () => {
      stopped = true;
      cancel();
      mutation.disconnect();
      resize.disconnect();
      for (const event of [
        "scroll",
        "focusin",
        "focusout",
        "pointerdown",
        "keydown",
      ])
        element.removeEventListener(event, schedule);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("focus", schedule);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [session, channelId, scroller, settled]);
}
