import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import {
  AnimatePresence,
  motion,
  useIsPresent,
  useReducedMotion,
} from "motion/react";
import { XIcon } from "../icons";
import { useState, type ComponentProps, type ReactNode } from "react";
import { IconButton } from "./IconButton";
import { useFinalFocusUnlessMoved } from "./finalFocus";

type PopupProps = ComponentProps<typeof BaseDialog.Popup>;
export type DialogProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  onOpenChangeComplete?: ComponentProps<
    typeof BaseDialog.Root
  >["onOpenChangeComplete"];
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  /** Tighter heading-to-body spacing for compact forms. */
  headerGap?: "default" | "compact";
  /** Keep a final body control close to its confirmation actions. */
  footerGap?: "default" | "compact";
  /** Replace a step inside this modal; scale defines its recessed/raised position. */
  step?: { key: string; scale: number };
  leadingActions?: ReactNode;
  headerActions?: ReactNode;
  /** Return true when an inner editor layer consumed Escape. */
  onEscape?: () => boolean;
  placement?: "center" | "right";
  dismissOnOutsideClick?: boolean;
  closeLabel?: string;
  /** Reserve viewport-capped space for changing content; scroll only the body. */
  height?: "content" | "stable";
  /** Let bounded content own its scrolling instead of the shared body. */
  bodyLayout?: "flow" | "flex";
  /** Expanded reading surfaces retain the same modal/focus behavior. */
  size?: "default" | "expanded";
  /** Keep frequent surfaces such as search palettes immediate. */
  motion?: "default" | "none";
  /** A pending operation can prevent all user dismissal paths. */
  preventClose?: boolean;
  initialFocus?: PopupProps["initialFocus"];
  finalFocus?: PopupProps["finalFocus"];
};

/** Base UI owns the modal, portal, focus trap, Escape and focus restoration. */
export function Dialog({
  open,
  onOpenChange,
  onOpenChangeComplete,
  title,
  description,
  children,
  actions,
  headerGap = "default",
  footerGap = "default",
  step,
  leadingActions,
  headerActions,
  onEscape,
  placement = "center",
  dismissOnOutsideClick = false,
  closeLabel = "Close",
  size = "default",
  preventClose = false,
  motion = "default",
  height = "content",
  bodyLayout = "flow",
  initialFocus,
  finalFocus,
}: DialogProps) {
  const [instantClose, setInstantClose] = useState(false);
  const focus = useFinalFocusUnlessMoved(finalFocus, undefined);
  const transition =
    motion === "none" || (!open && instantClose) ? "none" : "default";
  const contents = (
    <>
      <header className="buzz-dialog-header">
        <div className="buzz-dialog-heading">
          {step ? (
            <div className="text-label" aria-hidden="true">
              {title}
            </div>
          ) : (
            <BaseDialog.Title className="text-label">{title}</BaseDialog.Title>
          )}
          {description &&
            (step ? (
              <p className="buzz-dialog-description" aria-hidden="true">
                {description}
              </p>
            ) : (
              <BaseDialog.Description className="buzz-dialog-description">
                {description}
              </BaseDialog.Description>
            ))}
        </div>
        <div className="buzz-dialog-header-actions">
          {headerActions}
          <BaseDialog.Close
            disabled={preventClose}
            render={
              <IconButton
                aria-label={closeLabel}
                disabled={preventClose}
                size="compact"
                icon={<XIcon size={16} aria-hidden="true" />}
              />
            }
          />
        </div>
      </header>
      <div
        className="buzz-dialog-body buzz-dialog-content"
        data-header-gap={headerGap}
        data-footer-gap={footerGap}
      >
        {children}
      </div>
      {(actions || leadingActions) && (
        <footer className="buzz-dialog-actions">
          {leadingActions && (
            <div className="buzz-dialog-leading-actions">{leadingActions}</div>
          )}
          {actions}
        </footer>
      )}
    </>
  );
  return (
    <BaseDialog.Root
      open={open}
      onOpenChangeComplete={onOpenChangeComplete}
      disablePointerDismissal={!dismissOnOutsideClick}
      onOpenChange={(next, details) => {
        if (!next && preventClose) {
          details.cancel();
          return;
        }
        if (!next && details.reason === "escape-key" && onEscape?.()) {
          details.cancel();
          return;
        }
        setInstantClose(details.reason === "escape-key");
        onOpenChange(next);
      }}
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop
          forceRender={placement === "right" || dismissOnOutsideClick}
          data-outside-dismissal={dismissOnOutsideClick || undefined}
          data-placement={placement}
          data-buzz-ui=""
          data-motion={transition}
          className="buzz-dialog-backdrop"
        />
        <BaseDialog.Popup
          data-buzz-ui=""
          className="buzz-dialog gap-0"
          data-placement={placement}
          data-height={height}
          data-body-layout={bodyLayout}
          data-stepped={step ? "" : undefined}
          data-size={size}
          data-motion={transition}
          aria-modal="true"
          initialFocus={initialFocus}
          ref={focus.ref}
          finalFocus={focus.finalFocus}
        >
          {step ? (
            <>
              {/* One stable accessible label, even while two visual steps crossfade. */}
              <BaseDialog.Title className="sr-only">{title}</BaseDialog.Title>
              {description && (
                <BaseDialog.Description className="sr-only">
                  {description}
                </BaseDialog.Description>
              )}
              <AnimatePresence initial={false}>
                <DialogStep
                  key={step.key}
                  scale={step.scale}
                  instant={motion === "none"}
                >
                  {contents}
                </DialogStep>
              </AnimatePresence>
            </>
          ) : (
            contents
          )}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

/** Exiting content is visual only; Base UI still owns the single focus trap. */
function DialogStep({
  scale,
  instant: noMotion,
  children,
}: {
  scale: number;
  instant: boolean;
  children: ReactNode;
}) {
  const present = useIsPresent();
  const reduceMotion = useReducedMotion();
  const instant =
    noMotion ||
    reduceMotion ||
    (typeof document !== "undefined" &&
      document.documentElement.hasAttribute("data-keyboard-navigation"));
  const away = {
    opacity: 0,
    scale: instant ? 1 : scale,
    filter: instant ? "blur(0px)" : "blur(4px)",
  };
  return (
    <motion.div
      className="buzz-dialog-step"
      inert={!present}
      aria-hidden={!present || undefined}
      initial={away}
      animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
      exit={away}
      transition={{ duration: instant ? 0 : 0.2, ease: [0.2, 0.8, 0.2, 1] }}
    >
      {children}
    </motion.div>
  );
}
