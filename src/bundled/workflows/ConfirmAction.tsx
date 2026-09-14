import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Button } from "../../shared/design-system/ui/Button";

export function ConfirmAction({
  title,
  description,
  action,
  onConfirm,
  onCancel,
  pending = false,
  error,
}: {
  title: string;
  description: string;
  action: string;
  onConfirm: () => void;
  onCancel: () => void;
  pending?: boolean;
  error?: string | null;
}) {
  return (
    <AlertDialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !pending) onCancel();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="workflow-dialog-backdrop" />
        <AlertDialog.Popup
          data-buzz-ui=""
          className="workflow-dialog text-body"
        >
          <AlertDialog.Title className="text-heading">
            {title}
          </AlertDialog.Title>
          <AlertDialog.Description className="text-secondary">
            {description}
          </AlertDialog.Description>
          {error && (
            <p role="alert" className="text-red-12">
              {error}
            </p>
          )}
          <div className="workflow-toolbar">
            <Button disabled={pending} onClick={onCancel}>
              Keep editing
            </Button>
            <Button variant="primary" disabled={pending} onClick={onConfirm}>
              {action}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
