import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { IconCheck, IconMinus } from "@tabler/icons-react";
import { useId, type ComponentProps, type ReactNode } from "react";

export function Checkbox({
  label,
  id,
  indeterminate,
  ...props
}: Omit<ComponentProps<typeof BaseCheckbox.Root>, "className" | "children"> & {
  label: ReactNode;
}) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  return (
    <label className="buzz-choice" htmlFor={controlId}>
      <BaseCheckbox.Root
        {...props}
        id={controlId}
        indeterminate={indeterminate}
        data-buzz-ui=""
        className="buzz-checkbox"
      >
        <BaseCheckbox.Indicator>
          {indeterminate ? (
            <IconMinus size={14} aria-hidden="true" />
          ) : (
            <IconCheck size={14} aria-hidden="true" />
          )}
        </BaseCheckbox.Indicator>
      </BaseCheckbox.Root>
      <span className="buzz-choice-label">{label}</span>
    </label>
  );
}
