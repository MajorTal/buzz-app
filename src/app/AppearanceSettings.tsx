import { Header } from "../shared/design-system/ui/Header";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import { Field } from "../shared/design-system/ui/Field";
import { Radio, RadioGroup } from "../shared/design-system/ui/RadioGroup";
import { Button } from "../shared/design-system/ui/Button";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  MonitorIcon,
  MoonIcon,
  SunIcon,
} from "../shared/design-system/icons/index";
import type { Appearance } from "../shared/theme/service";

/** Shared radios provide one Tab stop and standard arrow-key selection. */
export function AppearanceSettings({
  appearance,
  active = true,
}: {
  appearance: Appearance;
  active?: boolean;
}) {
  const increaseButton = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<HTMLButtonElement | null>(null);
  const resetRef = useCallback((node: HTMLButtonElement | null) => {
    if (!node) return;
    return () => {
      if (document.activeElement === node)
        pendingFocus.current = increaseButton.current;
    };
  }, []);
  useLayoutEffect(() => {
    // At 200%, Increase is still disabled during Reset's ref cleanup.
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target?.isConnected) target.focus();
  });
  const { preference, error, fontScale, fontError } = useSyncExternalStore(
    appearance.subscribe,
    appearance.snapshot,
  );
  return (
    <section aria-labelledby="appearance-settings-title">
      <Header id="appearance-settings-title" title="Appearance" />
      <div>
        <Field label="Color mode">
          <RadioGroup
            name="color-mode"
            value={preference}
            onValueChange={(value) => appearance.setMode(value)}
          >
            {(
              [
                ["light", "Light", SunIcon],
                ["dark", "Dark", MoonIcon],
                ["system", "System", MonitorIcon],
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
        <fieldset className="m-0 mt-6 min-w-0 border-0 p-0">
          <legend className="mb-2 p-0 text-label-sm">Interface size</legend>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              size="sm"
              aria-label="Decrease interface size"
              disabled={fontScale <= 0.8}
              onClick={() => appearance.setFontScale(fontScale - 0.1)}
            >
              −
            </Button>
            <output aria-label="Interface size" className="text-body-sm">
              {Math.round(fontScale * 100)}%
            </output>
            <Button
              type="button"
              size="sm"
              ref={increaseButton}
              aria-label="Increase interface size"
              disabled={fontScale >= 2}
              onClick={() => appearance.setFontScale(fontScale + 0.1)}
            >
              +
            </Button>
            {fontScale !== 1 && (
              <Button
                size="sm"
                type="button"
                ref={resetRef}
                aria-label="Reset interface size"
                onClick={() => appearance.setFontScale(1)}
              >
                Reset
              </Button>
            )}
          </div>
        </fieldset>
        {active && fontError && (
          <ToastNotice
            title="Interface size wasn’t saved"
            description={fontError}
          >
            <Button
              type="button"
              size="sm"
              onClick={() => appearance.setFontScale(fontScale)}
            >
              Retry saving interface size
            </Button>
          </ToastNotice>
        )}
        {active && error && (
          <ToastNotice title="Appearance wasn’t saved" description={error}>
            <Button
              type="button"
              size="sm"
              onClick={() => appearance.setMode(preference)}
            >
              Retry saving appearance
            </Button>
          </ToastNotice>
        )}
      </div>
    </section>
  );
}
