import { useState, type ComponentType, type ReactNode } from "react";
import { IconListCheck } from "@tabler/icons-react";
import type { InlineContent } from "../../features/conversation/contracts";
import type { RelayData } from "../../features/relay/service";
import type { Navigation } from "../../features/navigation/controller";
import { useRelayConnection } from "../../features/relay/react";
import { useFileStore } from "./file-store";
import { parseTask, taskKey, type Task } from "./data";
import { taskReferences } from "./reference";
import { TaskSummary } from "./TaskSummary";
import type { RelaySession } from "../../features/relay/session";
import styles from "./task.module.css";

type Editor = ComponentType<{
  session: RelaySession;
  scope: string;
  channel: string;
  message: string;
  label?: string;
}>;
export function TaskReference({
  text,
  content,
  relay,
  navigation,
  editor,
  fallback,
}: {
  text: string;
  content: InlineContent;
  relay: RelayData;
  navigation: Navigation;
  editor: Editor;
  fallback?: ReactNode;
}) {
  const connection = useRelayConnection(relay);
  if (connection.status !== "ready" || !connection.scope || !connection.viewer)
    return <>{text}</>;
  return (
    <ResolvedReference
      key={connection.scope}
      text={text}
      content={content}
      navigation={navigation}
      connection={connection}
      scope={connection.scope}
      viewer={connection.viewer}
      editor={editor}
      fallback={fallback}
    />
  );
}

function ResolvedReference({
  text,
  content,
  navigation,
  connection,
  scope,
  viewer,
  editor: TaskPopover,
  fallback,
}: {
  text: string;
  content: InlineContent;
  navigation: Navigation;
  scope: string;
  viewer: string;
  connection: ReturnType<typeof useRelayConnection>;
  editor: Editor;
  fallback?: ReactNode;
}) {
  const file = useFileStore(scope);
  const [error, setError] = useState("");
  const address = taskReferences(text)[0];
  if (!address) return <>{text}</>;
  const key = taskKey(scope, address.channel, address.root);
  const value = file.records?.[key]?.value;
  let task: Task | undefined;
  try {
    task = value ? parseTask(value) : undefined;
  } catch {
    /* Keep an unresolvable reference readable. */
  }
  if (!task && content.link) return <>{fallback ?? text}</>;
  const open = async () => {
    const result = await navigation.open({
      version: 1,
      kind: "conversation",
      scope: {
        viewer,
        communityOrigin: scope.slice(0, -(viewer.length + 1)),
      },
      channelId: address.channel,
      messageId: address.root,
      threadRootId: address.root,
    });
    setError(
      result.status === "failed"
        ? "Could not open task thread. Try again."
        : "",
    );
  };
  const card = task && content.message.content.trim() === text;
  return (
    <span
      data-buzz-ui=""
      className={card ? styles.referenceCard : styles.reference}
    >
      {card && task ? (
        <>
          <span className={styles.local}>Task · On this Mac</span>
          <TaskSummary task={task} session={connection.session} />
          <span className={styles.cardActions}>
            <button type="button" onClick={() => void open()}>
              Open thread
            </button>
            <TaskPopover
              session={connection.session}
              scope={scope}
              channel={address.channel}
              message={address.root}
              label="Task details"
            />
          </span>
        </>
      ) : (
        <button
          type="button"
          className={styles.inlineLink}
          onClick={() => void open()}
          title={text}
        >
          <IconListCheck size={14} aria-hidden="true" />
          {task?.title || "Task thread"}
        </button>
      )}
      {error && <span role="alert">{error}</span>}
    </span>
  );
}
