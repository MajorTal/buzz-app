import type { ComponentProps, ReactElement } from "react";
import { Button, type ButtonProps } from "./Button";

type IconButtonVariant =
  | NonNullable<ButtonProps["variant"]>
  | "solid"
  | "tint"
  | "chrome"
  | "avatar";
type IconButtonSize =
  | NonNullable<ButtonProps["size"]>
  | "xs"
  | "toolbar"
  | "large";
type IconButtonShape = "control" | "round";

export type IconButtonProps = Omit<
  ComponentProps<typeof Button>,
  "children" | "size" | "variant"
> & {
  "aria-label": string;
  icon: ReactElement;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  shape?: IconButtonShape;
};

export function IconButton({
  icon,
  variant = "ghost",
  size = "md",
  shape = "round",
  ...props
}: IconButtonProps) {
  return (
    <Button
      {...props}
      variant={
        variant === "solid"
          ? "prominent"
          : variant === "tint" || variant === "chrome" || variant === "avatar"
            ? "ghost"
            : variant
      }
      size={
        size === "xs" || size === "toolbar"
          ? "sm"
          : size === "large"
            ? "lg"
            : size
      }
      data-icon-variant={variant}
      data-icon-size={size}
      data-icon-shape={shape}
    >
      {icon}
    </Button>
  );
}
