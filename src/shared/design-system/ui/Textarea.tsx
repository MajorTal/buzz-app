import { Field as BaseField } from "@base-ui/react/field";
import type { ComponentProps } from "react";

export type TextareaProps = Omit<ComponentProps<"textarea">, "className">;
/** Field.Control supplies the same label/validation behavior as Input. */
export function Textarea({
  variant = "text",
  ...props
}: TextareaProps & { variant?: "text" | "code" }) {
  return (
    <BaseField.Control
      render={<textarea {...props} />}
      data-buzz-ui=""
      className="buzz-textarea"
      data-variant={variant}
    />
  );
}
