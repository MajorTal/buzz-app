import { Switch as BaseSwitch } from "@base-ui/react/switch";
import type { ComponentProps } from "react";

/** A labelled on/off setting. Base UI owns checked state and keyboard behavior. */
export function Switch({
  label,
  ...props
}: Omit<
  ComponentProps<typeof BaseSwitch.Root>,
  "children" | "className" | "aria-label"
> & { label: string }) {
  return (
    <div data-buzz-ui="" className="buzz-switch text-body">
      <span>{label}</span>
      <BaseSwitch.Root
        {...props}
        aria-label={label}
        className="buzz-switch-control"
      >
        <BaseSwitch.Thumb className="buzz-switch-thumb" />
      </BaseSwitch.Root>
    </div>
  );
}
