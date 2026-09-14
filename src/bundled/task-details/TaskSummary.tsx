import { useEffect, useSyncExternalStore } from "react";
import { IconGitBranch, IconListCheck } from "@tabler/icons-react";
import type { RelaySession } from "../../features/relay/session";
import { Avatar } from "../../shared/Avatar";
import type { Task } from "./data";
import styles from "./task.module.css";

export function TaskAssignee({
  session,
  value,
}: {
  session: RelaySession;
  value: string;
}) {
  useEffect(() => {
    if (value && session.agentLibrary.snapshot().status === "idle")
      void session.agentLibrary.refresh();
  }, [session, value]);
  const library = useSyncExternalStore(
    session.agentLibrary.subscribe,
    session.agentLibrary.snapshot,
    session.agentLibrary.snapshot,
  );
  const agent = library.identities.find((entry) => entry.pubkey === value);
  const name =
    agent?.name || (value.length > 20 ? "Assigned" : value) || "Unassigned";
  return (
    <span className={styles.person} title={value || undefined}>
      {agent && (
        <Avatar
          name={name}
          src={agent?.avatar ? session.media(agent.avatar) : undefined}
          className={styles.avatar ?? ""}
        />
      )}
      {name}
    </span>
  );
}

export function TaskSummary({
  task,
  session,
}: {
  task: Task;
  session: RelaySession;
}) {
  return (
    <span className={styles.summary}>
      <span className={styles.summaryTitle}>
        <IconListCheck size={18} aria-hidden="true" />
        <strong>{task.title || "Untitled task"}</strong>
      </span>
      {task.description && (
        <span className={styles.description}>{task.description}</span>
      )}
      <span className={styles.metadata}>
        <TaskAssignee session={session} value={task.assignee} />
        {task.branches.map((branch) => (
          <span
            className={styles.person}
            key={branch.id}
            title={branch.repository}
          >
            <IconGitBranch size={14} aria-hidden="true" />
            {branch.branch || "Branch not specified"}
          </span>
        ))}
      </span>
    </span>
  );
}
