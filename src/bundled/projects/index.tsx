import { useEffect, useState } from "react";
import { IconHash, IconSearch } from "@tabler/icons-react";
import type { PluginModule } from "../../plugins/api";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { Navigation } from "../../features/navigation/controller";
import { useChannelList, useRelayConnection } from "../../features/relay/react";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import { Button } from "../../shared/design-system/ui/Button";
import { channelTasks } from "../task-details/data";
import { isProject, projectKey } from "./data";
import { useFileStore } from "../task-details/file-store";
import styles from "./projects.module.css";
import { TaskSummary } from "../task-details/TaskSummary";

export const inject = ["pages", "relay", "navigation"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.pages.register({
    id: "projects",
    title: "Projects",
    layout: "workspace",
    component: () => (
      <ProjectsPage relay={ctx.relay} navigation={ctx.navigation} />
    ),
  });
};

function ProjectsPage({
  relay,
  navigation,
}: {
  relay: RelayData;
  navigation: Navigation;
}) {
  const connection = useRelayConnection(relay);
  return (
    <div className="h-full min-h-0">
      <FullPageSurface aria-label="Projects">
        <div className={`${styles.page} text-body`} data-buzz-ui="">
          <header className={styles.heading}>
            <h1 className="text-title">Projects</h1>
            <span title="Shared with local agent scripts. Not synced to the relay.">
              On this Mac
            </span>
          </header>
          {connection.status === "ready" &&
          connection.scope &&
          connection.viewer ? (
            <ProjectList
              key={`${connection.scope}:${connection.generation}`}
              session={connection.session}
              scope={connection.scope}
              viewer={connection.viewer}
              navigation={navigation}
            />
          ) : (
            <div role="status">
              Connect to a community to see its projects.{" "}
              <Button onClick={() => relay.retry()}>Reconnect</Button>
            </div>
          )}
        </div>
      </FullPageSurface>
    </div>
  );
}

function ProjectList({
  session,
  scope,
  viewer,
  navigation,
}: {
  session: RelaySession;
  scope: string;
  viewer: string;
  navigation: Navigation;
}) {
  const list = useChannelList(session.channels);
  const [selected, select] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    void session.agentLibrary.refresh();
  }, [session]);
  const file = useFileStore(scope);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const channels = list.channels.filter(
    (c) => !c.archived && c.channelType !== "dm",
  );
  let projects: {
    channel: (typeof channels)[number];
    tasks: ReturnType<typeof channelTasks>;
  }[] = [];
  let readError = "";
  try {
    projects = channels
      .filter((c) => isProject(file.storage, scope, c.id))
      .map((channel) => ({
        channel,
        tasks: channelTasks(file.storage, scope, channel.id),
      }));
  } catch (e) {
    readError = String(e);
  }
  const open = async (channelId: string, messageId?: string) => {
    const result = await navigation.open({
      version: 1,
      kind: "conversation",
      scope: { viewer, communityOrigin: scope.slice(0, -(viewer.length + 1)) },
      channelId,
      ...(messageId ? { messageId, threadRootId: messageId } : {}),
    });
    if (result.status === "failed")
      setError("Could not open the conversation. Try again.");
  };
  const query = search.trim().toLowerCase();
  const visible = projects
    .map(({ channel, tasks }) => ({
      channel,
      tasks: channel.name.toLowerCase().includes(query)
        ? tasks
        : tasks.filter(({ task }) =>
            `${task.title} ${task.description}`.toLowerCase().includes(query),
          ),
    }))
    .filter(
      ({ channel, tasks }) =>
        tasks.length || channel.name.toLowerCase().includes(query),
    );
  return (
    <>
      {!file.records && <p role="status">Loading task file…</p>}
      {file.error && (
        <p role="alert">
          {file.error} <Button onClick={file.retry}>Retry</Button>
        </p>
      )}
      {list.status === "error" ? (
        <div role="alert">
          Could not load channels.{" "}
          <Button onClick={() => session.channels.refreshList?.()}>
            Retry
          </Button>
        </div>
      ) : null}
      {list.status === "loading" || list.status === "idle" ? (
        <p role="status">Loading channels…</p>
      ) : null}
      {readError || error ? <p role="alert">{readError || error}</p> : null}
      <label className={styles.search}>
        <IconSearch size={18} aria-hidden="true" />
        <input
          type="search"
          aria-label="Find projects or tasks"
          placeholder="Find projects or tasks…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      <details className={styles.addProject}>
        <summary>Add project</summary>
        <form
          className={styles.add}
          aria-label="Add local project"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!channels.some((c) => c.id === selected) || readError || saving)
              return;
            setSaving(true);
            try {
              const key = projectKey(scope, selected);
              await file.save(
                key,
                "true",
                file.records?.[key]?.revision ?? null,
              );
              setError("");
              select("");
              file.retry();
            } catch (e) {
              setError(String(e));
            } finally {
              setSaving(false);
            }
          }}
        >
          <label>
            Channel
            <select
              value={selected}
              onChange={(event) => select(event.target.value)}
            >
              <option value="">Choose an existing channel</option>
              {channels
                .filter((c) => !projects.some((p) => p.channel.id === c.id))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </label>
          <Button
            type="submit"
            disabled={
              !file.records ||
              saving ||
              !!file.error ||
              !channels.some((c) => c.id === selected) ||
              !!readError
            }
          >
            Add project
          </Button>
        </form>
      </details>
      {file.records &&
      list.status === "ready" &&
      !projects.length &&
      !readError &&
      !file.error ? (
        <p>No local projects yet.</p>
      ) : null}
      {!!projects.length && !visible.length && (
        <p className={styles.empty} role="status">
          No matching projects or tasks.
        </p>
      )}
      {visible.map(({ channel, tasks }) => (
        <section
          key={channel.id}
          className={styles.project}
          aria-label={channel.name}
        >
          <header className={styles.projectHeader}>
            <h2>
              <Button variant="ghost" onClick={() => void open(channel.id)}>
                <IconHash size={18} aria-hidden="true" />
                {channel.name}
              </Button>
            </h2>
            <span>
              {tasks.length} {tasks.length === 1 ? "task" : "tasks"}
            </span>
          </header>
          {tasks.length ? (
            <ul>
              {tasks.map(({ root, task }) => (
                <li key={root}>
                  <button
                    type="button"
                    className={styles.taskRow}
                    aria-label={task.title}
                    onClick={() => void open(channel.id, root)}
                  >
                    <TaskSummary task={task} session={session} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.empty}>
              No tasks yet. Open a thread in this channel to add task details.
            </p>
          )}
        </section>
      ))}
    </>
  );
}
