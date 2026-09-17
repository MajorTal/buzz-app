import { Field } from "../shared/design-system/ui/Field";
import { Radio, RadioGroup } from "../shared/design-system/ui/RadioGroup";
import { Button } from "../shared/design-system/ui/Button";
import { useSyncExternalStore } from "react";
import { IconMoon as Moon, IconSun as Sun } from "@tabler/icons-react";
import type { Appearance } from "../shared/theme/service";

/** Shared radios provide one Tab stop and standard arrow-key selection. */
export function AppearanceSettings({ appearance }: { appearance: Appearance }) {
  const { mode, error, fontScale, fontError } = useSyncExternalStore(
    appearance.subscribe,
    appearance.snapshot,
  );
  return (
    <section aria-labelledby="appearance-settings-title">
      <h2 id="appearance-settings-title" className="mt-0 mb-6 text-label">
        Appearance
      </h2>
      <div>
        <Field
          label="Color mode"
          description="Choose how Buzz looks on this device. Your choice is saved automatically."
        >
          <RadioGroup
            name="color-mode"
            value={mode}
            onValueChange={(value) => appearance.setMode(value)}
          >
            {(
              [
                ["light", "Light", Sun],
                ["dark", "Dark", Moon],
              ] as const
            ).map(([value, label, Icon]) => (
              <Radio
                key={value}
                value={value}
                variant="card"
                label={
                  <span className="flex items-center gap-3">
                    <Icon size={20} aria-hidden="true" />
                    {label}
                  </span>
                }
              />
            ))}
          </RadioGroup>
        </Field>
        <fieldset className="mt-6 min-w-0 border-0 p-0">
          <legend className="mb-2 text-label">Text size</legend>
          <p className="mt-0 mb-3 text-body-sm text-muted">
            Resize text without zooming the window. Saved on this device.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              aria-label="Decrease text size"
              disabled={fontScale <= 0.8}
              onClick={() => appearance.setFontScale(fontScale - 0.1)}
            >
              −
            </Button>
            <output aria-label="Text size">
              {Math.round(fontScale * 100)}%
            </output>
            <Button
              type="button"
              aria-label="Increase text size"
              disabled={fontScale >= 2}
              onClick={() => appearance.setFontScale(fontScale + 0.1)}
            >
              +
            </Button>
            <Button type="button" onClick={() => appearance.setFontScale(1)}>
              Reset text size
            </Button>
          </div>
        </fieldset>
        {fontError && (
          <div role="alert" className="notice mb-0">
            <p>{fontError}</p>
            <Button
              type="button"
              onClick={() => appearance.setFontScale(fontScale)}
            >
              Retry saving text size
            </Button>
          </div>
        )}
        {error && (
          <div role="alert" className="notice mb-0">
            <p>{error}</p>
            <Button type="button" onClick={() => appearance.setMode(mode)}>
              Retry saving appearance
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
