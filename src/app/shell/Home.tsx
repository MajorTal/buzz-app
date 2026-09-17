import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import {
  IconArrowUpRight as ArrowUpRight,
  IconAdjustments as Settings2,
} from "@tabler/icons-react";
import type { RegisteredPage } from "../../features/pages/service";
import { orderPages, pagePresentation } from "./presentation";

export function Home({
  pages,
  onSelect,
}: {
  pages: readonly RegisteredPage[];
  onSelect: (key: string) => void;
}) {
  return (
    <section
      className="mx-auto max-w-2xl"
      style={{ paddingTop: "var(--space-page-section-gap)" }}
    >
      <img
        src="/app-icon.png"
        alt="Buzz"
        className="mb-6 size-16 rounded-2xl"
      />
      <p className="mb-2 text-body-sm text-muted">
        A little space for everything.
      </p>
      <h1 className="mb-8 text-display">Make yourself at home.</h1>
      <div className="grid gap-2 overflow-hidden rounded-3xl border border-standard bg-surface-panel p-3 shadow-surface">
        {orderPages(pages).map((page) => {
          const { label, icon: Icon } = pagePresentation(page);
          return (
            <NavigationItem
              key={page.key}
              onClick={() => onSelect(page.key)}
              label={label}
              icon={<Icon size={21} aria-hidden="true" />}
              trailing={<ArrowUpRight size={18} aria-hidden="true" />}
            />
          );
        })}
        <NavigationItem
          onClick={() => onSelect("settings")}
          label="Make it yours · Settings"
          icon={<Settings2 size={21} aria-hidden="true" />}
          trailing={<ArrowUpRight size={18} aria-hidden="true" />}
        />
      </div>
    </section>
  );
}
