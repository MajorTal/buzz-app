import { Button as BaseButton } from "@base-ui/react/button";
import type { ComponentProps, ReactNode } from "react";

export function NavigationItem({
  label,
  icon,
  trailing,
  selected = false,
  inset = false,
  variant = "row",
  ...props
}: {
  label: string;
  icon?: ReactNode;
  trailing?: ReactNode;
  selected?: boolean;
  inset?: boolean;
  variant?: "row" | "pill";
} & Omit<ComponentProps<typeof BaseButton>, "className" | "children">) {
  return (
    <BaseButton
      {...props}
      type={props.type ?? "button"}
      data-variant={variant}
      data-buzz-ui=""
      className="navigation-item"
      data-selected={selected || undefined}
      data-inset={inset || undefined}
      aria-current={props["aria-current"] ?? (selected ? "page" : undefined)}
    >
      {icon}
      <span className="navigation-item-label">{label}</span>
      {trailing ? (
        <span className="navigation-item-trailing">{trailing}</span>
      ) : null}
    </BaseButton>
  );
}
