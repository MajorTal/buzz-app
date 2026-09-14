import { useRef, useState } from "react";
import { Search, X } from "lucide-react";
import type { RegisteredPage } from "../../features/pages/service";
import {
  orderPages,
  pagePresentation,
  shellPresentation,
} from "./presentation";

export function PageSearch({
  pages,
  onSelect,
}: {
  pages: readonly RegisteredPage[];
  onSelect: (key: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const destinations = [
    { key: "home", ...shellPresentation.home },
    ...orderPages(pages).map((page) => ({
      key: page.key,
      ...pagePresentation(page),
    })),
    { key: "settings", ...shellPresentation.settings },
  ].filter((page) =>
    page.label.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <>
      <button
        type="button"
        className="shell-icon"
        aria-label="Find a page"
        title="Find a page"
        onClick={() => {
          setQuery("");
          dialog.current?.showModal();
        }}
      >
        <Search size={19} aria-hidden="true" strokeWidth={2} />
      </button>
      <dialog
        ref={dialog}
        aria-label="Find a page"
        className="m-auto w-[calc(100%-2rem)] max-w-md rounded-3xl border border-line bg-surface p-4 text-ink shadow-surface backdrop:bg-overlay"
      >
        <div className="mb-3 flex items-center gap-3 border-b border-line pb-3">
          <Search size={18} aria-hidden="true" />
          <input
            aria-label="Find a page"
            placeholder="Find a page…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-0 flex-1 rounded bg-transparent py-2 text-body-sm"
          />
          <button
            type="button"
            aria-label="Close search"
            className="shell-icon"
            onClick={() => dialog.current?.close()}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="max-h-72 overflow-y-auto">
          {destinations.map(({ key, label, icon: Icon }) => (
            <button
              type="button"
              key={key}
              className="flex w-full items-center gap-3 border-0 px-3 py-2.5 text-left text-ink"
              onClick={() => {
                onSelect(key);
                dialog.current?.close();
              }}
            >
              <Icon size={17} aria-hidden="true" />
              {label}
            </button>
          ))}
          {!destinations.length && (
            <p role="status" className="px-3 text-body-sm text-muted">
              No matching pages.
            </p>
          )}
        </div>
      </dialog>
    </>
  );
}
