import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";
import type { Appearance } from "../shared/theme/service";

/** Native radios provide one Tab stop and standard arrow-key selection. */
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
        <fieldset
          className="m-0 min-w-0 border-0 p-0"
          aria-describedby="appearance-description"
        >
          <legend className="mb-2 text-label">Color mode</legend>
          <p
            id="appearance-description"
            className="mt-0 mb-5 text-body-sm text-muted"
          >
            Choose how Buzz looks on this device. Your choice is saved
            automatically.
          </p>
          <div className="grid gap-3 @min-[24rem]:grid-cols-2">
            {(
              [
                ["light", "Light", Sun],
                ["dark", "Dark", Moon],
              ] as const
            ).map(([value, label, Icon]) => (
              <label
                key={value}
                className="ui-choice flex cursor-pointer items-center gap-3 p-4"
              >
                <input
                  type="radio"
                  name="color-mode"
                  value={value}
                  checked={mode === value}
                  onChange={() => appearance.setMode(value)}
                />
                <Icon size={20} aria-hidden="true" />
                <span className="font-medium">{label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="mt-6 min-w-0 border-0 p-0">
          <legend className="mb-2 text-label">Text size</legend>
          <p className="mt-0 mb-3 text-body-sm text-muted">
            Resize text without zooming the window. Saved on this device.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              aria-label="Decrease text size"
              disabled={fontScale <= 0.8}
              onClick={() => appearance.setFontScale(fontScale - 0.1)}
            >
              −
            </button>
            <output aria-label="Text size">
              {Math.round(fontScale * 100)}%
            </output>
            <button
              type="button"
              aria-label="Increase text size"
              disabled={fontScale >= 2}
              onClick={() => appearance.setFontScale(fontScale + 0.1)}
            >
              +
            </button>
            <button type="button" onClick={() => appearance.setFontScale(1)}>
              Reset text size
            </button>
          </div>
        </fieldset>
        {fontError && (
          <div role="alert" className="notice mb-0">
            <p>{fontError}</p>
            <button
              type="button"
              onClick={() => appearance.setFontScale(fontScale)}
            >
              Retry saving text size
            </button>
          </div>
        )}
        {error && (
          <div role="alert" className="notice mb-0">
            <p>{error}</p>
            <button type="button" onClick={() => appearance.setMode(mode)}>
              Retry saving appearance
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
