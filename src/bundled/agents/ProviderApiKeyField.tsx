import { useEffect, useState } from "react";
import { EyeIcon, EyeSlashIcon } from "../../shared/design-system/icons/index";
import { Field } from "../../shared/design-system/ui/Field";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Input } from "../../shared/design-system/ui/Input";
import { InputGroup } from "../../shared/design-system/ui/InputGroup";

/** The same write-only provider key input for agent and default settings. */
export function ProviderApiKeyField({
  apiKey,
  value,
  saved,
  disabled,
  emptyPlaceholder,
  onChange,
}: {
  apiKey: { label: string; env: string };
  value: string | null | undefined;
  saved: boolean;
  disabled: boolean;
  emptyPlaceholder: string;
  onChange(value: string): void;
}) {
  const [revealed, setRevealed] = useState(false);
  const typed = !!value;
  // Saving, discarding, or removing an environment patch may clear the input
  // outside this component. A later key must start masked again.
  useEffect(() => {
    if (!typed) setRevealed(false);
  }, [typed]);
  return (
    <Field label={`${apiKey.label} API key`}>
      <InputGroup
        trailing={
          typed ? (
            <IconButton
              aria-label={revealed ? "Hide API key" : "Show API key"}
              icon={
                revealed ? (
                  <EyeSlashIcon size={16} aria-hidden="true" />
                ) : (
                  <EyeIcon size={16} aria-hidden="true" />
                )
              }
              size="sm"
              disabled={disabled}
              onClick={() => setRevealed(!revealed)}
            />
          ) : undefined
        }
      >
        <Input
          type={revealed && typed ? "text" : "password"}
          autoComplete="new-password"
          spellCheck={false}
          disabled={disabled}
          value={value ?? ""}
          placeholder={
            value === null
              ? "Will remove on save"
              : saved
                ? "Saved key unchanged"
                : emptyPlaceholder
          }
          onChange={(event) => {
            if (!event.target.value) setRevealed(false);
            onChange(event.target.value);
          }}
        />
      </InputGroup>
    </Field>
  );
}
