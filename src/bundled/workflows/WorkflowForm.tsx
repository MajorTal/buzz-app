import { useId } from "react";
import { Input } from "@base-ui/react/input";
import { Button } from "../../shared/design-system/ui/Button";
import { Select } from "../../shared/design-system/ui/Select";
import { Switch } from "../../shared/design-system/ui/Switch";
import { formWithStep } from "./editor-model";
import {
  ACTION_LABELS,
  nextStepId,
  type WorkflowFormState,
} from "./workflowFormTypes";

export function WorkflowForm({
  state,
  onChange,
  disabled,
}: {
  state: WorkflowFormState;
  onChange: (next: WorkflowFormState) => void;
  disabled: boolean;
}) {
  const id = useId();
  return (
    <fieldset className="workflow-form" disabled={disabled}>
      <label htmlFor={`${id}-1`} className="workflow-field">
        Description
        <Input
          id={`${id}-1`}
          value={state.description}
          onValueChange={(description) => onChange({ ...state, description })}
        />
      </label>
      <Select
        label="Trigger"
        value={state.trigger.on}
        groups={[
          {
            label: "Channel events",
            options: [
              { value: "message_posted", label: "Message posted" },
              { value: "reaction_added", label: "Reaction added" },
            ],
          },
        ]}
        onValueChange={(value) => {
          if (
            !disabled &&
            (value === "message_posted" || value === "reaction_added")
          )
            onChange({ ...state, trigger: { on: value } });
        }}
      />
      {state.trigger.on === "reaction_added" && (
        <label htmlFor={`${id}-2`} className="workflow-field">
          Emoji (optional)
          <Input
            id={`${id}-2`}
            value={state.trigger.emoji ?? ""}
            onValueChange={(emoji) =>
              onChange({ ...state, trigger: { ...state.trigger, emoji } })
            }
          />
        </label>
      )}
      <details>
        <summary>Trigger options</summary>
        <label htmlFor={`${id}-3`} className="workflow-field">
          Trigger condition (optional)
          <Input
            id={`${id}-3`}
            value={state.trigger.filter ?? ""}
            onValueChange={(filter) =>
              onChange({ ...state, trigger: { ...state.trigger, filter } })
            }
          />
          <span className="text-body-sm text-secondary">
            An evalexpr expression; leave empty to match every event of this
            type.
          </span>
        </label>
      </details>
      <ol className="workflow-steps">
        {state.steps.map((step, index) => (
          <li key={step.id} className="workflow-step">
            <div className="workflow-toolbar">
              <h3 className="text-heading">
                Step {index + 1}: {ACTION_LABELS[step.action]}
              </h3>
              <Button
                size="compact"
                disabled={disabled}
                onClick={() =>
                  onChange({
                    ...state,
                    steps: state.steps.filter((item) => item.id !== step.id),
                  })
                }
              >
                Remove step {index + 1}
              </Button>
            </div>
            {step.action === "send_message" ? (
              <>
                <div className="workflow-field">
                  <label htmlFor={`${id}-text-${step.id}`}>Message text</label>
                  <textarea
                    id={`${id}-text-${step.id}`}
                    value={step.text ?? ""}
                    rows={3}
                    autoCapitalize="off"
                    onChange={(event) =>
                      onChange(
                        formWithStep(state, step.id, {
                          text: event.currentTarget.value,
                        }),
                      )
                    }
                  />
                </div>
                <Switch
                  label="Reply in the triggering thread"
                  checked={step.replyInThread === true}
                  disabled={disabled}
                  onCheckedChange={(replyInThread) =>
                    onChange(formWithStep(state, step.id, { replyInThread }))
                  }
                />
              </>
            ) : (
              <label htmlFor={`${id}-6${step.id}`} className="workflow-field">
                Delay duration
                <Input
                  id={`${id}-6${step.id}`}
                  value={step.duration ?? ""}
                  placeholder="5m"
                  onValueChange={(duration) =>
                    onChange(formWithStep(state, step.id, { duration }))
                  }
                />
              </label>
            )}
            <details>
              <summary>Step options</summary>
              <p className="text-mono-sm text-secondary">{step.id}</p>
              <label htmlFor={`${id}-4${step.id}`} className="workflow-field">
                Step name (optional)
                <Input
                  id={`${id}-4${step.id}`}
                  value={step.name ?? ""}
                  onValueChange={(name) =>
                    onChange(formWithStep(state, step.id, { name }))
                  }
                />
              </label>
              {step.action === "send_message" && (
                <label htmlFor={`${id}-5${step.id}`} className="workflow-field">
                  Destination channel UUID (optional)
                  <Input
                    id={`${id}-5${step.id}`}
                    value={step.channel ?? ""}
                    onValueChange={(channel) =>
                      onChange(formWithStep(state, step.id, { channel }))
                    }
                  />
                  <span className="text-body-sm text-secondary">
                    Blank uses this workflow’s channel. The relay checks
                    destination access.
                  </span>
                </label>
              )}
              <label htmlFor={`${id}-7${step.id}`} className="workflow-field">
                Step timeout (optional)
                <Input
                  id={`${id}-7${step.id}`}
                  value={step.timeoutSecs ?? ""}
                  placeholder="30s"
                  onValueChange={(timeoutSecs) =>
                    onChange(formWithStep(state, step.id, { timeoutSecs }))
                  }
                />
              </label>{" "}
            </details>
          </li>
        ))}
      </ol>
      <div className="workflow-toolbar">
        <Button
          disabled={disabled}
          onClick={() =>
            onChange({
              ...state,
              steps: [
                ...state.steps,
                {
                  id: nextStepId(state.steps),
                  action: "send_message",
                  text: "",
                },
              ],
            })
          }
        >
          Add Send Message
        </Button>
        <Button
          disabled={disabled}
          onClick={() =>
            onChange({
              ...state,
              steps: [
                ...state.steps,
                {
                  id: nextStepId(state.steps),
                  action: "delay",
                  duration: "5m",
                },
              ],
            })
          }
        >
          Add Delay
        </Button>
      </div>
    </fieldset>
  );
}
