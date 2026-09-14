import { useMemo, useState } from "react";
import type { RelayData } from "../../features/relay/service";
import { useChannelList, useRelayConnection } from "../../features/relay/react";
import type { Navigation } from "../../features/navigation/controller";
import type { PageNavigation } from "../../features/navigation/service";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import { ThreadPanel } from "../../features/messages/ThreadPanel";
import { Button } from "../../shared/design-system/ui/Button";
import { useFileStore } from "./file-store";
import { parseTask, taskKey, type Task } from "./data";
import { TaskSummary } from "./TaskSummary";
import { TaskPopover } from "./index";
import styles from "./task.module.css";

type Props = {
  relay: RelayData;
  navigator: Navigation;
  navigation: PageNavigation;
  extensions: ConversationExtensions;
  address: { channel: string; root: string };
};

export function TaskWorkspace(props: Props) {
  const connection = useRelayConnection(props.relay);
  const target = props.navigation.target;
  const requested = target.kind === "page" ? target.scope : undefined;
  if (
    connection.status !== "ready" ||
    !connection.scope ||
    !connection.viewer ||
    !requested ||
    connection.scope !== `${requested.communityOrigin}:${requested.viewer}`
  )
    return (
      <p role="status">
        Connecting to the task’s community…{" "}
        <Button onClick={props.relay.retry}>Retry</Button>
      </p>
    );
  return (
    <Workspace
      key={`${connection.scope}:${connection.generation}:${props.address.channel}:${props.address.root}`}
      {...props}
      connection={connection}
      scope={connection.scope}
      viewer={connection.viewer}
    />
  );
}

function Workspace({
  relay,
  navigator,
  navigation,
  extensions,
  address,
  connection,
  scope,
  viewer,
}: Props & {
  connection: ReturnType<typeof useRelayConnection>;
  scope: string;
  viewer: string;
}) {
  const file = useFileStore(scope);
  const list = useChannelList(connection.session.channels);
  const channel = list.channels.find((entry) => entry.id === address.channel);
  const [error, setError] = useState("");
  const conversation = useMemo(() => {
    const registry = extensions.attachments;
    if (!registry) return extensions;
    let previous = registry.snapshot();
    let filtered = previous.filter(
      (entry) => entry.key !== "buzz.task-details/task",
    );
    return {
      ...extensions,
      attachments: {
        subscribe: registry.subscribe,
        snapshot: () => {
          const next = registry.snapshot();
          if (next !== previous) {
            previous = next;
            filtered = next.filter(
              (entry) => entry.key !== "buzz.task-details/task",
            );
          }
          return filtered;
        },
      },
    };
  }, [extensions]);
  const openChannel = async () => {
    const result = await navigator.open({
      version: 1,
      kind: "conversation",
      scope: { viewer, communityOrigin: scope.slice(0, -(viewer.length + 1)) },
      channelId: address.channel,
      messageId: address.root,
      threadRootId: address.root,
    });
    if (result.status === "failed")
      setError("Could not open the channel. Try again.");
  };
  let task: Task | undefined;
  let readError = file.error;
  try {
    const raw =
      file.records?.[taskKey(scope, address.channel, address.root)]?.value;
    if (raw) task = parseTask(raw);
  } catch (e) {
    readError = String(e);
  }
  if (list.status !== "ready" || !channel)
    return (
      <p
        role={
          list.status === "error" || list.status === "ready"
            ? "alert"
            : "status"
        }
      >
        {list.status === "error"
          ? "Could not load the task’s channel."
          : list.status === "ready"
            ? "The task’s channel is unavailable."
            : "Loading the task’s channel…"}{" "}
        <Button onClick={() => connection.session.channels.refreshList?.()}>
          Retry
        </Button>
      </p>
    );
  return (
    <section className={styles.workspace} aria-label="Task workspace">
      <ThreadPanel
        session={connection.session}
        scope={scope}
        channelId={address.channel}
        channelName={channel?.name ?? address.channel}
        messageId={address.root}
        navigation={navigation.forSession(relay, connection)}
        extensions={conversation}
        close={() => void openChannel()}
        onOpenLink={() => false}
        header={
          <header className={styles.workspaceHeader} data-buzz-ui="">
            <div className={styles.cardActions}>
              <span className={styles.local}>
                Task · {channel?.name ?? "Conversation"} · On this Mac
              </span>
              <Button variant="ghost" onClick={() => void openChannel()}>
                View in channel
              </Button>
            </div>
            {task ? (
              <TaskSummary task={task} session={connection.session} />
            ) : (
              <p role="status">
                {file.records
                  ? "No saved task details for this thread."
                  : "Loading task details…"}
              </p>
            )}
            {(readError || error) && (
              <p role="alert">
                {readError || error} <Button onClick={file.retry}>Retry</Button>
              </p>
            )}
            <TaskPopover
              session={connection.session}
              scope={scope}
              channel={address.channel}
              message={address.root}
              label="Edit task"
            />
          </header>
        }
      />
    </section>
  );
}
