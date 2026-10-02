import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";

/** Values never come from the host; an untouched key never enters the save patch. */
export function AgentEnvironmentEditor({
  keys,
  patch,
  disabled,
  onChange,
}: {
  keys: string[];
  patch: Record<string, string | null>;
  disabled: boolean;
  onChange(patch: Record<string, string | null>): void;
}) {
  const [newKey, setNewKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const names = [...new Set([...keys, ...Object.keys(patch)])].sort();
  const undo = (key: string) => {
    const next = { ...patch };
    delete next[key];
    onChange(next);
  };
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-4">
      <legend className="mb-4 text-label">Environment overrides</legend>
      <p className="text-body-sm text-secondary">
        Saved values stay on the host. Leave unchanged to preserve them;
        replacements are write-only. Remove takes effect only when you save. Do
        not put secrets in arguments or prompts.
      </p>
      {names.map((key) => {
        const changed = Object.hasOwn(patch, key);
        const removed = changed && patch[key] === null;
        const masked = key !== "BUZZ_ACP_AGENTS";
        return (
          <div key={key} className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1">
              <Field
                label={
                  <span className="break-all font-mono text-mono">
                    <span className="sr-only">Replacement for </span>
                    {key}
                  </span>
                }
              >
                <Input
                  type={masked ? "password" : "text"}
                  autoComplete={masked ? "new-password" : "off"}
                  spellCheck={false}
                  disabled={disabled || removed}
                  value={patch[key] ?? ""}
                  placeholder={
                    removed
                      ? "Will be removed on save"
                      : keys.includes(key)
                        ? "Saved value unchanged"
                        : "New value"
                  }
                  onChange={(event) =>
                    onChange({ ...patch, [key]: event.target.value })
                  }
                />
              </Field>
            </div>
            {!removed && (
              <Button
                disabled={disabled}
                onClick={() => onChange({ ...patch, [key]: null })}
                aria-label={`Remove ${key}`}
              >
                Remove
              </Button>
            )}
            {changed && (
              <Button
                disabled={disabled}
                onClick={() => undo(key)}
                aria-label={`Undo change to ${key}`}
              >
                Undo
              </Button>
            )}
            {changed && !removed && (
              <span className="text-body-sm text-secondary">
                {patch[key] === ""
                  ? "Will save an empty value"
                  : "Will replace on save"}
              </span>
            )}
          </div>
        );
      })}
      <Field label="Variable name" error={error}>
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <Input
              value={newKey}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setNewKey(event.target.value);
                setError(null);
              }}
            />
          </div>
          <Button
            disabled={disabled}
            onClick={() => {
              const key = newKey.trim();
              if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
                setError(
                  "Use letters, numbers and underscores; start with a letter or underscore.",
                );
                return;
              }
              if (names.includes(key)) {
                setError("That variable is already listed.");
                return;
              }
              onChange({ ...patch, [key]: "" });
              setNewKey("");
              setError(null);
            }}
          >
            Add variable
          </Button>
        </div>
      </Field>
    </fieldset>
  );
}
