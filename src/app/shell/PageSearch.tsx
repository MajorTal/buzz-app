import { Dialog } from "../../shared/design-system/ui/Dialog";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { useRef, useState } from "react";
import { IconSearch as Search } from "@tabler/icons-react";
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
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLElement>(null);
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
      <IconButton
        ref={trigger}
        type="button"
        variant="chrome"
        shape="round"
        aria-label="Find a page"
        title="Find a page"
        onClick={() => {
          setQuery("");
          setOpen(true);
        }}
        icon={<Search size={16} aria-hidden="true" stroke={2} />}
      />
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Find a page"
        closeLabel="Close search"
        initialFocus={input}
        finalFocus={trigger}
      >
        <SearchField
          inputRef={input}
          label="Find a page"
          placeholder="Find a page…"
          value={query}
          onValueChange={setQuery}
        />
        <div className="max-h-72 overflow-y-auto">
          {destinations.map(({ key, label, icon: Icon }) => (
            <NavigationItem
              type="button"
              key={key}
              label={label}
              icon={<Icon size={17} aria-hidden="true" />}
              onClick={() => {
                onSelect(key);
                setOpen(false);
              }}
            />
          ))}
          {!destinations.length && (
            <p role="status" className="px-3 text-body-sm text-muted">
              No matching pages.
            </p>
          )}
        </div>
      </Dialog>
    </>
  );
}
