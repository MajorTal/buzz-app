import { useEffect, useState } from "react";
import type {
  WorkflowDefinitions,
  WorkflowOperation,
  WorkflowView,
} from "../../features/workflows/types";
import { Button } from "../../shared/design-system/ui/Button";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { ConfirmAction } from "./ConfirmAction";
import { confirmedDeletion } from "./editor-model";
import { readWorkflowDocumentFields } from "./workflowYamlDocument";

type Snapshot = ReturnType<WorkflowView<WorkflowDefinitions>["snapshot"]>;

/** Recovery stays on the grid and never needs to mount a workflow editor. */
export function WorkflowDeletionNotices({
  operations,
  snapshots,
  onCheck,
  onDismiss,
}: {
  operations: readonly WorkflowOperation[];
  snapshots: Readonly<Record<string, Snapshot>>;
  onCheck: (channelIds: readonly string[]) => void;
  onDismiss: (operation: WorkflowOperation) => Promise<void>;
}) {
  const [acknowledge, setAcknowledge] = useState<WorkflowOperation>();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const dismiss = async () => {
    if (!acknowledge || working) return;
    setWorking(true);
    try {
      await onDismiss(acknowledge);
      setAcknowledge(undefined);
      setError(undefined);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Couldn't dismiss this notice. Try again.",
      );
    } finally {
      setWorking(false);
    }
  };
  const acknowledgeSnapshot =
    acknowledge && snapshots[acknowledge.workflow.channelId];
  useEffect(() => {
    if (
      !acknowledgeSnapshot ||
      acknowledgeSnapshot.status === "idle" ||
      acknowledgeSnapshot.status === "unavailable"
    ) {
      setAcknowledge(undefined);
      setError(undefined);
    }
  }, [acknowledgeSnapshot]);
  return (
    <>
      {operations
        .filter(
          (operation) =>
            operation.action === "delete" &&
            // Completed outbox entries can move ahead of rejected ones. A newer
            // non-rejected attempt supersedes the old failure regardless of order.
            (operation.outcome !== "rejected" ||
              !operations.some(
                (other) =>
                  other.action === "delete" &&
                  other.outcome !== "rejected" &&
                  other.workflow.id === operation.workflow.id &&
                  other.workflow.owner === operation.workflow.owner &&
                  other.workflow.channelId === operation.workflow.channelId,
              )),
        )
        .map((operation) => {
          const snapshot = snapshots[operation.workflow.channelId];
          const definition = snapshot?.data.items.find(
            (row) =>
              row.id === operation.workflow.id &&
              row.owner === operation.workflow.owner,
          );
          if (operation.outcome === "pending") {
            if (definition) return null;
            return (
              <ToastNotice
                key={operation.eventId}
                title="Deleting workflow…"
                description="Waiting for deletion confirmation."
                tone="info"
              />
            );
          }
          if (
            !snapshot ||
            snapshot.status === "idle" ||
            snapshot.status === "unavailable" ||
            confirmedDeletion(operation, snapshot)
          )
            return null;
          const rejected = operation.outcome === "rejected";
          const name = readWorkflowDocumentFields(definition?.yaml ?? "").name;
          return (
            <ToastNotice
              key={operation.eventId}
              title={
                rejected
                  ? `Couldn't delete ${name || "workflow"}`
                  : `Couldn't confirm deletion${name ? ` of ${name}` : ""}`
              }
              description={
                rejected
                  ? "Check the workflow and try again from its menu."
                  : "Check saved configuration before deleting again. Work already running may continue."
              }
            >
              <Button
                size="compact"
                disabled={working || snapshot.status === "loading"}
                onClick={() => onCheck([operation.workflow.channelId])}
              >
                {snapshot.status === "loading"
                  ? "Checking deletion…"
                  : "Check saved configuration"}
              </Button>
              <Button
                size="compact"
                disabled={working}
                onClick={() => {
                  setError(undefined);
                  setAcknowledge(operation);
                }}
              >
                Dismiss notice
              </Button>
              {operation.error && (
                <details>
                  <summary>Delivery details</summary>
                  {operation.error}
                </details>
              )}
            </ToastNotice>
          );
        })}
      {acknowledge &&
        acknowledgeSnapshot &&
        acknowledgeSnapshot.status !== "idle" &&
        acknowledgeSnapshot.status !== "unavailable" && (
          <ConfirmAction
            title="Dismiss this notice?"
            pending={working}
            error={error ?? null}
            description="Dismissing this notice unlocks the workflow. It does not confirm, cancel, or repeat deletion. Check saved configuration before deleting again."
            action={working ? "Dismissing…" : "Dismiss notice and continue"}
            onConfirm={() => void dismiss()}
            onCancel={() => {
              if (!working) setAcknowledge(undefined);
            }}
          />
        )}
    </>
  );
}
