import { Button } from "../../shared/design-system/ui/Button";
import { Select } from "../../shared/design-system/ui/Select";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { useState } from "react";
import type { ControlSnapshot } from "../../features/agents/control";
import { isGoose, type AgentDraft } from "./agent-edit";

/** Choices come from the injected native snapshot, never a plugin runtime catalog. */
export function AgentHarnessEditor({
  draft,
  options,
  defaultProvider,
  piProviders = [],
  onChange,
  onOpenHarnesses,
  discardEdits = false,
  disabled = false,
}: {
  draft: AgentDraft;
  onOpenHarnesses?: (() => void) | undefined;
  discardEdits?: boolean;
  piProviders?: string[];
  options: NonNullable<ControlSnapshot["harnessOptions"]>;
  disabled?: boolean;
  defaultProvider?: string | undefined;
  onChange(patch: Partial<AgentDraft>): void;
}) {
  const executable = draft.command.replaceAll("\\", "/").split("/").at(-1);
  const harness =
    options.find((option) => option.command === draft.command) ??
    (executable === "goose" || executable === "buzz-pi-acp"
      ? options.find(
          (option) =>
            option.command.replaceAll("\\", "/").split("/").at(-1) ===
            executable,
        )
      : undefined);
  const external = harness?.label === "Goose" || harness?.label === "Pi";
  const missingGoose = options.some(
    (option) => isGoose(option.command) && option.available === false,
  );
  const missingPi = options.some(
    (option) => option.label === "Pi" && option.available === false,
  );
  return (
    <div className="space-y-4">
      <ConfigChoice
        disabled={disabled}
        label="Harness"
        customLabel="Custom executable / current value"
        inputLabel="Executable"
        value={draft.command}
        options={options.map(({ command, label, available }) => ({
          value: command,
          label: available === false ? `${label} (install first)` : label,
          disabled: available === false,
        }))}
        onChange={(command, pickedOption) => {
          const option = options.find((item) => item.command === command);
          const enteringExternal =
            option?.label === "Goose" || option?.label === "Pi";
          onChange({
            command,
            ...(pickedOption && (enteringExternal || external)
              ? {
                  args: JSON.stringify(option?.defaultArgs ?? []),
                  provider: enteringExternal
                    ? ""
                    : (option?.providers[0]?.value ?? ""),
                  model: "",
                }
              : {}),
          });
        }}
      />
      {missingGoose && (
        <p className="text-body-sm text-secondary">
          Install the Goose CLI to use it as a harness.
        </p>
      )}
      {missingPi && (
        <p className="text-body-sm text-secondary">
          Pi needs its CLI, Node.js and buzz-pi-acp before you can select it.
        </p>
      )}
      {(missingGoose || missingPi) && onOpenHarnesses && (
        <div className="space-y-1">
          <Button
            type="button"
            variant="link"
            disabled={disabled}
            onClick={onOpenHarnesses}
          >
            Open Harnesses in Settings
          </Button>
          {discardEdits && (
            <p className="m-0 text-body-sm text-secondary">
              Opening Settings discards unsaved edits.
            </p>
          )}
        </div>
      )}
      <ConfigChoice
        disabled={disabled}
        key={harness?.label ?? draft.command}
        label={external ? "LLM Provider" : "Provider"}
        customLabel="Custom provider / current value"
        inputLabel="Custom provider"
        value={draft.provider}
        options={[
          {
            value: "",
            label:
              draft.command === "buzz-agent" && defaultProvider
                ? `Build default (${defaultProvider})`
                : "Not set",
          },
          ...(harness?.providers ?? []),
          ...(harness?.label === "Pi"
            ? piProviders
                .filter(
                  (p) =>
                    !harness.providers.some((option) => option.value === p),
                )
                .map((value) => ({ value, label: value }))
            : []),
        ]}
        onChange={(provider) =>
          onChange({
            provider,
            ...(external ? { model: "" } : {}),
          })
        }
      />
    </div>
  );
}

function ConfigChoice({
  label,
  customLabel,
  inputLabel,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  customLabel: string;
  inputLabel: string;
  value: string;
  options: { value: string; label: string; disabled?: boolean }[];
  disabled?: boolean;
  onChange(value: string, pickedOption: boolean): void;
}) {
  // Custom is an editing mode, not a saved value. Entering it never erases data.
  const [custom, setCustom] = useState(false);
  const index = options.findIndex((option) => option.value === value);
  const showInput = custom || index < 0;
  return (
    <div className="min-w-0 space-y-3">
      <Select
        label={label}
        variant="field"
        disabled={disabled}
        value={showInput ? "custom" : String(index)}
        groups={[
          {
            label: "",
            options: [
              ...options.map((option, i) => ({
                value: String(i),
                label: option.label,
                disabled: option.disabled ?? false,
              })),
              { value: "custom", label: customLabel },
            ],
          },
        ]}
        onValueChange={(selected) => {
          setCustom(selected === "custom");
          if (selected !== "custom") {
            const option = options[Number(selected)];
            if (option) onChange(option.value, true);
          }
        }}
      />
      {showInput && (
        <Field label={inputLabel}>
          <Input
            disabled={disabled}
            value={value}
            spellCheck={false}
            onChange={(event) => onChange(event.target.value, false)}
          />
        </Field>
      )}
    </div>
  );
}
