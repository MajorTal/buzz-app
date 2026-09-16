import { ArrowUpRight, Settings2 } from "lucide-react";
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
      <div className="overflow-hidden rounded-3xl border border-primary bg-panel shadow-surface">
        {orderPages(pages).map((page) => {
          const { label, icon: Icon } = pagePresentation(page);
          return (
            <button
              key={page.key}
              type="button"
              onClick={() => onSelect(page.key)}
              className="flex w-full items-center gap-4 rounded-none border-0 border-b border-line bg-transparent p-6 text-left text-ink hover:bg-soft"
            >
              <span className="flex size-11 items-center justify-center rounded-2xl bg-shell">
                <Icon size={21} aria-hidden="true" />
              </span>
              <span className="flex-1 text-label">{label}</span>
              <ArrowUpRight
                size={18}
                className="text-muted"
                aria-hidden="true"
              />
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => onSelect("settings")}
          className="flex w-full items-center gap-4 rounded-none border-0 bg-transparent p-6 text-left text-ink hover:bg-soft"
        >
          <span className="flex size-11 items-center justify-center rounded-2xl bg-soft">
            <Settings2 size={21} aria-hidden="true" />
          </span>
          <span className="flex-1">
            <span className="block text-label">Make it yours</span>
            <span className="text-body-sm text-muted">Settings</span>
          </span>
          <ArrowUpRight size={18} className="text-muted" aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
