// Adapted from block/buzz desktop workflow helpers at b9392d9d.
import { stringify as yamlStringify, parse as yamlParse } from "yaml";

import {
  formatDurationSeconds,
  parseDurationSeconds,
} from "./workflowDuration";

export const TRIGGER_TYPES = ["message_posted", "reaction_added"] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const ACTION_TYPES = ["delay", "send_message"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export type TriggerConfig = {
  on: TriggerType;
  filter?: string | undefined;
  emoji?: string | undefined;
};

export type StepFormState = {
  id: string;
  name?: string | undefined;
  action: ActionType;
  timeoutSecs?: string | undefined;
  duration?: string | undefined;
  text?: string | undefined;
  channel?: string | undefined;
  replyInThread?: boolean | undefined;
};

export type WorkflowFormState = {
  name: string;
  description: string;
  enabled: boolean;
  trigger: TriggerConfig;
  steps: StepFormState[];
};

export const DEFAULT_FORM_STATE: WorkflowFormState = {
  name: "",
  description: "",
  enabled: false,
  trigger: { on: "message_posted" },
  steps: [],
};

export const ACTION_LABELS: Record<ActionType, string> = {
  delay: "Delay",
  send_message: "Send Message",
};

function parseTimeoutSecs(
  timeoutSecs: string | undefined,
): number | string | undefined {
  if (!timeoutSecs?.trim()) return undefined;
  const parsed = parseDurationSeconds(timeoutSecs);
  // Keep invalid input in the YAML draft so validation rejects it instead of
  // silently saving a definition with no timeout. It also remains dirty on leave.
  return parsed !== null && parsed > 0 ? parsed : timeoutSecs;
}

function actionFieldsForStep(step: StepFormState): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (step.name?.trim()) fields.name = step.name.trim();
  const timeoutSecs = parseTimeoutSecs(step.timeoutSecs);
  if (timeoutSecs !== undefined) fields.timeout_secs = timeoutSecs;

  switch (step.action) {
    case "delay":
      if (step.duration) fields.duration = step.duration;
      break;
    case "send_message":
      if (step.text) fields.text = step.text;
      if (step.channel) fields.channel = step.channel;
      if (step.replyInThread) fields.reply_in_thread = true;
      break;
  }
  return fields;
}

export function formStateToYaml(state: WorkflowFormState): string {
  const trigger: Record<string, unknown> = { on: state.trigger.on };
  if (state.trigger.filter) trigger.filter = state.trigger.filter;
  if (state.trigger.on === "reaction_added" && state.trigger.emoji) {
    trigger.emoji = state.trigger.emoji;
  }

  const steps = state.steps.map((step) => ({
    id: step.id,
    action: step.action,
    ...actionFieldsForStep(step),
  }));

  const workflow: Record<string, unknown> = {
    name: state.name,
    trigger,
    steps,
  };

  if (state.description.trim()) {
    workflow.description = state.description.trim();
  }
  if (!state.enabled) {
    workflow.enabled = false;
  }

  return yamlStringify(workflow);
}

export function nextStepId(existingSteps: StepFormState[]): string {
  const existingIds = new Set(existingSteps.map((s) => s.id));
  let n = 1;
  while (existingIds.has(`step_${n}`)) n++;
  return `step_${n}`;
}

const TOP_LEVEL_KEYS = new Set([
  "name",
  "description",
  "enabled",
  "trigger",
  "steps",
]);
const TRIGGER_KEYS: Record<TriggerType, ReadonlySet<string>> = {
  message_posted: new Set(["on", "filter"]),
  reaction_added: new Set(["on", "emoji", "filter"]),
};
const COMMON_STEP_KEYS = ["id", "name", "action", "if", "timeout_secs"];
const ACTION_STEP_KEYS: Record<ActionType, ReadonlySet<string>> = {
  delay: new Set([...COMMON_STEP_KEYS, "duration"]),
  send_message: new Set([
    ...COMMON_STEP_KEYS,
    "text",
    "channel",
    "reply_in_thread",
  ]),
};
const REQUIRED_ACTION_STRING_KEYS: Record<ActionType, readonly string[]> = {
  delay: ["duration"],
  send_message: ["text"],
};
const OPTIONAL_ACTION_STRING_KEYS: Record<ActionType, readonly string[]> = {
  delay: [],
  send_message: ["channel"],
};
const STEP_ID_PATTERN_STRICT = /^[A-Za-z0-9_]{1,64}$/;

type UnknownRecord = Record<string, unknown>;

function objectRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function unknownKey(
  record: UnknownRecord,
  allowed: ReadonlySet<string>,
): string | null {
  return Object.keys(record).find((key) => !allowed.has(key)) ?? null;
}

function requireNonEmptyString(
  record: UnknownRecord,
  key: string,
  label: string,
): string | { error: string } {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    return { error: `${label} must be a non-empty string` };
  }
  return value;
}

function optionalOwnedStringError(
  record: UnknownRecord,
  key: string,
  label: string,
): string | null {
  const value = record[key];
  if (value === undefined) return null;
  if (typeof value !== "string") return `${label} must be a string`;
  if (value.length === 0) {
    return `${label} cannot be empty in Form mode — use the YAML editor`;
  }
  return null;
}

