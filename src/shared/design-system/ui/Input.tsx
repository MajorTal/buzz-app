import { Input as BaseInput } from "@base-ui/react/input";
import type { ComponentProps } from "react";

export type InputProps = Omit<ComponentProps<typeof BaseInput>, "className">;
export function Input(props: InputProps) {
  return <BaseInput {...props} data-buzz-ui="" className="buzz-input" />;
}
