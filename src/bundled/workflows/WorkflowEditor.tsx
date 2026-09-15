import { Input } from "@base-ui/react/input";
import { useId, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Switch } from "../../shared/design-system/ui/Switch";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { ConfirmAction } from "./ConfirmAction";
import { WorkflowForm } from "./WorkflowForm";
import { draftError, hasWebhookTrigger } from "./editor-model";
import { getWorkflowActivationWarning } from "./workflowActivationWarning";
import {
  formStateToYaml,
  yamlToFormState,
  type WorkflowFormState,
} from "./workflowFormTypes";
import {
  readWorkflowDocumentFields,
  yamlWithWorkflowEnabled,
  yamlWithWorkflowName,
} from "./workflowYamlDocument";

export function WorkflowEditor({
  yaml,
  initialYaml,
  onChange,
  onSave,
  readOnly = false,
  blocked,
  busy = false,
  locked = false,
}: {
  yaml: string;
  initialYaml?: string | undefined;
  onChange: (yaml: string) => void;
  onSave: () => void;
  readOnly?: boolean;
  blocked?: string | undefined;
  busy?: boolean;
  locked?: boolean;
}) {
  const id = useId();
  const [mode, setMode] = useState<"form" | "yaml">(() =>
    yamlToFormState(yaml).ok ? "form" : "yaml",
  );
  const [formDraft, setFormDraft] = useState<WorkflowFormState | null>(null);
  const [formYaml, setFormYaml] = useState(yaml);
  const [activating, setActivating] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  const fields = readWorkflowDocumentFields(yaml);
  const parsed = yamlToFormState(yaml);
  // An incomplete form is still an editable draft. An external YAML change must
  // be reparsed instead of reviving stale form state.
  const form =
    formYaml === yaml && formDraft
      ? formDraft
      : parsed.ok
        ? parsed.state
        : null;
  const error = draftError(yaml);
  const secretGate = hasWebhookTrigger(yaml)
    ? "Webhook-trigger saves are unavailable until secure one-time-secret display is supported."
    : undefined;
  const unavailable = blocked || secretGate;
  const mutateForm = (state: WorkflowFormState) => {
    const next = formStateToYaml(state);
    setFormDraft(state);
    setFormYaml(next);
    onChange(next);
  };
  const changeHeader = (
    next: string | null,
    patch: Partial<WorkflowFormState>,
  ) => {
    if (next === null) return;
    if (form) {
      setFormDraft({ ...form, ...patch });
      setFormYaml(next);
    }
    onChange(next);
  };
  const warning = getWorkflowActivationWarning(yaml);
  const submit = () => {
    if (readOnly || busy || locked || unavailable || error) return;
    const wasEnabled =
      initialYaml !== undefined &&
      readWorkflowDocumentFields(initialYaml).enabled !== false;
    if (fields.enabled !== false && !wasEnabled && warning) setActivating(true);
    else onSave();
  };
  return (
    <section aria-label="Workflow editor" className="workflow-editor">
      <div className="workflow-toolbar">
        <label htmlFor={`${id}-1`} className="workflow-field workflow-name">
          Workflow name
          <Input
            id={`${id}-1`}
            value={fields.name ?? ""}
            disabled={readOnly || busy || locked || !fields.editable}
            autoCapitalize="off"
            onValueChange={(name) =>
              changeHeader(yamlWithWorkflowName(yaml, name), { name })
            }
          />
        </label>
        <Switch
          label="Enabled in configuration"
          checked={fields.enabled !== false}
          disabled={readOnly || busy || locked || !fields.editable}
          onCheckedChange={(enabled) =>
            changeHeader(yamlWithWorkflowEnabled(yaml, enabled), { enabled })
          }
        />
      </div>
      <Tabs
        variant="panel"
        label="Editor mode"
        value={mode}
        items={[
          { value: "form", label: "Form" },
          { value: "yaml", label: "YAML" },
        ]}
        onValueChange={(next) => {
          if (next === "form" && !form) {
            setModeError(parsed.ok ? null : parsed.error);
            return;
          }
          setModeError(null);
          setMode(next);
        }}
      />
      {modeError && (
        <p role="alert" className="text-red-12">
          {modeError}
        </p>
      )}
      {mode === "form" && form ? (
        <WorkflowForm
          state={form}
          onChange={mutateForm}
          disabled={readOnly || busy || locked}
        />
      ) : (
        <div className="workflow-field">
          <label htmlFor={`${id}-yaml`}>Workflow YAML</label>
          <textarea
            id={`${id}-yaml`}
            aria-describedby={`${id}-yaml-help`}
            className="text-mono workflow-yaml"
            rows={18}
            spellCheck={false}
            autoCapitalize="off"
            readOnly={readOnly || busy || locked}
            value={yaml}
            onChange={(event) => {
              setFormDraft(null);
              onChange(event.currentTarget.value);
            }}
          />
          <span id={`${id}-yaml-help`} className="text-body-sm text-secondary">
            Original text is kept until you edit. Form changes may reformat
            YAML. Schedules use UTC.
          </span>
        </div>
      )}
      {error && (
        <p role="status" className="text-red-12">
          {error}
        </p>
      )}
      {unavailable && (
        <p role="status" className="text-secondary">
          {unavailable}
        </p>
      )}
      {!readOnly && (
        <Button
          variant="primary"
          disabled={busy || locked || !!unavailable || !!error}
          onClick={submit}
        >
          {busy ? "Saving…" : "Save workflow"}
        </Button>
      )}
      {activating && (
        <ConfirmAction
          title={warning?.title ?? "Save this workflow enabled?"}
          description={
            warning?.description ??
            "The relay may run this workflow automatically when its trigger matches. Saving does not prove a run succeeded."
          }
          action="Save enabled workflow"
          onCancel={() => setActivating(false)}
          onConfirm={() => {
            setActivating(false);
            onSave();
          }}
        />
      )}
    </section>
  );
}
