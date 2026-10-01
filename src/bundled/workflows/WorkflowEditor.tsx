import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  DotsThreeIcon,
  LightningIcon,
  PencilSimpleIcon,
} from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { Button } from "../../shared/design-system/ui/Button";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuCheckboxItem,
  MenuIcon,
} from "../../shared/design-system/ui/Menu";
import { Switch } from "../../shared/design-system/ui/Switch";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { ConfirmAction } from "./ConfirmAction";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { WorkflowForm, type WorkflowSelection } from "./WorkflowForm";
import { conditionRowError } from "./workflowConditionExpression";
import { draftIssue } from "./editor-model";
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
  onLocalDraftRiskChange,
  readOnly = false,
  blocked,
  busy = false,
  locked = false,
  onCancel,
  scope,
  actions,
  details,
  status,
  children,
  create = false,
  chooseChannel = false,
}: {
  yaml: string;
  initialYaml?: string | undefined;
  onChange: (yaml: string) => void;
  onSave: () => void;
  onLocalDraftRiskChange?: (atRisk: boolean) => void;
  readOnly?: boolean;
  blocked?: string | undefined;
  busy?: boolean;
  locked?: boolean;
  onCancel?: () => void;
  scope?: ReactNode;
  actions?: (enable: ReactNode) => ReactNode;
  details?: ReactNode;
  status?: ReactNode;
  children?: ReactNode;
  create?: boolean;
  chooseChannel?: boolean;
}) {
  const id = useId();
  const [selection, setSelection] = useState<WorkflowSelection>(
    create && !chooseChannel ? { type: "trigger" } : null,
  );
  const [mode, setMode] = useState<"form" | "yaml">(() =>
    yamlToFormState(yaml).ok ? "form" : "yaml",
  );
  const [formDraft, setFormDraft] = useState<WorkflowFormState | null>(null);
  const [formYaml, setFormYaml] = useState(yaml);
  const [activating, setActivating] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const nameButton = useRef<HTMLButtonElement>(null);
  const restoreNameFocus = useRef(false);
  useEffect(() => {
    if (!editingName && restoreNameFocus.current) {
      nameButton.current?.focus();
      restoreNameFocus.current = false;
    }
  }, [editingName]);
  const [nameDraft, setNameDraft] = useState("");
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
  const issue = draftIssue(yaml);
  const conditionError = form?.trigger.conditionRows
    ?.map(conditionRowError)
    .find(Boolean);
  const headerError = form?.steps.some(
    (step) =>
      step.headers &&
      new Set(step.headers.map((header) => header.name)).size !==
        step.headers.length,
  )
    ? "Header names must be unique."
    : undefined;
  // Invalid form-only values may serialize to unchanged YAML. Keep them in
  // the channel's existing leave/unload guard without creating another draft owner.
  const localDraftAtRisk =
    formYaml === yaml && !!formDraft && !!(conditionError || headerError);
  useEffect(() => {
    onLocalDraftRiskChange?.(localDraftAtRisk);
    return () => onLocalDraftRiskChange?.(false);
  }, [localDraftAtRisk, onLocalDraftRiskChange]);
  const error = issue?.message || conditionError || headerError;
  const showingForm = mode === "form" && !!form;
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
    if (readOnly || busy || locked || blocked || error) return;
    const wasEnabled =
      initialYaml !== undefined &&
      readWorkflowDocumentFields(initialYaml).enabled !== false;
    if (fields.enabled !== false && !wasEnabled && warning) setActivating(true);
    else onSave();
  };
  const disabled = readOnly || busy || locked || chooseChannel;
  const controlReason = readOnly
    ? "Only the author can change this workflow."
    : (blocked ??
      (busy || locked
        ? "Review Recent activity before editing."
        : chooseChannel
          ? "Choose a channel before editing."
          : !fields.editable
            ? "Correct the YAML before changing the name or configuration."
            : undefined));
  const enableControl = (
    <MenuCheckboxItem
      checked={fields.enabled !== false && fields.editable}
      disabled={disabled || !fields.editable}
      aria-describedby={controlReason ? `${id}-control-reason` : undefined}
      closeOnClick={false}
      onCheckedChange={(enabled) =>
        changeHeader(yamlWithWorkflowEnabled(yaml, enabled), { enabled })
      }
    >
      <MenuIcon>
        <LightningIcon size={14} />
      </MenuIcon>
      Enable
    </MenuCheckboxItem>
  );
  return (
    <Dialog
      open
      title={
        create
          ? "Create workflow"
          : readOnly
            ? "View workflow"
            : "Edit workflow"
      }
      closeLabel="Close editor"
      size="expanded"
      onOpenChange={(open) => {
        if (!open) onCancel?.();
      }}
      onEscape={() => {
        if (!selection) return false;
        setSelection(null);
        return true;
      }}
      headerActions={
        !create && (
          <MenuRoot>
            <MenuTrigger
              render={
                <IconButton
                  aria-label="Workflow actions"
                  icon={<DotsThreeIcon size={20} aria-hidden="true" />}
                />
              }
            />
            <MenuPopup align="end">
              {actions ? actions(enableControl) : enableControl}
            </MenuPopup>
          </MenuRoot>
        )
      }
      leadingActions={
        <Tabs
          variant="panel"
          label="Editor mode"
          value={mode}
          items={[
            { value: "form", label: "Form" },
            { value: "yaml", label: "YAML" },
          ]}
          onValueChange={(next) => {
            if (next === "yaml" && (conditionError || headerError)) {
              setModeError(
                "Correct the invalid condition or duplicate header before switching views.",
              );
              return;
            }
            if (next === "form" && !form) {
              setModeError(parsed.ok ? null : parsed.error);
              return;
            }
            setModeError(null);
            setSelection(null);
            setMode(next);
          }}
        />
      }
      actions={
        !readOnly && (
          <>
            {onCancel && <Button onClick={onCancel}>Cancel</Button>}
            <Button
              variant="prominent"
              focusableWhenDisabled={busy || locked}
              disabled={
                disabled ||
                (!!blocked && !chooseChannel) ||
                (!!error && !(showingForm && form?.steps.length === 0))
              }
              onClick={() => {
                if (showingForm && form && !form.steps.length) {
                  mutateForm({
                    ...form,
                    steps: [{ id: "step_1", action: "send_message", text: "" }],
                  });
                  setSelection({ type: "step", id: "step_1" });
                } else submit();
              }}
            >
              {busy
                ? create
                  ? "Creating…"
                  : "Saving…"
                : showingForm && !form?.steps.length
                  ? "Add step"
                  : create
                    ? "Create workflow"
                    : "Save changes"}
            </Button>
          </>
        )
      }
    >
      <section aria-label="Workflow editor" className="workflow-editor">
        <div className="workflow-toolbar">
          <div className="workflow-name">
            {editingName ? (
              <Field
                label="Workflow name"
                error={
                  showingForm && issue?.field === "name" ? error : undefined
                }
              >
                <Input
                  id={`${id}-1`}
                  value={nameDraft}
                  autoFocus
                  onFocus={(event) => event.currentTarget.select()}
                  disabled={disabled || !fields.editable}
                  autoCapitalize="off"
                  onValueChange={setNameDraft}
                  onBlur={() => {
                    changeHeader(yamlWithWorkflowName(yaml, nameDraft), {
                      name: nameDraft,
                    });
                    setEditingName(false);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      restoreNameFocus.current = true;
                      setEditingName(false);
                    }
                    if (event.key === "Enter") {
                      event.preventDefault();
                      restoreNameFocus.current = true;
                      changeHeader(yamlWithWorkflowName(yaml, nameDraft), {
                        name: nameDraft,
                      });
                      setEditingName(false);
                    }
                  }}
                />
              </Field>
            ) : (
              <div className="workflow-name-display">
                <span className="text-mono-sm">
                  {fields.name || "Untitled workflow"}
                </span>
                <IconButton
                  ref={nameButton}
                  aria-label="Edit workflow name"
                  title="Edit workflow name"
                  aria-describedby={
                    [
                      controlReason && `${id}-control-reason`,
                      issue?.field === "name" && `${id}-name-error`,
                    ]
                      .filter(Boolean)
                      .join(" ") || undefined
                  }
                  icon={<PencilSimpleIcon size={16} aria-hidden="true" />}
                  size="sm"
                  disabled={disabled || !fields.editable}
                  onClick={() => {
                    setNameDraft(fields.name ?? "");
                    setEditingName(true);
                  }}
                />
              </div>
            )}
            {!editingName && issue?.field === "name" && (
              <p
                id={`${id}-name-error`}
                role="status"
                className="text-body-sm text-danger"
              >
                {issue.message}
              </p>
            )}
          </div>
          {readOnly && (
            <span id={`${id}-control-reason`} hidden>
              {controlReason}
            </span>
          )}
          {create && fields.editable ? (
            <Switch
              label="Enabled in configuration"
              aria-describedby={
                controlReason ? `${id}-control-reason` : undefined
              }
              checked={fields.enabled !== false}
              disabled={disabled}
              onCheckedChange={(enabled) =>
                changeHeader(yamlWithWorkflowEnabled(yaml, enabled), {
                  enabled,
                })
              }
            />
          ) : !fields.editable ? (
            <span className="text-body-sm text-secondary">
              Unreadable configuration
            </span>
          ) : null}
        </div>
        <div className="workflow-editor-body">
          {modeError && (
            <p role="alert" className="text-danger">
              Cannot switch editor view: {modeError}
            </p>
          )}
          {chooseChannel ? (
            scope
          ) : mode === "form" && form ? (
            <WorkflowForm
              state={form}
              issue={issue}
              onChange={mutateForm}
              disabled={disabled}
              scope={scope}
              selection={selection}
              onSelect={setSelection}
            />
          ) : (
            <Field
              label="Workflow YAML"
              error={error}
              description="Original text is kept until you edit. Form changes may reformat YAML. Schedules use UTC."
            >
              <Textarea
                id={`${id}-yaml`}
                variant="code"
                rows={18}
                spellCheck={false}
                autoCapitalize="off"
                readOnly={disabled}
                value={yaml}
                onChange={(event) => {
                  setFormDraft(null);
                  setModeError(null);
                  onChange(event.currentTarget.value);
                }}
              />
            </Field>
          )}
          {showingForm &&
            error &&
            (!issue?.field || conditionError || headerError) &&
            !!form?.steps.length && (
              <p role="status" className="text-danger">
                {error}
              </p>
            )}
        </div>
        <div className="workflow-editor-status">
          {!readOnly && controlReason && (
            <p
              id={`${id}-control-reason`}
              role="status"
              className="text-body-sm text-secondary"
            >
              {controlReason}
            </p>
          )}
          {status}
        </div>
        {!chooseChannel && (
          <Accordion
            variant="form"
            items={[
              {
                value: "settings",
                title: "Workflow settings & activity",
                content: (
                  <div className="workflow-options">
                    {form && (
                      <Field label="Description">
                        <Input
                          value={form.description}
                          disabled={disabled}
                          onValueChange={(description) =>
                            mutateForm({ ...form, description })
                          }
                        />
                      </Field>
                    )}
                    {details}
                  </div>
                ),
              },
            ]}
          />
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
        {children}
      </section>
    </Dialog>
  );
}
