import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import type { ReactNode } from "react";

export type TabItem<Value extends string> = {
  value: Value;
  label: string;
  icon?: ReactNode;
};

/**
 * Which background this control is drawn for.
 *
 * `chrome` is the glass pill that belongs on the app gradient. `panel` is an
 * underline for a plain light or dark surface.
 *
 * **A variant rather than a second component**, because behaviour, keyboard
 * model, accessibility, props, and the Base UI tabs underneath are identical —
 * only the appearance differs, which is what a variant is for. `IconButton`
 * spells the same idea the same way.
 *
 * `chrome` is the default because every existing call site is on the gradient.
 */
export type TabsVariant = "chrome" | "panel" | "workspace";

export function Tabs<Value extends string>({
  value,
  items,
  label,
  onValueChange,
  trailingAction,
  variant = "chrome",
  previewValue,
  arrivalValue,
  renderPanel,
}: {
  /** Omit only when composing an existing externally owned view. */
  renderPanel?: (value: Value) => ReactNode;
  value: Value;
  items: readonly TabItem<Value>[];
  label: string;
  onValueChange: (value: Value) => void;
  trailingAction?: ReactNode;
  variant?: TabsVariant;
  /** Incoming tab being previewed before a workspace drop is committed. */
  previewValue?: Value;
  /** Brief visual confirmation of a tab arriving after a completed move. */
  arrivalValue?: Value | undefined;
}) {
  const strip = (
    <>
      <BaseTabs.List className="buzz-tabs-list" aria-label={label}>
        <BaseTabs.Indicator className="buzz-tabs-indicator" />
        {items.map((item) => (
          <BaseTabs.Tab
            key={item.value}
            value={item.value}
            className="buzz-tabs-tab"
            /* Base UI spells the selected tab `data-active`; every other
               selectable thing in this codebase is styled on `data-selected`.
               Restating it here keeps one spelling in the stylesheet rather than
               asking a reader to know which components happen to be Base
               UI-backed. Without it the selected label silently kept
               `--text-secondary` — no error, just a tab that never looked
               selected. */
            data-selected={item.value === value || undefined}
            data-preview={item.value === previewValue || undefined}
            data-tab-value={item.value}
          >
            {variant === "workspace" && item.value === arrivalValue ? (
              <span className="buzz-tabs-arrival" aria-hidden="true" />
            ) : null}
            {item.icon}
            <span>{item.label}</span>
          </BaseTabs.Tab>
        ))}
      </BaseTabs.List>
      {trailingAction}
    </>
  );
  return (
    <BaseTabs.Root
      data-buzz-ui=""
      className={renderPanel ? "buzz-tab-panels" : "buzz-tabs"}
      data-variant={variant}
      value={value}
      onValueChange={(nextValue) => onValueChange(nextValue as Value)}
    >
      {renderPanel ? (
        <div className="buzz-tabs" data-variant={variant}>
          {strip}
        </div>
      ) : (
        strip
      )}
      {renderPanel &&
        items.map((item) => (
          <BaseTabs.Panel
            key={item.value}
            value={item.value}
            className="buzz-tabs-panel"
          >
            {renderPanel(item.value)}
          </BaseTabs.Panel>
        ))}
    </BaseTabs.Root>
  );
}
