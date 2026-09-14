import { useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import type {
  WorkflowDefinition,
  WorkflowOperation,
} from "../../features/workflows/types";
import { ConfirmAction } from "./ConfirmAction";

const messages = {
  save: {
    pending: "Saving configuration…",
    succeeded: "Configuration saved.",
    rejected: "Configuration was not saved.",
    unknown:
      "Save response was lost. Check the saved configuration before trying again.",
  },
  trigger: {
    pending: "Requesting a run…",
    succeeded: "Run requested. Inspect run history for its result.",
    rejected: "Run request was rejected.",
    unknown:
      "The run may have started, but its response was lost. Checking configuration or dismissing this notice cannot confirm a run.",
  },
  delete: {
    pending: "Requesting deletion…",
    succeeded:
      "Deletion request accepted. The saved configuration may remain visible; acceptance does not confirm runtime deletion.",
    rejected: "Deletion request was rejected.",
    unknown:
      "The deletion outcome is unknown. The saved configuration may remain visible; do not assume the runtime workflow was deleted.",
  },
} as const;

export function WorkflowOperations({
  operations,
  definitions,
  onCheckSaved,
  onReviewSaved,
  onDismiss,
}: {
  operations: readonly WorkflowOperation[];
  definitions: readonly WorkflowDefinition[];
  onCheckSaved: () => Promise<void>;
  onReviewSaved: (definition: WorkflowDefinition) => void;
  onDismiss: (eventId: string) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [acknowledge, setAcknowledge] = useState<WorkflowOperation | null>(
    null,
  );
  const [working, setWorking] = useState(false);
  const perform = async (action: () => Promise<void>) => {
    setWorking(true);
    try {
      await action();
      setError(null);
      setAcknowledge(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The request could not be completed. Try again.",
      );
    } finally {
      setWorking(false);
    }
  };
  if (!operations.length && !acknowledge) return null;
  return (
    <section aria-label="Workflow operations" className="workflow-operations">
      <h3 className="text-heading">Recent activity</h3>
      {error && !acknowledge && <p role="alert">{error}</p>}
      {operations.map((operation) => {
        const current = definitions.find(
          (definition) =>
            definition.id === operation.workflow.id &&
            definition.owner === operation.workflow.owner &&
            definition.channelId === operation.workflow.channelId,
        );
        return (
          <div key={operation.eventId}>
            <p role="status">{messages[operation.action][operation.outcome]}</p>
            {operation.error && (
              <p className="text-red-12">{operation.error}</p>
            )}
            <div className="workflow-toolbar">
              {operation.action === "save" &&
                (operation.outcome === "unknown" ||
                  operation.outcome === "succeeded") && (
                  <>
                    <Button
                      size="compact"
                      disabled={working}
                      onClick={() => void perform(onCheckSaved)}
                    >
                      Check saved configuration
                    </Button>
                    {current && current.revision !== operation.eventId && (
                      <Button
                        size="compact"
                        disabled={working}
                        onClick={() => onReviewSaved(current)}
                      >
                        Review current configuration
                      </Button>
                    )}
                  </>
                )}
              {operation.outcome !== "pending" && (
                <Button
                  size="compact"
                  disabled={working}
                  onClick={() => setAcknowledge(operation)}
                >
                  Dismiss notice
                </Button>
              )}
            </div>
            <details>
              <summary>Delivery details</summary>
              <p className="text-body-sm">
                {operation.action}: {operation.outcome} · delivery{" "}
                {operation.delivery}
              </p>
              <p className="text-mono-sm workflow-key">
                Event ID: {operation.eventId}
              </p>
              {operation.runId && (
                <p className="text-mono-sm workflow-key">
                  Returned run ID: {operation.runId}
                </p>
              )}
            </details>
          </div>
        );
      })}
      {acknowledge && (
        <ConfirmAction
          title="Dismiss this notice?"
          pending={working}
          error={error}
          description="Dismissal only clears this notice and its editor lock. It does not undo, cancel or repeat a command, and it does not prove an unknown command failed. Review the saved configuration before saving again; a new run request may run the workflow again. Your unsaved draft is kept."
          action={working ? "Dismissing…" : "Dismiss notice and continue"}
          onConfirm={() => {
            if (!working) void perform(() => onDismiss(acknowledge.eventId));
          }}
          onCancel={() => {
            if (!working) setAcknowledge(null);
          }}
        />
      )}
    </section>
  );
}
