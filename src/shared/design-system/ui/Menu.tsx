import { ContextMenu as BaseContextMenu } from "@base-ui/react/context-menu";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { IconCheck, IconChevronRight } from "@tabler/icons-react";
import type { ComponentProps, ReactNode } from "react";

export const MenuRoot = BaseMenu.Root;
export const MenuTrigger = BaseMenu.Trigger;
export const ContextMenuRoot = BaseContextMenu.Root;
export const ContextMenuTrigger = BaseContextMenu.Trigger;
export const MenuGroup = BaseMenu.Group;
export const MenuRadioGroup = BaseMenu.RadioGroup;

export type MenuPosition = Pick<
  ComponentProps<typeof BaseMenu.Positioner>,
  | "align"
  | "alignOffset"
  | "anchor"
  | "collisionAvoidance"
  | "side"
  | "sideOffset"
  | "sticky"
>;

type PopupProps = Omit<ComponentProps<typeof BaseMenu.Popup>, "className"> &
  MenuPosition & {
    children: ReactNode;
  };

function PositionedPopup({
  align = "start",
  alignOffset,
  anchor,
  children,
  collisionAvoidance,
  side = "bottom",
  sideOffset = 4,
  sticky,
  ...props
}: PopupProps) {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        collisionAvoidance={collisionAvoidance}
        side={side}
        sideOffset={sideOffset}
        sticky={sticky}
      >
        <BaseMenu.Popup
          {...props}
          data-buzz-ui=""
          className="buzz-menu-popup text-body-sm"
        >
          {children}
        </BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}

/** An anchored action menu with collision handling and shared floating-surface styling. */
export function MenuPopup(props: PopupProps) {
  return <PositionedPopup {...props} />;
}

export function MenuSubmenu({ children }: { children: ReactNode }) {
  return <BaseMenu.SubmenuRoot>{children}</BaseMenu.SubmenuRoot>;
}

export function MenuSubmenuPopup(props: PopupProps) {
  return <PositionedPopup side="right" align="start" {...props} />;
}

type ItemProps = Omit<ComponentProps<typeof BaseMenu.Item>, "className">;

export function MenuItem(props: ItemProps) {
  return <BaseMenu.Item {...props} className="buzz-menu-item" />;
}

type LinkItemProps = Omit<
  ComponentProps<typeof BaseMenu.LinkItem>,
  "className"
>;

export function MenuLinkItem(props: LinkItemProps) {
  return <BaseMenu.LinkItem {...props} className="buzz-menu-item" />;
}

type SubmenuTriggerProps = Omit<
  ComponentProps<typeof BaseMenu.SubmenuTrigger>,
  "className"
>;

export function MenuSubmenuTrigger({
  children,
  ...props
}: SubmenuTriggerProps) {
  return (
    <BaseMenu.SubmenuTrigger {...props} className="buzz-menu-item">
      {children}
      <IconChevronRight
        className="buzz-menu-submenu-arrow"
        size={16}
        aria-hidden="true"
      />
    </BaseMenu.SubmenuTrigger>
  );
}

type CheckboxItemProps = Omit<
  ComponentProps<typeof BaseMenu.CheckboxItem>,
  "className"
>;

export function MenuCheckboxItem({ children, ...props }: CheckboxItemProps) {
  return (
    <BaseMenu.CheckboxItem {...props} className="buzz-menu-item">
      <BaseMenu.CheckboxItemIndicator
        className="buzz-menu-item-indicator"
        keepMounted
      >
        <IconCheck size={14} aria-hidden="true" />
      </BaseMenu.CheckboxItemIndicator>
      <span className="buzz-menu-choice-label">{children}</span>
    </BaseMenu.CheckboxItem>
  );
}

type RadioItemProps = Omit<
  ComponentProps<typeof BaseMenu.RadioItem>,
  "className"
>;

export function MenuRadioItem({ children, ...props }: RadioItemProps) {
  return (
    <BaseMenu.RadioItem {...props} className="buzz-menu-item">
      <BaseMenu.RadioItemIndicator
        className="buzz-menu-item-indicator"
        keepMounted
      >
        <span className="buzz-menu-radio-dot" />
      </BaseMenu.RadioItemIndicator>
      <span className="buzz-menu-choice-label">{children}</span>
    </BaseMenu.RadioItem>
  );
}

export function MenuGroupLabel({ children }: { children: ReactNode }) {
  return (
    <BaseMenu.GroupLabel className="buzz-menu-group-label">
      {children}
    </BaseMenu.GroupLabel>
  );
}

export function MenuSeparator() {
  return <BaseMenu.Separator className="buzz-menu-separator" />;
}

export function MenuIcon({ children }: { children: ReactNode }) {
  return (
    <span className="buzz-menu-icon" aria-hidden="true">
      {children}
    </span>
  );
}

export function MenuTrailing({ children }: { children: ReactNode }) {
  return <span className="buzz-menu-trailing">{children}</span>;
}
