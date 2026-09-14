import { useEffect, useState, useSyncExternalStore } from "react";
import { Input } from "@base-ui/react/input";
import { Field } from "@base-ui/react/field";
import { Popover } from "@base-ui/react/popover";
import { IconListCheck } from "@tabler/icons-react";
import type { PluginModule } from "../../plugins/api";
import type { ComposerToolProps } from "../../features/conversation/contracts";
import type { RelaySession } from "../../features/relay/session";
import type { ThreadView } from "../../features/relay/threads";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { parseTask, taskKey, type Task } from "./data";
import { useFileStore } from "./file-store";
import styles from "./task.module.css";
import { AssigneePicker } from "./AssigneePicker";
import { ensureTaskMember } from "./ensure-member";

export const inject = ["conversation"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.conversation.registerTool({
    id: "details",
    title: "Local task details",
    component: TaskTool,
  });
};

function TaskTool({
  session,
  scope,
  channelId,
  threadRootId,
}: ComposerToolProps) {
  if (!threadRootId) return null;
  return (
    <Popover.Root key={`${scope}:${channelId}:${threadRootId}`}>
      <Popover.Trigger
        render={
          <IconButton
            icon={<IconListCheck size={16} aria-hidden="true" />}
            size="toolbar"
            variant="ghost"
            aria-label="Task details"
            title="Task details"
          />
        }
      />
      <Popover.Portal>
        <Popover.Positioner
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          style={{ zIndex: 1000 }}
        >
          <Popover.Popup className={styles.popup} aria-label="Task details">
            <Popover.Close
              className={styles.close}
              aria-label="Close task details"
            >
              ×
            </Popover.Close>
            <ResolveThread
              session={session}
              scope={scope}
              channel={channelId}
              message={threadRootId}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ResolveThread({
  session,
  scope,
  channel,
  message,
}: {
  session: RelaySession;
  scope: string;
  channel: string;
  message: string;
}) {
  const [view, setView] = useState<ThreadView>();
  const [error, setError] = useState("");
  const [attempt, retry] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly reallocates a failed thread view.
  useEffect(() => {
    setError("");
    let active = true;
    let owned: ThreadView | undefined;
    try {
      owned = session.thread(channel, message);
      setView(owned);
      void owned.refresh().catch((e: unknown) => {
        if (active) setError(String(e));
      });
    } catch (e) {
      setError(String(e));
    }
    return () => {
      active = false;
      owned?.dispose();
    };
  }, [session, channel, message, attempt]);
  if (error)
    return (
      <div role="alert">
        {error}
        <Button onClick={() => retry(attempt + 1)}>Retry</Button>
      </div>
    );
  return view ? (
    <ResolvedTask
      view={view}
      scope={scope}
      channel={channel}
      session={session}
    />
  ) : (
    <p role="status">Loading thread…</p>
  );
}

function ResolvedTask({
  session,
  view,
  scope,
  channel,
}: {
  session: RelaySession;
  view: ThreadView;
  scope: string;
  channel: string;
}) {
  const snapshot = useSyncExternalStore(
    view.subscribe,
    view.snapshot,
    view.snapshot,
  );
  if (snapshot.status === "error")
    return (
      <div role="alert">
        Could not read this thread.
        <Button onClick={() => void view.refresh()}>Retry</Button>
      </div>
    );
  if (!snapshot.root)
    return (
      <p role="status">
        {snapshot.status === "ready"
          ? "The thread opening message is unavailable."
          : "Loading thread…"}
      </p>
    );
  const storageKey = taskKey(scope, channel, snapshot.root.id);
  return (
    <FileTask
      key={storageKey}
      storageKey={storageKey}
      scope={scope}
      session={session}
    />
  );
}

function FileTask({
  session,
  storageKey,
  scope,
}: {
  session: RelaySession;
  storageKey: string;
  scope: string;
}) {
  const file = useFileStore(scope);
  return (
    <>
      {file.error && (
        <p role="alert">
          {file.error} <Button onClick={file.retry}>Retry</Button>
        </p>
      )}
      {file.records ? (
        <TaskEditor storageKey={storageKey} file={file} session={session} />
      ) : (
        <p role="status">Loading task file…</p>
      )}
    </>
  );
}

function TaskEditor({
  session,
  storageKey,
  file,
}: {
  session: RelaySession;
  storageKey: string;
  file: ReturnType<typeof useFileStore>;
}) {
  const [loaded] = useState(() => {
    try {
      const raw = file.records?.[storageKey]?.value ?? null;
      return { raw, task: parseTask(raw), error: "" };
    } catch (e) {
      return { raw: null, task: undefined, error: String(e) };
    }
  });
  const [task, setTask] = useState(loaded.task);
  const [previous, setPrevious] = useState(
    file.records?.[storageKey]?.revision ?? null,
  );
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState(loaded.error);
  if (!task)
    return (
      <p role="alert">
        Could not load local task details. Reopen the panel to retry. {error}
      </p>
    );
  const update = (next: Task) => {
    setTask(next);
    setNotice("");
    setError("");
  };
  const field = (
    label: string,
    value: string,
    change: (value: string) => void,
  ) => (
    <Field.Root className={styles.field}>
      <Field.Label>{label}</Field.Label>
      <Input value={value} maxLength={16000} onValueChange={change} />
    </Field.Root>
  );
  return (
    <form
      data-buzz-ui=""
      className={styles.form}
      aria-label="Local task details"
      onSubmit={async (event) => {
        event.preventDefault();
        if (saving) return;
        setSaving(true);
        try {
          const revision = await file.save(
            storageKey,
            JSON.stringify(task),
            previous,
          );
          setPrevious(revision);
          setError("");
          setNotice("Saved on this device.");
        } catch (e) {
          setError(String(e));
          setNotice("");
        } finally {
          setSaving(false);
        }
      }}
    >
      <div className="flex items-center gap-2 text-heading">
        <IconListCheck size={18} aria-hidden="true" />
        Task details
      </div>
      <p className="text-body-sm text-secondary">
        Saved on this Mac · Shared with local agent scripts, not the relay.
      </p>
      {field("Title", task.title, (title) => update({ ...task, title }))}
      <label className={styles.field}>
        Description
        <textarea
          rows={3}
          maxLength={16000}
          value={task.description}
          onChange={(e) => update({ ...task, description: e.target.value })}
        />
      </label>
      <AssigneePicker
        session={session}
        value={task.assignee}
        onChange={(assignee) => update({ ...task, assignee })}
      />
      <div>
        <Button
          type="button"
          disabled={saving || !task.assignee || !session.outbox?.supports(9)}
          onClick={async () => {
            if (saving) return;
            setSaving(true);
            setError("");
            setNotice("");
            try {
              const revision = await file.save(
                storageKey,
                JSON.stringify(task),
                previous,
              );
              setPrevious(revision);
              const [, channelId, rootId] = JSON.parse(
                storageKey.slice("buzz.local-task.v1:".length),
              );
              setNotice(
                "Assignment saved. Notification has not been queued yet.",
              );
              await ensureTaskMember(session, channelId, task.assignee);
              const name =
                session.agentLibrary
                  .snapshot()
                  .identities.find((agent) => agent.pubkey === task.assignee)
                  ?.name || task.assignee;
              session.messages.reply(
                channelId,
                rootId,
                `@${name}, I've assigned you this task. Please start work here.`,
                [task.assignee],
              );
              setNotice(
                "Assignment saved; notification queued. Check the thread for delivery status.",
              );
            } catch (e) {
              setError(String(e));
            } finally {
              setSaving(false);
            }
          }}
        >
          Assign
        </Button>
        <p className="text-body-sm text-secondary">
          Saves the task, adds the agent to this channel if needed, and notifies
          them to start work.
        </p>
      </div>
      {task.branches.map((link, index) => (
        <fieldset key={link.id} className={styles.branch}>
          <legend className="text-body-sm text-secondary">
            Branch {index + 1}
          </legend>
          {field("Repository URL", link.repository, (repository) =>
            update({
              ...task,
              branches: task.branches.map((b, i) =>
                i === index ? { ...b, repository } : b,
              ),
            }),
          )}
          {field("Branch name", link.branch, (branch) =>
            update({
              ...task,
              branches: task.branches.map((b, i) =>
                i === index ? { ...b, branch } : b,
              ),
            }),
          )}
          <Button
            size="compact"
            onClick={() =>
              update({
                ...task,
                branches: task.branches.filter((_, i) => i !== index),
              })
            }
          >
            Remove branch {index + 1}
          </Button>
        </fieldset>
      ))}
      <div className="flex gap-2">
        <Button
          disabled={task.branches.length >= 20}
          onClick={() =>
            update({
              ...task,
              branches: [
                ...task.branches,
                { id: crypto.randomUUID(), repository: "", branch: "" },
              ],
            })
          }
        >
          Link existing branch
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={saving || !!file.error}
        >
          Save locally
        </Button>
        <Button
          disabled={saving || !previous || !!file.error}
          onClick={async () => {
            if (
              !window.confirm(
                "Delete task metadata? The conversation will remain.",
              )
            )
              return;
            setSaving(true);
            try {
              setPrevious(await file.save(storageKey, null, previous));
              setTask(parseTask(null));
              setError("");
              setNotice("Task metadata deleted. Conversation unchanged.");
            } catch (e) {
              setError(String(e));
            } finally {
              setSaving(false);
            }
          }}
        >
          Delete task
        </Button>
        <Button
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            try {
              const records = await file.read();
              setTask(parseTask(records[storageKey]?.value ?? null));
              setPrevious(records[storageKey]?.revision ?? null);
              setNotice("");
              setError("");
              file.retry();
            } catch (e) {
              setError(String(e));
            } finally {
              setSaving(false);
            }
          }}
        >
          Reload saved task
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-body text-red-12">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-body-sm text-secondary">
          {notice}
        </p>
      )}
    </form>
  );
}
