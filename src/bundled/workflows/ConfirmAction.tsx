import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
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
    <AlertDialog
      title={title}
      description={description}
      pending={pending}
      onClose={onCancel}
      actions={
        <>
          <Button disabled={pending} onClick={onCancel}>
            Keep editing
          </Button>
          <Button variant="prominent" disabled={pending} onClick={onConfirm}>
            {action}
          </Button>
        </>
      }
    >
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
    </AlertDialog>
  );
}
