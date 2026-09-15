import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { useId, type ComponentProps } from "react";

type SwitchProps = Omit<
  ComponentProps<typeof BaseSwitch.Root>,
  "children" | "className" | "aria-label"
> &
  (
    | { label: string; "aria-label"?: never }
    | { label?: never; "aria-label": string }
  );

/** A labelled on/off setting. Base UI owns checked state and keyboard behavior. */
export function Switch({
  label,
  id,
  "aria-label": ariaLabel,
  ...props
}: SwitchProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const control = (
    <BaseSwitch.Root
      {...props}
      id={controlId}
      data-buzz-ui=""
      aria-label={ariaLabel ?? label}
      className="buzz-switch-control"
    >
      <BaseSwitch.Thumb className="buzz-switch-thumb" />
    </BaseSwitch.Root>
  );
  // Some product rows already own a visible label. They reuse the same control
  // with an accessible name rather than reimplementing its track and thumb.
  if (label === undefined) return control;
  return (
    <div data-buzz-ui="" className="buzz-switch text-body">
      <label htmlFor={controlId}>{label}</label>
      {control}
    </div>
  );
}
