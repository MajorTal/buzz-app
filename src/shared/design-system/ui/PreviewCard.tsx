import { PreviewCard as BasePreviewCard } from "@base-ui/react/preview-card";
import {
  useCallback,
  useRef,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { behindActiveModal, observeModals } from "../modalLayer";

export type PreviewCardProps = {
  /** The one interactive element that anchors and reveals this preview. */
  trigger: ReactElement;
  /** Context that supplements, but never replaces, the trigger's destination. */
  children: ReactNode;
  open?: boolean;
  onOpenChange?: BasePreviewCard.Root.Props["onOpenChange"];
  side?: BasePreviewCard.Positioner.Props["side"];
  /** Optional content anchor when the trigger owns a wider hit area. */
  anchor?: BasePreviewCard.Positioner.Props["anchor"];
  delay?: number;
  className?: string;
  id?: string;
  "aria-label"?: string;
  /** Optional anchor that makes the whole card open the trigger's destination. */
  link?: ReactElement;
  /** One supplemental action, reachable from the trigger with Tab. Not used with link. */
  actionRef?: RefObject<HTMLButtonElement | null>;
};

/**
 * A non-modal, portal-rendered preview of a resolved object.
 *
 * Base UI owns the hover/focus timing, anchored positioning, viewport collision,
 * and portal lifecycle. The preview stays supplemental: it does not take focus
 * automatically. A destination card can be reached with Tab.
 */
export function PreviewCard({
  trigger,
  children,
  open,
  onOpenChange,
  side = "bottom",
  anchor,
  delay = 250,
  className,
  id,
  link,
  actionRef,
  "aria-label": label,
}: PreviewCardProps) {
  const triggerRef = useRef<HTMLAnchorElement>(null);
  const actions = useRef<BasePreviewCard.Root.Actions>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const promote = useCallback((positioner: HTMLDivElement) => {
    // Join the top layer after the hovered row's floating actions, but not
    // above a modal the trigger is outside. The portal is never inside one.
    // Base UI still owns placement, timing, focus and unmounting.
    const update = () => {
      const trigger = triggerRef.current;
      if (trigger && behindActiveModal(trigger)) positioner.hidePopover?.();
      else positioner.showPopover?.();
    };
    update();
    const stopObserving = observeModals(update);
    // Hover cannot see its trigger scroll away from a still pointer: the
    // preview would stay open, follow the trigger out of its scroller and
    // take the wheel. Keyboard focus keeps its preview, because focusing a
    // clipped trigger scrolls it into view.
    const closeOnScroll = ({ target }: Event) => {
      const trigger = triggerRef.current;
      const popup = popupRef.current;
      const keyboard = ":focus-visible, :has(:focus-visible)";
      if (
        trigger &&
        target instanceof Node &&
        target.contains(trigger) &&
        popup?.hasAttribute("data-open") &&
        !trigger.matches(keyboard) &&
        !popup.matches(keyboard)
      )
        actions.current?.close();
    };
    document.addEventListener("scroll", closeOnScroll, {
      capture: true,
      passive: true,
    });
    return () => {
      stopObserving();
      document.removeEventListener("scroll", closeOnScroll, true);
    };
  }, []);
  const focusedTrigger = useRef<HTMLElement | null>(null);
  const closingPopup = useRef<HTMLDivElement | null>(null);
  const restoreFocus = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    // Pointer entry may never focus a child of a non-focusable trigger wrapper.
    const candidates = [
      focusedTrigger.current,
      trigger,
      ...trigger.querySelectorAll<HTMLElement>(
        "button, a[href], input, select, textarea, [tabindex]",
      ),
    ];
    for (const candidate of candidates) {
      if (!candidate || !trigger.contains(candidate)) continue;
      candidate.focus();
      if (document.activeElement === candidate) return;
    }
  };
  return (
    <BasePreviewCard.Root
      open={open}
      actionsRef={actions}
      onOpenChange={(next, details) => {
        onOpenChange?.(next, details);
        if (details.isCanceled) return;
        closingPopup.current =
          !next &&
          details.reason === "escape-key" &&
          popupRef.current?.contains(document.activeElement)
            ? popupRef.current
            : null;
      }}
      onOpenChangeComplete={(next) => {
        if (next) return;
        // Retain the closing element through unmount, as finalFocus.ts does.
        // Escape grants return-focus ownership only until the user moves it.
        const popup = closingPopup.current;
        closingPopup.current = null;
        const active = popup?.ownerDocument.activeElement ?? null;
        if (
          popup &&
          (active === popup.ownerDocument.body || popup.contains(active))
        )
          restoreFocus();
      }}
    >
      <BasePreviewCard.Trigger
        render={trigger}
        delay={actionRef ? 0 : delay}
        closeDelay={150}
        ref={triggerRef}
        onFocus={(event) => {
          focusedTrigger.current = event.target as HTMLElement;
        }}
        onKeyDown={(event) => {
          if (
            (link || actionRef) &&
            event.key === "Tab" &&
            !event.shiftKey &&
            popupRef.current?.hasAttribute("data-open") &&
            !popupRef.current.closest("[data-anchor-hidden]")
          ) {
            event.preventDefault();
            (actionRef?.current ?? popupRef.current).focus();
          }
        }}
      />
      <BasePreviewCard.Portal>
        <BasePreviewCard.Positioner
          side={side}
          anchor={anchor}
          align="start"
          sideOffset={8}
          positionMethod="fixed"
          popover="manual"
          ref={promote}
          className="buzz-preview-card-positioner"
        >
          <BasePreviewCard.Popup
            id={id}
            data-buzz-ui=""
            ref={popupRef}
            onKeyDown={(event) => {
              if ((link || actionRef) && event.key === "Tab") {
                // The portal is at the end of the document. Resume from its
                // trigger so Tab order follows the link's position in prose.
                restoreFocus();
                if (event.shiftKey) event.preventDefault();
              }
            }}
            className={["buzz-preview-card", className]
              .filter(Boolean)
              .join(" ")}
            render={link}
            role={link ? "link" : actionRef ? "dialog" : "tooltip"}
            aria-modal={actionRef ? false : undefined}
            data-interactive={actionRef ? "" : undefined}
            tabIndex={link ? 0 : undefined}
            data-destination={link ? "" : undefined}
            aria-label={label}
          >
            {children}
          </BasePreviewCard.Popup>
        </BasePreviewCard.Positioner>
      </BasePreviewCard.Portal>
    </BasePreviewCard.Root>
  );
}
