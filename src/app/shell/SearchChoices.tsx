import {
  useEffect,
  useId,
  useState,
  type RefObject,
  type ReactNode,
} from "react";
import type { ChatCircleIcon } from "../../shared/design-system/icons/index";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { NavigationSection } from "../../shared/design-system/ui/NavigationSection";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { isApplePlatform } from "../../features/shortcuts/format";
import "./SearchChoices.css";

export type SearchDestination = {
  key: string;
  label: string;
  detail?: string;
  icon: typeof ChatCircleIcon;
  run: () => void;
};

export type SearchInputProps = {
  query: string;
  onQueryChange: (query: string) => void;
  input: RefObject<HTMLElement | null>;
  label?: string;
  placeholder?: string | undefined;
  scope?: { label: string; onRemove: () => void } | undefined;
};

export function SearchChoices({
  groups,
  query,
  onQueryChange,
  input,
  label = "Search Buzz",
  placeholder = "Search pages, conversations and messages…",
  scope,
  children,
}: SearchInputProps & {
  groups: readonly {
    label: string;
    destinations: readonly SearchDestination[];
    empty?: ReactNode;
  }[];
  children?: ReactNode;
}) {
  const id = useId();
  const destinations = groups.flatMap((group) => group.destinations);
  const apple = isApplePlatform(navigator.platform);
  const shortcutNumbers = new Map(
    destinations.slice(0, 9).map(({ key }, index) => [key, index + 1]),
  );
  // Follow a destination's identity, not its index, as relay results arrive.
  // Clear removed choices immediately so a later reappearance cannot reactivate one.
  const [selection, setSelection] = useState({ query, key: "" });
  const valid =
    selection.query === query &&
    destinations.some(({ key }) => key === selection.key);
  if (selection.query !== query || (selection.key && !valid))
    setSelection({ query, key: "" });
  const selected = valid ? selection.key : "";
  const optionId = (key: string) => `${id}-${key}`;
  useEffect(() => {
    input.current?.focus();
  }, [input]);
  useEffect(() => {
    if (selected)
      document
        .getElementById(`${id}-${selected}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [selected, id]);
  return (
    <div className="search-palette" data-search-palette="">
      {scope && (
        <button
          type="button"
          className="search-palette-scope"
          aria-label={`Remove ${scope.label} search scope`}
          onClick={scope.onRemove}
        >
          {scope.label} <span aria-hidden="true">×</span>
        </button>
      )}
      <SearchField
        inputRef={input}
        role="combobox"
        aria-controls={id}
        aria-expanded="true"
        aria-autocomplete="list"
        aria-activedescendant={selected ? optionId(selected) : undefined}
        label={label}
        placeholder={placeholder}
        value={query}
        onValueChange={onQueryChange}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        maxLength={256}
        onKeyDown={(event) => {
          const shortcutNumber = /^Digit([1-9])$/.exec(event.code)?.[1];
          if (
            !event.nativeEvent.isComposing &&
            event.nativeEvent.keyCode !== 229 &&
            !event.altKey &&
            event.shiftKey &&
            event.metaKey === apple &&
            event.ctrlKey !== apple &&
            shortcutNumber
          ) {
            const destination = destinations[Number(shortcutNumber) - 1];
            if (destination) {
              event.preventDefault();
              if (!event.repeat) destination.run();
            }
            return;
          }
          if (
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229 ||
            event.metaKey ||
            event.ctrlKey ||
            event.altKey
          )
            return;
          const index = destinations.findIndex(({ key }) => key === selected);
          if (event.key === "Enter" && index >= 0) {
            event.preventDefault();
            destinations[index]?.run();
          } else if (
            (event.key === "ArrowDown" || event.key === "ArrowUp") &&
            destinations.length
          ) {
            event.preventDefault();
            const next =
              index < 0
                ? event.key === "ArrowDown"
                  ? 0
                  : destinations.length - 1
                : Math.max(
                    0,
                    Math.min(
                      destinations.length - 1,
                      index + (event.key === "ArrowDown" ? 1 : -1),
                    ),
                  );
            setSelection({ query, key: destinations[next]?.key ?? "" });
          }
        }}
      />
      <div className="search-palette-scroll">
        <div
          id={id}
          role="listbox"
          aria-label="Search results"
          className="search-palette-results"
        >
          {groups
            .filter(
              ({ destinations, empty }) =>
                destinations.length || empty !== undefined,
            )
            .map(({ label, destinations, empty }) => (
              // biome-ignore lint/a11y/useSemanticElements: A listbox option group is not a form fieldset.
              <div
                key={label}
                role="group"
                aria-label={label}
                className="search-palette-group"
              >
                <NavigationSection label={label}>
                  {destinations.map(
                    ({ key, label, detail, icon: Icon, run }) => (
                      <NavigationItem
                        key={key}
                        id={optionId(key)}
                        role="option"
                        tabIndex={-1}
                        aria-selected={selected === key}
                        aria-current={false}
                        selected={selected === key}
                        data-search-result=""
                        aria-keyshortcuts={
                          shortcutNumbers.has(key)
                            ? `Shift+${apple ? "Meta" : "Control"}+${shortcutNumbers.get(key)}`
                            : undefined
                        }
                        icon={
                          <span className="grid size-6 shrink-0 place-items-center">
                            <Icon size={17} aria-hidden="true" />
                          </span>
                        }
                        label={
                          <>
                            <span className="block truncate text-body-sm">
                              {label}
                            </span>
                            {detail && (
                              <span className="block truncate text-caption text-subtle">
                                {detail}
                              </span>
                            )}
                          </>
                        }
                        onClick={run}
                        onPointerEnter={(event) => {
                          if (event.pointerType !== "touch")
                            setSelection({ query, key });
                        }}
                      />
                    ),
                  )}
                  {!destinations.length && (
                    <p className="search-palette-group-empty">
                      {empty ?? "No matching results."}
                    </p>
                  )}
                </NavigationSection>
              </div>
            ))}
        </div>
        {children && <div className="search-palette-status">{children}</div>}
      </div>
    </div>
  );
}
