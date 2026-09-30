import {
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import {
  behindActiveModal,
  observeModals,
} from "../../shared/design-system/modalLayer";

const floatingQuery = "(hover: hover) and (pointer: fine)";
const subscribe = (notify: () => void) => {
  const query = window.matchMedia?.(floatingQuery);
  query?.addEventListener("change", notify);
  return () => query?.removeEventListener("change", notify);
};
const snapshot = () => window.matchMedia?.(floatingQuery).matches ?? false;

/** Keep the controls in DOM/tab order while painting outside list containment. */
export function useFloatingActionBar(
  rowRef: RefObject<HTMLDivElement | null> | undefined,
  barRef: RefObject<HTMLDivElement | null>,
  slotRef: RefObject<HTMLDivElement | null>,
  open: boolean,
) {
  const floating = useSyncExternalStore(subscribe, snapshot, () => false);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const row = rowRef?.current;
    const bar = barRef.current;
    if (!floating || !row || !bar) return;
    // Top-layer descendants don't contribute to :hover or :focus-within.
    let hovered = row.matches(":hover") || bar.matches(":hover");
    let focused = row.contains(document.activeElement);
    const update = () => {
      const next =
        hovered ||
        focused ||
        open ||
        !!bar.querySelector('[aria-haspopup][aria-expanded="true"]');
      row.toggleAttribute("data-actions-revealed", next);
      setRevealed(next);
    };
    const enter = () => {
      hovered = true;
      update();
    };
    const leave = () => {
      hovered = false;
      update();
    };
    const focusIn = () => {
      focused = true;
      update();
    };
    const focusOut = (event: FocusEvent) => {
      focused =
        event.relatedTarget instanceof Node &&
        row.contains(event.relatedTarget);
      update();
    };
    row.addEventListener("pointerenter", enter);
    row.addEventListener("pointerleave", leave);
    row.addEventListener("focusin", focusIn);
    row.addEventListener("focusout", focusOut);
    const observer = new MutationObserver(() => {
      // Recheck focus if a control is removed without dispatching focusout.
      focused = row.contains(document.activeElement);
      update();
    });
    observer.observe(bar, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-expanded"],
    });
    update();
    return () => {
      row.removeEventListener("pointerenter", enter);
      row.removeEventListener("pointerleave", leave);
      row.removeEventListener("focusin", focusIn);
      row.removeEventListener("focusout", focusOut);
      observer.disconnect();
      row.removeAttribute("data-actions-revealed");
    };
  }, [floating, open, rowRef, barRef]);

  useLayoutEffect(() => {
    const row = rowRef?.current;
    const bar = barRef.current;
    const slot = slotRef.current;
    if (!floating || !revealed || !row || !bar || !slot) return;
    const scroller = row.closest<HTMLElement>("[data-message-scroller]");
    let frame = 0;
    let needsPosition = true;
    let previousAnchor: DOMRect | undefined;
    const hide = () => {
      if (bar.hasAttribute("popover")) bar.hidePopover?.();
      // Closed popovers return to their slot's containing block. Viewport offsets
      // there would create invisible overflow and interfere with scrolling.
      bar.style.top = "";
      bar.style.left = "";
      bar.style.right = "";
    };
    const position = (anchor: DOMRect) => {
      // A top-layer toolbar can retain hover above a portalled modal's backdrop.
      // Keep actions in the active viewer usable, but suppress background rows.
      if (behindActiveModal(row)) {
        hide();
        return;
      }
      const viewport = scroller?.getBoundingClientRect();
      // The slot marks the toolbar bottom; CSS lifts it above the author line.
      if (
        viewport &&
        (anchor.top <= viewport.top ||
          anchor.top - bar.offsetHeight >= viewport.bottom)
      ) {
        hide();
        return;
      }
      const rtl = getComputedStyle(row).direction === "rtl";
      bar.style.top = `${anchor.top}px`;
      bar.style.left = rtl ? `${anchor.left}px` : "auto";
      bar.style.right = rtl
        ? "auto"
        : `${document.documentElement.clientWidth - anchor.right}px`;
      bar.showPopover?.();
    };
    const schedule = () => {
      needsPosition = true;
    };
    const trackAnchor = () => {
      // Sibling edits/media can move the slot without resizing any observed node.
      // Read only while revealed; avoid positioning work when nothing changed.
      const anchor = slot.getBoundingClientRect();
      if (
        needsPosition ||
        !previousAnchor ||
        anchor.x !== previousAnchor.x ||
        anchor.y !== previousAnchor.y ||
        anchor.width !== previousAnchor.width ||
        anchor.height !== previousAnchor.height
      ) {
        needsPosition = false;
        position(anchor);
        previousAnchor = anchor;
      }
      frame = requestAnimationFrame(trackAnchor);
    };
    trackAnchor();
    document.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(slot);
    observer.observe(row);
    if (scroller) observer.observe(scroller);
    // Observe modals only while reveal is requested, and share the existing
    // coalesced positioning update.
    const unobserveModals = observeModals(schedule);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
      unobserveModals();
      hide();
    };
  }, [floating, revealed, rowRef, barRef, slotRef]);

  return floating;
}
