import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Makes a portalled viewer a real modal and restores its connected opener. */
export function useModalBoundary(
  backdrop: RefObject<HTMLElement | null>,
  initialFocus: RefObject<HTMLElement | null>,
  close: () => void,
  restoreFocus?: RefObject<HTMLElement | null>,
) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    const container = backdrop.current;
    if (!container) return;
    const siblings = [...document.body.children].filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && element !== container,
    );
    const previous = siblings.map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute("aria-hidden"),
    }));
    for (const element of siblings) {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    }
    initialFocus.current?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      // Portalled confirmations own their keyboard handling through Base UI.
      const modal =
        event.target instanceof Element
          ? event.target.closest(
              '[role="alertdialog"][aria-modal="true"], [role="dialog"][aria-modal="true"]',
            )
          : null;
      if (modal && !container.contains(modal)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [
        ...container.querySelectorAll<HTMLElement>(FOCUSABLE),
      ].filter(
        (element) =>
          !element.hidden &&
          !element.closest("[inert]") &&
          element.getClientRects().length > 0,
      );
      if (!focusable.length) {
        event.preventDefault();
        initialFocus.current?.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      const active = document.activeElement;
      const outsideTabStops =
        !container.contains(active) ||
        (active === initialFocus.current &&
          !focusable.some((element) => element === active));
      if (
        outsideTabStops ||
        (event.shiftKey && active === first) ||
        (!event.shiftKey && active === last)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      for (const state of previous) {
        state.element.inert = state.inert;
        if (state.ariaHidden === null)
          state.element.removeAttribute("aria-hidden");
        else state.element.setAttribute("aria-hidden", state.ariaHidden);
      }
      const target = restoreFocus?.current ?? opener;
      if (target?.isConnected)
        requestAnimationFrame(() => target.focus({ preventScroll: true }));
    };
  }, [backdrop, initialFocus, restoreFocus]);
}
