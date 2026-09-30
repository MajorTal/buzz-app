import { useEffect, useRef, useState } from "react";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { GitPullRequestIcon } from "../../shared/design-system/icons/index";
import type { ComposerToolProps } from "../../features/conversation/contracts";
import {
  entityFailure,
  value,
  values,
  type Entity,
} from "../../features/projects/destinations";
import {
  entityDtag,
  entityHex,
  entityHref,
} from "../../features/projects/routes";
import "../../shared/design-system/styles/scrollbars.css";
import styles from "./ResourcePicker.module.css";

const kinds = { issue: "Issue", pr: "Pull request" } as const;
type Item = {
  type: keyof typeof kinds;
  id: string;
  label: string;
  createdAt: number;
  repository: Entity;
};
type Items =
  | { status: "loading" | "error" }
  | { status: "ready"; items: Item[]; truncated: boolean };

/** Mounted per destination, so it owns the channel→project mapping and list reads.
 * The composer owns the inserted link; this tool only proposes a verified one. */
export function ResourcePicker({
  session,
  channelId,
  disabled,
  insertResource,
}: ComposerToolProps) {
  const [attempt, setAttempt] = useState(0);
  const [home, setHome] = useState<
    "loading" | "none" | "ambiguous" | "error" | Entity
  >("loading");
  const [open, setOpen] = useState(false);
  const [opening, setOpening] = useState(0);
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<Items>({ status: "loading" });
  const [checking, setChecking] = useState<{ id: string; failed?: string }>();
  const [rejected, setRejected] = useState<string>();
  const validation = useRef<AbortController>(undefined);
  const accepted = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const controls = useRef<HTMLFieldSetElement>(null);
  const searchInput = useRef<HTMLElement>(null);
  const project = typeof home === "object" ? home : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is explicit retry.
  useEffect(() => {
    const controller = new AbortController();
    setHome("loading");
    session.projects.home(channelId, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted)
          setHome(result.status === "home" ? result.project : result.status);
      },
      () => {
        if (!controller.signal.aborted) setHome("error");
      },
    );
    return () => controller.abort();
  }, [session, channelId, attempt]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each opening and retry rereads.
  useEffect(() => {
    if (!open || !project) return;
    const controller = new AbortController();
    setItems({ status: "loading" });
    Promise.all(
      (["issue", "pr"] as const).map(async (type) => {
        const detail = await session.projects.load(
          {
            type: "project",
            owner: project.owner,
            dtag: project.dtag,
            tab: type === "pr" ? "prs" : "issues",
          },
          controller.signal,
        );
        return {
          truncated: !!detail.truncated,
          items: detail.items.flatMap((event) => {
            const repository = detail.repositories.find((repo) =>
              values(event, "a").includes(repo.address),
            );
            return repository &&
              entityDtag(repository.dtag) &&
              entityHex.test(event.id)
              ? [
                  {
                    type,
                    id: event.id,
                    label:
                      value(event, "subject") ||
                      event.content.split("\n")[0] ||
                      kinds[type],
                    createdAt: event.created_at,
                    repository,
                  },
                ]
              : [];
          }),
        };
      }),
    ).then(
      (lists) => {
        if (controller.signal.aborted) return;
        setItems({
          status: "ready",
          truncated: lists.some((list) => list.truncated),
          items: lists
            .flatMap((list) => list.items)
            .sort((a, b) => b.createdAt - a.createdAt),
        });
      },
      () => {
        if (!controller.signal.aborted) setItems({ status: "error" });
      },
    );
    return () => controller.abort();
  }, [session, project, open, opening]);
  useEffect(() => () => validation.current?.abort(), []);
  // A hidden choice must not insert after the composer is re-enabled.
  useEffect(() => {
    if (!disabled) return;
    validation.current?.abort();
    setChecking(undefined);
    setRejected(undefined);
    setOpen(false);
  }, [disabled]);
  if (home === "none") return null;
  // A deleted or retargeted item must not become an accepted link.
  const choose = (item: Item) => {
    validation.current?.abort();
    const controller = new AbortController();
    validation.current = controller;
    // Disabling the focused row would drop focus to <body> (Chromium).
    searchInput.current?.focus();
    setChecking({ id: item.id });
    setRejected(undefined);
    const route = {
      type: item.type,
      owner: item.repository.owner,
      dtag: item.repository.dtag,
      id: item.id,
    };
    session.projects.load(route, controller.signal).then(
      () => {
        if (controller.signal.aborted) return;
        setChecking(undefined);
        const result = insertResource({
          uri: entityHref(route),
          label: item.label,
        });
        if (result !== true) return setRejected(result);
        accepted.current = true;
        setOpen(false);
      },
      (error) => {
        if (controller.signal.aborted) return;
        setChecking({
          id: item.id,
          failed:
            entityFailure(error) === "not-found"
              ? `This ${kinds[item.type].toLowerCase()} is no longer available.`
              : "Could not check this item. Choose it again to retry.",
        });
      },
    );
  };
  const query = search.trim().toLowerCase();
  const shown =
    items.status === "ready"
      ? items.items.filter((item) =>
          `${item.label} ${item.repository.name}`.toLowerCase().includes(query),
        )
      : [];
  const label = "Add issue or pull request";
  return (
    <PopoverRoot
      open={open && !disabled && home !== "loading"}
      onOpenChange={(next) => {
        setOpen(next);
        validation.current?.abort();
        setChecking(undefined);
        setRejected(undefined);
        if (next) {
          setOpening((value) => value + 1);
          accepted.current = false;
        }
      }}
    >
      <fieldset
        ref={controls}
        disabled={disabled}
        className={styles.controls}
        aria-label="Issue and pull request controls"
      >
        <PopoverTrigger
          disabled={disabled || home === "loading"}
          render={
            <IconButton
              disabled={disabled || home === "loading"}
              size="toolbar"
              ref={trigger}
              type="button"
              aria-label={label}
              title={
                home === "loading"
                  ? "Loading project…"
                  : project
                    ? label
                    : `${label} (unavailable)`
              }
              data-unavailable={
                home === "ambiguous" || home === "error" ? "" : undefined
              }
              icon={<GitPullRequestIcon size={20} aria-hidden="true" />}
            />
          }
        />
        {home === "loading" && (
          <span role="status" className="sr-only">
            Loading project…
          </span>
        )}
        <PopoverPopup
          side="top"
          sideOffset={4}
          anchor={() => controls.current?.closest("form") ?? trigger.current}
          padding="none"
          initialFocus={project ? searchInput : undefined}
          style={{
            width: 380,
            height: "min(360px, var(--available-height))",
            overflow: "hidden",
            display: "flex",
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            const fromSearch = event.target === searchInput.current;
            if (event.key === "Enter" && fromSearch) event.preventDefault();
            if (
              event.altKey ||
              event.ctrlKey ||
              event.metaKey ||
              event.shiftKey ||
              !["ArrowDown", "ArrowUp", "Enter"].includes(event.key)
            )
              return;
            const rows = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                "[data-resource-choice]:not(:disabled)",
              ),
            );
            if (event.key === "Enter") {
              if (!fromSearch) return;
              event.stopPropagation();
              rows[0]?.click();
              return;
            }
            if (
              !fromSearch &&
              !rows.includes(event.target as HTMLButtonElement)
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            const current = rows.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            const step = event.key === "ArrowDown" ? 1 : -1;
            rows[
              current < 0
                ? step > 0
                  ? 0
                  : rows.length - 1
                : (current + step + rows.length) % rows.length
            ]?.focus();
          }}
          aria-label={label}
          finalFocus={!accepted.current}
        >
          <div className={styles.content}>
            {!project ? (
              <>
                <p role="status">
                  {home === "ambiguous"
                    ? "This channel belongs to more than one project, so issues and pull requests can't be chosen here."
                    : "Could not load this channel's project."}
                </p>
                <Button type="button" onClick={() => setAttempt((n) => n + 1)}>
                  Retry project
                </Button>
              </>
            ) : (
              <>
                <SearchField
                  variant="capsule"
                  inputRef={searchInput}
                  label={`Search ${project.name}`}
                  value={search}
                  onValueChange={setSearch}
                  disabled={disabled}
                />
                {items.status === "loading" && (
                  <p role="status">Loading issues and pull requests…</p>
                )}
                {items.status === "error" && (
                  <>
                    <p role="alert">Could not load issues and pull requests.</p>
                    <Button
                      type="button"
                      onClick={() => setOpening((n) => n + 1)}
                    >
                      Retry
                    </Button>
                  </>
                )}
                {items.status === "ready" && items.truncated && (
                  <p role="status">
                    Showing the latest items only. Some issues or pull requests
                    may be missing.
                  </p>
                )}
                {checking && !checking.failed && (
                  <p role="status" className="sr-only">
                    Checking the chosen item…
                  </p>
                )}
                {(checking?.failed ?? rejected) && (
                  <p role="alert">{checking?.failed ?? rejected}</p>
                )}
                <div className={`${styles.choices} buzz-thin-scrollbar`}>
                  {shown.map((item) => (
                    <NavigationItem
                      variant="option"
                      data-resource-choice=""
                      type="button"
                      key={item.id}
                      aria-label={`${item.label}, ${kinds[item.type]} in ${item.repository.name}`}
                      disabled={disabled || (!!checking && !checking.failed)}
                      onClick={() => choose(item)}
                      label={
                        <span className="flex flex-col whitespace-normal">
                          <span>{item.label}</span>
                          <small className="text-caption text-subtle">
                            {checking?.id === item.id && !checking.failed
                              ? "Checking…"
                              : `${kinds[item.type]} · ${item.repository.name}`}
                          </small>
                        </span>
                      }
                    />
                  ))}
                  {items.status === "ready" && !shown.length && (
                    <p>
                      {items.items.length
                        ? "No matching issues or pull requests."
                        : "This project has no issues or pull requests yet."}
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        </PopoverPopup>
      </fieldset>
    </PopoverRoot>
  );
}
