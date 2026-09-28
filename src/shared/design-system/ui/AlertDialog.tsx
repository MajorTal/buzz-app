import { AlertDialog as BaseAlertDialog } from "@base-ui/react/alert-dialog";
import type { ComponentProps, ReactNode } from "react";

/** Confirmations keep alert-dialog semantics and focus behavior owned by Base UI. */
export function AlertDialog({
  title,
  description,
  children,
  actions,
  onClose,
  pending = false,
  finalFocus,
}: {
  title: ReactNode;
  description: ReactNode;
  children?: ReactNode;
  actions: ReactNode;
  onClose(): void;
  pending?: boolean;
  finalFocus?: ComponentProps<typeof BaseAlertDialog.Popup>["finalFocus"];
}) {
  return (
    <BaseAlertDialog.Root
      open
      onOpenChange={(open, details) => {
        if (!open && pending) details.cancel();
        else if (!open) onClose();
      }}
    >
      <BaseAlertDialog.Portal>
        <BaseAlertDialog.Backdrop
          data-buzz-ui=""
          className="buzz-dialog-backdrop"
        />
        <BaseAlertDialog.Popup
          data-buzz-ui=""
          className="buzz-dialog"
          aria-modal="true"
          finalFocus={finalFocus}
        >
          <BaseAlertDialog.Title className="text-heading">
            {title}
          </BaseAlertDialog.Title>
          <BaseAlertDialog.Description className="buzz-dialog-description">
            {description}
          </BaseAlertDialog.Description>
          {children}
          <div className="buzz-dialog-actions">{actions}</div>
        </BaseAlertDialog.Popup>
      </BaseAlertDialog.Portal>
    </BaseAlertDialog.Root>
  );
}
