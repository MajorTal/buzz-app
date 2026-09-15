import { parseDocument, isMap } from "yaml";
import type {
  WorkflowDefinition,
  WorkflowOperation,
} from "../../features/workflows/types";
import type { WorkflowFormState } from "./workflowFormTypes";

/** Draft shape validation is not relay authorization or a promise of execution. */
export function draftError(yaml: string): string | null {
  if (new TextEncoder().encode(yaml).length > 24_000)
    return "The draft is too large (24,000 bytes maximum).";
  try {
    const doc = parseDocument(yaml);
    if (doc.errors.length)
      return "The YAML cannot be parsed. Correct it before saving.";
    if (!isMap(doc.contents)) return "The definition must be a YAML object.";
    const data = doc.toJS() as Record<string, unknown>;
    if (typeof data.name !== "string" || !data.name.trim())
      return "Give this workflow a name.";
    if (data.enabled !== undefined && typeof data.enabled !== "boolean")
      return "enabled must be true or false.";
    if (
      !data.trigger ||
      typeof data.trigger !== "object" ||
      Array.isArray(data.trigger) ||
      typeof (data.trigger as Record<string, unknown>).on !== "string"
    )
      return "Choose a trigger.";
    if (!Array.isArray(data.steps) || !data.steps.length)
      return "Add at least one step.";
    if (data.steps.length > 100) return "Use at most 100 steps.";
    const ids = new Set<string>();
    for (const step of data.steps) {
      if (
        !step ||
        typeof step !== "object" ||
        typeof step.id !== "string" ||
        !/^[A-Za-z0-9_]{1,64}$/.test(step.id) ||
        ids.has(step.id)
      )
        return "Step IDs must be unique, with 1–64 letters, digits or underscores.";
      ids.add(step.id);
      if (typeof step.action !== "string") return "Each step needs an action.";
      if (
        step.timeout_secs !== undefined &&
        (!Number.isSafeInteger(step.timeout_secs) || step.timeout_secs <= 0)
      )
        return "Step timeout must be a positive whole number of seconds (for example, 30s in Form mode), or left blank.";
      if (
        step.action === "send_message" &&
        (typeof step.text !== "string" || !step.text.trim())
      )
        return "Each Send Message step needs message text.";
      if (
        step.action === "delay" &&
        (typeof step.duration !== "string" || !step.duration.trim())
      )
        return "Each Delay step needs a duration.";
    }
    return null;
  } catch {
    return "The YAML cannot be parsed. Correct it before saving.";
  }
}

/** No secret display exists in this slice: do not offer webhook-trigger writes. */
export function hasWebhookTrigger(yaml: string): boolean {
  try {
    const data = parseDocument(yaml).toJS();
    return data?.trigger?.on === "webhook";
  } catch {
    return false;
  }
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