export function yamlToFormState(
  yaml: string,
): { ok: true; state: WorkflowFormState } | { ok: false; error: string } {
  try {
    const parsed = objectRecord(yamlParse(yaml));
    if (!parsed) return { ok: false, error: "YAML must be an object" };

    const topUnknown = unknownKey(parsed, TOP_LEVEL_KEYS);
    if (topUnknown) {
      return {
        ok: false,
        error: `Unsupported workflow field "${topUnknown}" — use the YAML editor`,
      };
    }
    if (typeof parsed.name !== "string") {
      return { ok: false, error: "name must be a string" };
    }
    if (parsed.description !== undefined) {
      if (typeof parsed.description !== "string") {
        return { ok: false, error: "description must be a string" };
      }
      if (
        parsed.description.length === 0 ||
        parsed.description.trim() !== parsed.description
      ) {
        return {
          ok: false,
          error:
            "description cannot be empty or have surrounding whitespace in Form mode — use the YAML editor",
        };
      }
    }
    if (parsed.enabled !== undefined && typeof parsed.enabled !== "boolean") {
      return { ok: false, error: "enabled must be a boolean" };
    }

    const rawTrigger = objectRecord(parsed.trigger);
    if (!rawTrigger || typeof rawTrigger.on !== "string") {
      return { ok: false, error: "trigger.on is required" };
    }
    if (!TRIGGER_TYPES.includes(rawTrigger.on as TriggerType)) {
      return {
        ok: false,
        error: `Unsupported trigger type "${rawTrigger.on}" — use the YAML editor`,
      };
    }
    const triggerOn = rawTrigger.on as TriggerType;
    const triggerUnknown = unknownKey(rawTrigger, TRIGGER_KEYS[triggerOn]);
    if (triggerUnknown) {
      return {
        ok: false,
        error: `Unsupported ${triggerOn} trigger field "${triggerUnknown}" — use the YAML editor`,
      };
    }
    for (const key of ["filter", "emoji"] as const) {
      const error = optionalOwnedStringError(rawTrigger, key, `trigger.${key}`);
      if (error) return { ok: false, error };
    }
    const trigger: TriggerConfig = {
      on: triggerOn,
      filter: rawTrigger.filter as string | undefined,
      emoji: rawTrigger.emoji as string | undefined,
    };

    if (!Array.isArray(parsed.steps)) {
      return { ok: false, error: "steps must be a list" };
    }
    const ids = new Set<string>();
    const steps: StepFormState[] = [];
    for (const [index, value] of parsed.steps.entries()) {
      const number = index + 1;
      const step = objectRecord(value);
      if (!step)
        return { ok: false, error: `Step ${number} must be an object` };
      if (
        typeof step.id !== "string" ||
        !STEP_ID_PATTERN_STRICT.test(step.id)
      ) {
        return {
          ok: false,
          error: `Step ${number} requires a unique 1–64 character alphanumeric or underscore ID`,
        };
      }
      if (ids.has(step.id)) {
        return {
          ok: false,
          error: `Duplicate step ID "${step.id}" — use the YAML editor`,
        };
      }
      ids.add(step.id);

      if (
        typeof step.action !== "string" ||
        !ACTION_TYPES.includes(step.action as ActionType)
      ) {
        return {
          ok: false,
          error: `Unsupported action type "${String(step.action)}" — use the YAML editor`,
        };
      }
      const action = step.action as ActionType;
      const stepUnknown = unknownKey(step, ACTION_STEP_KEYS[action]);
      if (stepUnknown) {
        return {
          ok: false,
          error: `Unsupported ${action} step field "${stepUnknown}" — use the YAML editor`,
        };
      }
      if (step.if !== undefined) {
        return {
          ok: false,
          error: "Step conditions are only available in the YAML editor",
        };
      }
      const nameError = optionalOwnedStringError(
        step,
        "name",
        `Step ${number} name`,
      );
      if (nameError) return { ok: false, error: nameError };
      if (typeof step.name === "string" && step.name.trim() !== step.name) {
        return {
          ok: false,
          error: `Step ${number} name has surrounding whitespace — use the YAML editor`,
        };
      }
      if (
        step.timeout_secs !== undefined &&
        (!Number.isSafeInteger(step.timeout_secs) ||
          (step.timeout_secs as number) <= 0)
      ) {
        return {
          ok: false,
          error: `Step ${number} timeout_secs must be a positive integer`,
        };
      }

      for (const key of REQUIRED_ACTION_STRING_KEYS[action]) {
        const required = requireNonEmptyString(
          step,
          key,
          `Step ${number} ${key}`,
        );
        if (typeof required !== "string")
          return { ok: false, error: required.error };
      }
      for (const key of OPTIONAL_ACTION_STRING_KEYS[action]) {
        const error = optionalOwnedStringError(
          step,
          key,
          `Step ${number} ${key}`,
        );
        if (error) return { ok: false, error };
      }
      if (step.reply_in_thread !== undefined) {
        if (typeof step.reply_in_thread !== "boolean") {
          return {
            ok: false,
            error: `Step ${number} reply_in_thread must be a boolean — use the YAML editor`,
          };
        }
      }

      steps.push({
        id: step.id,
        name: step.name as string | undefined,
        action,
        timeoutSecs:
          step.timeout_secs === undefined
            ? undefined
            : formatDurationSeconds(step.timeout_secs as number),
        duration: step.duration as string | undefined,
        text: step.text as string | undefined,
        channel: step.channel as string | undefined,
        replyInThread: step.reply_in_thread === true,
      });
    }

    return {
      ok: true,
      state: {
        name: parsed.name,
        description: (parsed.description as string | undefined) ?? "",
        enabled: parsed.enabled !== false,
        trigger,
        steps,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid YAML",
    };
  }
}
