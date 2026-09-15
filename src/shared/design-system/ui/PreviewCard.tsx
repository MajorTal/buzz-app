import { PreviewCard as BasePreviewCard } from "@base-ui/react/preview-card";
import { useRef, type ReactElement, type ReactNode } from "react";

export type PreviewCardProps = {
  /** The one interactive element that anchors and reveals this preview. */
  trigger: ReactElement;
  /** Context that supplements, but never replaces, the trigger's destination. */
  children: ReactNode;
  open?: boolean;
  onOpenChange?: BasePreviewCard.Root.Props["onOpenChange"];
  side?: BasePreviewCard.Positioner.Props["side"];
  className?: string;
  "aria-label"?: string;
  /** Optional anchor that makes the whole card open the trigger's destination. */
  link?: ReactElement;
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
  className,
  link,
  "aria-label": label,
}: PreviewCardProps) {
  const triggerRef = useRef<HTMLAnchorElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  return (
    <BasePreviewCard.Root open={open} onOpenChange={onOpenChange}>
      <BasePreviewCard.Trigger
        render={trigger}
        delay={250}
        closeDelay={150}
        ref={triggerRef}
        onKeyDown={(event) => {
          if (
            link &&
            event.key === "Tab" &&
            !event.shiftKey &&
            popupRef.current
          ) {
            event.preventDefault();
            popupRef.current.focus();
          }
        }}
      />
      <BasePreviewCard.Portal>
        <BasePreviewCard.Positioner side={side} align="start" sideOffset={8}>
          <BasePreviewCard.Popup
            data-buzz-ui=""
            ref={popupRef}
            onKeyDown={(event) => {
              if (link && event.key === "Tab") {
                // The portal is at the end of the document. Resume from its
                // trigger so Tab order follows the link's position in prose.
                triggerRef.current?.focus();
                if (event.shiftKey) event.preventDefault();
              }
              if (link && event.key === "Escape") triggerRef.current?.focus();
            }}
            className={["buzz-preview-card", className]
              .filter(Boolean)
              .join(" ")}
            render={link}
            role={link ? "link" : "tooltip"}
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
