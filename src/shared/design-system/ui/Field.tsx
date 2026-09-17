import { Field as BaseField } from "@base-ui/react/field";
import type { ComponentProps, ReactNode } from "react";

export type FieldProps = Omit<
  ComponentProps<typeof BaseField.Root>,
  "className"
> & {
  label: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
};

/** Base UI connects the label, description, error and contained control. */
export function Field({
  label,
  description,
  error,
  children,
  invalid,
  ...props
}: FieldProps) {
  return (
    <BaseField.Root
      {...props}
      invalid={invalid || Boolean(error)}
      data-buzz-ui=""
      className="buzz-field"
    >
      <BaseField.Label className="buzz-field-label">{label}</BaseField.Label>
      {children}
      {description && (
        <BaseField.Description className="buzz-field-description">
          {description}
        </BaseField.Description>
      )}
      {error && (
        <BaseField.Error match className="buzz-field-error">
          {error}
        </BaseField.Error>
      )}
    </BaseField.Root>
  );
}
