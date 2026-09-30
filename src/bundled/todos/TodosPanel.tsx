import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { npubEncode } from "nostr-tools/nip19";
import type { RelaySession } from "../../features/relay/session";
import { useIdentityNames } from "../../features/identity-names/react";
import { Select } from "../../shared/design-system/ui/Select";
import type { ChannelCanvas } from "../../features/channel-templates/capability";
import type { ChannelPanelContext } from "../../features/panels/service";
import {
  XIcon,
  ListChecksIcon,
  PlayIcon,
} from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { Field } from "../../shared/design-system/ui/Field";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Input } from "../../shared/design-system/ui/Input";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import { publicKeyLabels } from "../../shared/identity/public-key";
import { readView, writeView } from "../../shared/view-state";
import {
  addTodo,
  assignTodo,
  readTodos,
  setStatus,
  type Status,
} from "./model";
import styles from "./Todos.module.css";

export type TodoPeople = {
  channels: Pick<
    RelaySession["channels"],
    "list" | "subscribeList" | "ensureList" | "refreshList"
  >;
  profiles: RelaySession["profiles"];
  names: RelaySession["names"];
};
type Draft = {
  content: string;
  original: string;
  base: string | null;
  input: string;
};
const empty: Draft = { content: "", original: "", base: null, input: "" };
const statuses: [Status, string][] = [
  ["todo", "To do"],
  ["doing", "Doing"],
  ["done", "Done"],
];
function readDraft(scope: string, key: string): Draft | undefined {
  const value = readView<Partial<Draft> | null>(scope, key, null);
  return value &&
    typeof value.content === "string" &&
    typeof value.original === "string" &&
    typeof value.input === "string" &&
    (value.base === null || typeof value.base === "string")
    ? (value as Draft)
    : undefined;
}
export function TodosPanel({
  canvas,
  people,
  context,
  close,
  active,
}: {
  canvas: ChannelCanvas;
  people: TodoPeople;
  context: ChannelPanelContext;
  close(): void;
  active(): boolean;
}) {
  const list = useSyncExternalStore(
    people.channels.subscribeList,
    people.channels.list,
  );
  const resolveIdentity = useIdentityNames(people.names);
  const members = list.channels.find(
    (channel) => channel.id === context.channelId,
  )?.members;
  const resolveName = (pubkey: string, fallback: string) =>
    resolveIdentity(pubkey, fallback, members ?? []);
  const key = `todos-draft-v1:${context.channelId}`;
  const [saved] = useState(() => readDraft(context.scope, key));
  const savedDirty = !!saved && saved.content !== saved.original;
  const [draft, setDraft] = useState<Draft>(saved ?? empty);
  const latestDraft = useRef(draft);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<"load" | "save">();
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const operation = useRef(0);
  const saving = useRef(false);
  const savedAt = useRef(0);
  const cancelWait = useRef<(() => void) | undefined>(undefined);
  const prefix = useId();
  const focusAfterToggle = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (focusAfterToggle.current && !busy) {
      const target = document.getElementById(focusAfterToggle.current);
      if (document.activeElement === document.body)
        (
          target?.querySelector<HTMLElement>("[role=combobox]") ?? target
        )?.focus();
      focusAfterToggle.current = undefined;
    }
  });
  const dirty = draft.content !== draft.original;
  const update = useCallback(
    (next: Draft) => {
      latestDraft.current = next;
      setDraft(next);
      writeView(
        context.scope,
        key,
        next.content !== next.original || next.input ? next : null,
      );
    },
    [context.scope, key],
  );
  const load = useCallback(
    async (replace = false) => {
      if (!active()) return;
      const generation = ++operation.current;
      setBusy("load");
      setError("");
      try {
        const head = await canvas.read(context.channelId);
        if (!active() || generation !== operation.current) return;
        savedAt.current = head?.created_at ?? 0;
        setLoaded(true);
        const alreadySaved = !!saved && saved.content === head?.content;
        const changed =
          !replace &&
          savedDirty &&
          !alreadySaved &&
          saved.base !== (head?.id ?? null);
        setConflict(changed);
        if (changed)
          setError(
            "Canvas changed elsewhere. Your draft is kept. Refresh to review the saved Canvas before saving.",
          );
        else if (!replace && savedDirty && !alreadySaved)
          setError("Recovered unsaved changes. Retry to save them to Canvas.");
        if (replace || !savedDirty || alreadySaved)
          update({
            ...empty,
            input: !replace ? (saved?.input ?? "") : "",
            content: head?.content ?? "",
            original: head?.content ?? "",
            base: head?.id ?? null,
          });
      } catch (reason) {
        if (active() && generation === operation.current)
          setError(String(reason));
      } finally {
        if (active() && generation === operation.current) setBusy(undefined);
      }
    },
    [active, canvas, context.channelId, saved, savedDirty, update],
  );
  // The parent keys this editor by session and channel. No background reads or writes.
  useEffect(() => {
    void load();
    return () => {
      operation.current++;
      cancelWait.current?.();
    };
  }, [load]);
  const save = async (next = draft) => {
    if (
      !active() ||
      saving.current ||
      busy ||
      !loaded ||
      next.content === next.original ||
      conflict ||
      !canvas.available
    )
      return;
    saving.current = true;
    const generation = ++operation.current;
    setBusy("save");
    setError("");
    try {
      // Canvas revisions use whole seconds. Wait once, without retrying a write.
      const delay = (savedAt.current + 1) * 1000 - Date.now();
      if (delay > 0) {
        await new Promise<void>((resolve) => {
          const timer = window.setTimeout(resolve, Math.min(delay, 1000));
          cancelWait.current = () => {
            window.clearTimeout(timer);
            resolve();
          };
        });
        cancelWait.current = undefined;
      }
      if (!active() || generation !== operation.current) return;
      const head = await canvas.save(
        context.channelId,
        next.content,
        next.base ?? undefined,
      );
      if (!active() || generation !== operation.current) return;
      savedAt.current = head.created_at;
      update({
        ...latestDraft.current,
        original: head.content,
        content: head.content,
        base: head.id,
      });
    } catch (reason) {
      if (active() && generation === operation.current)
        setError(
          `Todos couldn’t save. Your changes are still here. ${reason instanceof Error ? reason.message : String(reason)}`,
        );
    } finally {
      saving.current = false;
      if (active() && generation === operation.current) setBusy(undefined);
    }
  };
  const { parsed, parseError } = useMemo(() => {
    try {
      return { parsed: readTodos(draft.content), parseError: "" };
    } catch (reason) {
      return {
        parsed: undefined,
        parseError: reason instanceof Error ? reason.message : String(reason),
      };
    }
  }, [draft.content]);
  const inputDisabled =
    !loaded || busy === "load" || !canvas.available || !!parseError || conflict;
  const disabled = inputDisabled || busy === "save";
  const items = parsed?.items ?? [];
  const remaining = items.filter((item) => item.status !== "done").length;
  const peopleKey = [
    ...new Set([
      ...(members ?? []),
      ...items.flatMap((item) => (item.assignee ? [item.assignee.pubkey] : [])),
    ]),
  ]
    .sort()
    .join(":");
  const [namesError, setNamesError] = useState(false);
  const [namesRetry, setNamesRetry] = useState(0);
  useEffect(() => {
    void namesRetry; // Explicit user retry reruns this owned read.
    let current = true;
    people.channels.ensureList();
    void people.profiles
      .ensure(peopleKey ? peopleKey.split(":") : [], "background")
      .then(
        () => {
          if (current && active()) setNamesError(false);
        },
        () => {
          if (current && active()) setNamesError(true);
        },
      );
    return () => {
      current = false;
    };
  }, [people, peopleKey, active, namesRetry]);
  const keyLabels = publicKeyLabels(peopleKey.split(":"));
  const userLabel = (pubkey: string, fallback = "") => {
    const key = keyLabels.get(pubkey) ?? pubkey;
    const name = resolveName(pubkey, fallback);
    return name ? `${name} · ${key}` : key;
  };
  const choices = (members ?? [])
    .map((pubkey) => ({
      value: pubkey,
      label: userLabel(pubkey),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const change = (edit: () => string) => {
    if (!active() || disabled || saving.current) return;
    try {
      const next = { ...draft, content: edit() };
      update(next);
      void save(next);
    } catch (reason) {
      setError(String(reason));
    }
  };
  return (
    <div data-buzz-ui="" className={styles.panel} aria-busy={!!busy}>
      <PanelHeader
        icon={<ListChecksIcon size={18} aria-hidden="true" />}
        title={
          <div className={styles.heading}>
            <h2 className="text-label">Todos</h2>
            <span className="text-caption text-secondary">
              {context.channelName}
            </span>
          </div>
        }
        actions={
          <IconButton
            size="sm"
            variant="ghost"
            icon={<XIcon size={16} aria-hidden="true" />}
            aria-label="Hide todos"
            title="Hide todos"
            onClick={close}
          />
        }
      />
      <div className={styles.scroll}>
        <div className={styles.content}>
          <form
            className={styles.add}
            onSubmit={(event) => {
              event.preventDefault();
              if (
                !active() ||
                disabled ||
                saving.current ||
                !draft.input.trim()
              )
                return;
              try {
                const next = {
                  ...draft,
                  content: addTodo(draft.content, draft.input),
                  input: "",
                };
                focusAfterToggle.current = `${prefix}-new`;
                update(next);
                void save(next);
              } catch (reason) {
                setError(String(reason));
              }
            }}
          >
            <Field label="New todo" labelVisibility="hidden">
              <Input
                id={`${prefix}-new`}
                placeholder="Add a todo…"
                value={draft.input}
                disabled={inputDisabled}
                onChange={(event) =>
                  update({ ...latestDraft.current, input: event.target.value })
                }
              />
            </Field>
            <Button
              type="submit"
              size="sm"
              disabled={disabled || !draft.input.trim()}
            >
              Add
            </Button>
          </form>
          {(error || parseError) && (
            <p role="alert" className="text-body-sm text-danger">
              {error || parseError}
            </p>
          )}
          {(namesError || list.error || !members) && (
            <div className="text-caption text-secondary">
              {!members || list.error
                ? "Channel members unavailable or out of date."
                : "Names unavailable; public keys still identify users."}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (!active()) return;
                  people.channels.refreshList?.();
                  setNamesRetry((value) => value + 1);
                }}
              >
                Retry users
              </Button>
            </div>
          )}
          {!canvas.available && (
            <p className="text-body-sm text-secondary">
              This connection doesn’t support saving Canvas.
            </p>
          )}
          {!loaded ? (
            <p role="status" className="text-body-sm text-secondary">
              {busy ? "Loading todos…" : "Couldn’t load todos. Try Refresh."}
            </p>
          ) : (
            !parseError && (
              <>
                {items.length === 0 || remaining === 0 ? (
                  <div className={styles.empty}>
                    <p className="text-label">
                      {items.length ? "All done" : "No todos yet"}
                    </p>
                    <p className="text-body-sm text-secondary">
                      {items.length
                        ? "Uncheck an item to move it back."
                        : "Add the first item for this channel."}
                    </p>
                  </div>
                ) : null}
                {statuses.map(([status, title]) => {
                  const group = items.filter((item) => item.status === status);
                  return (
                    group.length > 0 && (
                      <section
                        key={status}
                        className={styles.group}
                        aria-label={title}
                      >
                        <h3 className="text-label-sm text-secondary">
                          {title} · {group.length}
                        </h3>
                        <ul className={styles.list}>
                          {group.map((item) => (
                            <li key={item.offset} className={styles.row}>
                              <Checkbox
                                id={`${prefix}-${item.offset}`}
                                checked={item.status === "done"}
                                indeterminate={item.status === "doing"}
                                disabled={disabled}
                                onCheckedChange={(value) => {
                                  focusAfterToggle.current = `${prefix}-${item.offset}`;
                                  change(() =>
                                    setStatus(
                                      draft.content,
                                      item.offset,
                                      value ? "done" : "todo",
                                    ),
                                  );
                                }}
                                label={
                                  <span
                                    className={`${styles.label} text-body-sm ${item.status === "done" ? "text-secondary" : ""}`}
                                    data-completed={
                                      item.status === "done" || undefined
                                    }
                                  >
                                    {item.label}
                                  </span>
                                }
                              />
                              <IconButton
                                id={`${prefix}-${item.offset}-doing`}
                                size="sm"
                                variant={
                                  item.status === "doing" ? "tint" : "ghost"
                                }
                                icon={<PlayIcon size={16} aria-hidden="true" />}
                                aria-label={`Doing: ${item.label}`}
                                title="Doing"
                                aria-pressed={item.status === "doing"}
                                disabled={disabled}
                                onClick={() => {
                                  focusAfterToggle.current = `${prefix}-${item.offset}-doing`;
                                  change(() =>
                                    setStatus(
                                      draft.content,
                                      item.offset,
                                      item.status === "doing"
                                        ? "todo"
                                        : "doing",
                                    ),
                                  );
                                }}
                              />
                              <fieldset
                                id={`${prefix}-${item.offset}-assignee`}
                                className={styles.assignee}
                                aria-label={`Assignee for ${item.label}`}
                              >
                                <Select
                                  label={`Assignee for ${item.label}`}
                                  variant="compact"
                                  valueLabel={
                                    item.assignee
                                      ? resolveName(
                                          item.assignee.pubkey,
                                          item.assignee.name,
                                        ) ||
                                        keyLabels.get(item.assignee.pubkey) ||
                                        ""
                                      : "Unassigned"
                                  }
                                  valueTitle={
                                    item.assignee
                                      ? npubEncode(item.assignee.pubkey)
                                      : "Unassigned"
                                  }
                                  value={item.assignee?.pubkey ?? ""}
                                  disabled={disabled || !members}
                                  groups={[
                                    {
                                      label: "Channel users",
                                      options: [
                                        { value: "", label: "Unassigned" },
                                        ...choices.map((choice) =>
                                          item.assignee?.pubkey === choice.value
                                            ? {
                                                ...choice,
                                                label: userLabel(
                                                  choice.value,
                                                  item.assignee.name,
                                                ),
                                              }
                                            : choice,
                                        ),
                                        ...(item.assignee &&
                                        !members?.includes(item.assignee.pubkey)
                                          ? [
                                              {
                                                value: item.assignee.pubkey,
                                                label: `${userLabel(item.assignee.pubkey, item.assignee.name)} (${members ? "not in channel" : "membership unavailable"})`,
                                                disabled: true,
                                              },
                                            ]
                                          : []),
                                      ],
                                    },
                                  ]}
                                  onValueChange={(pubkey) => {
                                    const currentMembers = people.channels
                                      .list()
                                      .channels.find(
                                        (channel) =>
                                          channel.id === context.channelId,
                                      )?.members;
                                    if (
                                      !currentMembers ||
                                      (pubkey &&
                                        !currentMembers.includes(pubkey))
                                    )
                                      return;
                                    focusAfterToggle.current = `${prefix}-${item.offset}-assignee`;
                                    change(() =>
                                      assignTodo(
                                        draft.content,
                                        item.offset,
                                        pubkey
                                          ? {
                                              pubkey,
                                              name: resolveName(
                                                pubkey,
                                                keyLabels.get(pubkey) ?? pubkey,
                                              ),
                                            }
                                          : undefined,
                                      ),
                                    );
                                  }}
                                />
                              </fieldset>
                            </li>
                          ))}
                        </ul>
                      </section>
                    )
                  );
                })}
              </>
            )
          )}
          <p className="text-caption text-secondary">
            Shared Markdown. Simultaneous saves can overwrite edits.
          </p>
        </div>
      </div>
      <footer className={styles.footer}>
        <div className={styles.summary}>
          <p role="status" className="text-caption">
            {busy === "save"
              ? "Saving…"
              : dirty
                ? "Unsaved changes"
                : loaded
                  ? "Saved in Canvas"
                  : "Channel Canvas"}
          </p>
        </div>
        <div className={styles.actions}>
          <Button
            size="sm"
            variant={error ? "prominent" : "subtle"}
            disabled={!!busy}
            onClick={() => {
              if (
                loaded &&
                (dirty || draft.input) &&
                !window.confirm(
                  "Discard your unsaved todo changes and load the saved Canvas?",
                )
              )
                return;
              void load(loaded);
            }}
          >
            Refresh
          </Button>
          {dirty && !busy && !conflict && !parseError && (
            <Button
              size="sm"
              variant="prominent"
              disabled={disabled}
              onClick={() => void save()}
            >
              Retry
            </Button>
          )}
        </div>
      </footer>
    </div>
  );
}
