import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { IconX } from "@tabler/icons-react";
import type { ComponentProps, ReactNode } from "react";
import { IconButton } from "./IconButton";

type PopupProps = ComponentProps<typeof BaseDialog.Popup>;
export type DialogProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  closeLabel?: string;
  /** A pending operation can prevent all user dismissal paths. */
  preventClose?: boolean;
  initialFocus?: PopupProps["initialFocus"];
  finalFocus?: PopupProps["finalFocus"];
};

/** Base UI owns the modal, portal, focus trap, Escape and focus restoration. */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  actions,
  closeLabel = "Close",
  preventClose = false,
  initialFocus,
  finalFocus,
}: DialogProps) {
  return (
    <BaseDialog.Root
      open={open}
      disablePointerDismissal
      onOpenChange={(next, details) => {
        if (!next && preventClose) {
          details.cancel();
          return;
        }
        onOpenChange(next);
      }}
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop data-buzz-ui="" className="buzz-dialog-backdrop" />
        <BaseDialog.Popup
          data-buzz-ui=""
          className="buzz-dialog"
          aria-modal="true"
          initialFocus={initialFocus}
          finalFocus={finalFocus}
        >
          <header className="buzz-dialog-header">
            <BaseDialog.Title className="text-heading">
              {title}
            </BaseDialog.Title>
            <BaseDialog.Close
              disabled={preventClose}
              render={
                <IconButton
                  aria-label={closeLabel}
                  disabled={preventClose}
                  size="compact"
                  icon={<IconX size={16} aria-hidden="true" />}
                />
              }
            />
          </header>
          {description && (
            <BaseDialog.Description className="buzz-dialog-description">
              {description}
            </BaseDialog.Description>
          )}
          <div className="buzz-dialog-body">{children}</div>
          {actions && (
            <footer className="buzz-dialog-actions">{actions}</footer>
          )}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
