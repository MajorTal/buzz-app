import { parseDocument, isMap } from "yaml";
import type {
  WorkflowDefinition,
  WorkflowDefinitions,
  WorkflowOperation,
  WorkflowView,
} from "../../features/workflows/types";
import type { WorkflowFormState } from "./workflowFormTypes";

export type WorkflowDraftIssue = {
  message: string;
} & (
  | { field?: undefined }
  | { field: "name" }
  | {
      field: "text" | "duration" | "timeout" | "url" | "headers";
      stepIndex: number;
    }
);

/** Draft shape validation is not relay authorization or a promise of execution. */
export function draftIssue(yaml: string): WorkflowDraftIssue | null {
  if (new TextEncoder().encode(yaml).length > 24_000)
    return { message: "The draft is too large (24,000 bytes maximum)." };
  try {
    const doc = parseDocument(yaml);
    if (doc.errors.length)
      return {
        message: "The YAML cannot be parsed. Correct it before saving.",
      };
    if (!isMap(doc.contents))
      return { message: "The definition must be a YAML object." };
    const data = doc.toJS() as Record<string, unknown>;
    if (typeof data.name !== "string" || !data.name.trim())
      return { field: "name", message: "Give this workflow a name." };
    if (data.enabled !== undefined && typeof data.enabled !== "boolean")
      return { message: "enabled must be true or false." };
    if (
      !data.trigger ||
      typeof data.trigger !== "object" ||
      Array.isArray(data.trigger) ||
      typeof (data.trigger as Record<string, unknown>).on !== "string"
    )
      return { message: "Choose a trigger." };
    if (!Array.isArray(data.steps) || !data.steps.length)
      return { message: "Add at least one step." };
    if (data.steps.length > 100) return { message: "Use at most 100 steps." };
    const ids = new Set<string>();
    for (const [stepIndex, step] of data.steps.entries()) {
      if (
        !step ||
        typeof step !== "object" ||
        typeof step.id !== "string" ||
        !/^[A-Za-z0-9_]{1,64}$/.test(step.id) ||
        ids.has(step.id)
      )
        return {
          message:
            "Step IDs must be unique, with 1–64 letters, digits or underscores.",
        };
      ids.add(step.id);
      if (typeof step.action !== "string")
        return { message: "Each step needs an action." };
      if (
        step.timeout_secs !== undefined &&
        (!Number.isSafeInteger(step.timeout_secs) || step.timeout_secs <= 0)
      )
        return {
          field: "timeout",
          stepIndex,
          message:
            "Step timeout must be a positive whole number of seconds (for example, 30s in Form mode), or left blank.",
        };
      if (
        step.action === "send_message" &&
        (typeof step.text !== "string" || !step.text.trim())
      )
        return {
          field: "text",
          stepIndex,
          message: "Each Send Message step needs message text.",
        };
      if (step.action === "call_webhook") {
        // The relay expands template expressions before validating the destination.
        if (typeof step.url !== "string" || !step.url.trim()) {
          return {
            field: "url",
            stepIndex,
            message:
              "Enter a webhook URL or template. The relay checks destination safety and permission.",
          };
        }
        if (
          step.headers &&
          Object.keys(step.headers).some((name) => !name.trim())
        ) {
          return {
            field: "headers",
            stepIndex,
            message: "Give every header a name or remove its row.",
          };
        }
      }
      if (
        step.action === "delay" &&
        (typeof step.duration !== "string" || !step.duration.trim())
      )
        return {
          field: "duration",
          stepIndex,
          message: "Each Delay step needs a duration.",
        };
    }
    return null;
  } catch {
    return { message: "The YAML cannot be parsed. Correct it before saving." };
  }
}

/** Existing callers only need the save-blocking message. */
export function draftError(yaml: string): string | null {
  return draftIssue(yaml)?.message ?? null;
}

export function formWithStep(
  state: WorkflowFormState,
  id: string,
  patch: Partial<WorkflowFormState["steps"][number]>,
): WorkflowFormState {
  return {
    ...state,
    steps: state.steps.map((step) =>
      step.id === id ? { ...step, ...patch } : step,
    ),
  };
}

/** Never adopt another editor's head as readback for our successful save. */
export function exactSaveReadback(
  operation: WorkflowOperation,
  definitions: readonly WorkflowDefinition[],
): WorkflowDefinition | undefined {
  if (operation.action !== "save" || operation.outcome !== "succeeded")
    return undefined;
  return definitions.find(
    (definition) =>
      definition.revision === operation.eventId &&
      definition.id === operation.workflow.id &&
      definition.owner === operation.workflow.owner &&
      definition.channelId === operation.workflow.channelId,
  );
}

type DefinitionSnapshot = ReturnType<
  WorkflowView<WorkflowDefinitions>["snapshot"]
>;

/** A successful receipt alone does not establish removal of saved configuration. */
export function confirmedDeletion(
  operation: WorkflowOperation,
  snapshot: DefinitionSnapshot | undefined,
): boolean {
  return (
    operation.action === "delete" &&
    operation.outcome === "succeeded" &&
    snapshot?.status === "ready" &&
    !snapshot.data.partial &&
    !snapshot.data.items.some(
      (row) =>
        row.id === operation.workflow.id &&
        row.owner === operation.workflow.owner &&
        row.channelId === operation.workflow.channelId,
    )
  );
}

export function deletionStatus(
  operation: WorkflowOperation,
  snapshot: DefinitionSnapshot | undefined,
): string {
  if (operation.outcome === "pending") return "Deleting…";
  if (operation.outcome === "rejected")
    return "Couldn't delete this workflow. Review the delivery details.";
  if (confirmedDeletion(operation, snapshot))
    return "Saved workflow deleted. Work already running may continue.";
  if (snapshot?.status === "loading") return "Checking deletion…";
  if (
    snapshot?.status === "ready" &&
    snapshot.data.items.some(
      (row) =>
        row.id === operation.workflow.id &&
        row.owner === operation.workflow.owner &&
        row.channelId === operation.workflow.channelId,
    )
  )
    return "This workflow is still in saved configuration. Check again before deleting.";
  return "Couldn't confirm deletion. Check saved configuration before deleting again.";
}
