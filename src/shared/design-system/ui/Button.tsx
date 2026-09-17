import { Button as BaseButton } from "@base-ui/react/button";
import { IconLoader2 } from "@tabler/icons-react";
import type { ComponentProps, ReactNode } from "react";

type ButtonVariant =
  | "prominent"
  | "subtle"
  | "ghost"
  | "destructive"
  | "outline"
  | "primary"
  | "quiet";
type ButtonSize = "sm" | "md" | "lg" | "compact" | "default";

export type ButtonProps = Omit<
  ComponentProps<typeof BaseButton>,
  "className"
> & {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
};

/** Base UI owns activation. Legacy variant/size names remain during migration. */
export function Button({
  children,
  variant = "subtle",
  size = "md",
  type = "button",
  loading = false,
  disabled,
  onClick,
  ...props
}: ButtonProps) {
  return (
    <BaseButton
      {...props}
      type={type}
      disabled={disabled || loading}
      focusableWhenDisabled={
        props.focusableWhenDisabled ?? (loading && !disabled)
      }
      aria-busy={loading || props["aria-busy"]}
      onClick={(event) => {
        if (loading || disabled) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      data-buzz-ui=""
      className="buzz-button"
      data-variant={
        variant === "primary"
          ? "prominent"
          : variant === "quiet"
            ? "subtle"
            : variant
      }
      data-size={size === "compact" ? "sm" : size === "default" ? "md" : size}
      data-loading={loading || undefined}
    >
      <span className="buzz-button-label">{children}</span>
      {loading && (
        <IconLoader2
          className="buzz-button-spinner"
          size={18}
          aria-hidden="true"
        />
      )}
    </BaseButton>
  );
}
