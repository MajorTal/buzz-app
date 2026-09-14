import { useEffect, useState } from "react";
import type { PluginModule } from "../../plugins/api";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { Navigation } from "../../features/navigation/controller";
import { useChannelList, useRelayConnection } from "../../features/relay/react";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import { Button } from "../../shared/design-system/ui/Button";
import { channelTasks } from "../task-details/data";
import { isProject, markProject } from "./data";
import styles from "./projects.module.css";

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
          <h1 className="text-title">Projects</h1>
          <p>
            Local to this browser or app. Task details are not shared with
            agents or other devices.
          </p>
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
  const [, refresh] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    const changed = () => refresh((v) => v + 1);
    window.addEventListener("storage", changed);
    window.addEventListener("focus", changed);
    return () => {
      window.removeEventListener("storage", changed);
      window.removeEventListener("focus", changed);
    };
  }, []);
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
      .filter((c) => isProject(localStorage, scope, c.id))
      .map((channel) => ({
        channel,
        tasks: channelTasks(localStorage, scope, channel.id),
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
      ...(messageId ? { messageId } : {}),
    });
    if (result.status === "failed")
      setError("Could not open the conversation. Try again.");
  };
  return (
    <>
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
      <form
        className={styles.add}
        aria-label="Add local project"
        onSubmit={(event) => {
          event.preventDefault();
          if (!channels.some((c) => c.id === selected) || readError) return;
          try {
            markProject(localStorage, scope, selected);
            setError("");
            select("");
            refresh((v) => v + 1);
          } catch (e) {
            setError(String(e));
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
          disabled={!channels.some((c) => c.id === selected) || !!readError}
        >
          Mark as project locally
        </Button>
      </form>
      {list.status === "ready" && !projects.length && !readError ? (
        <p>No local projects yet.</p>
      ) : null}
      {projects.map(({ channel, tasks }) => (
        <section
          key={channel.id}
          className={styles.project}
          aria-label={channel.name}
        >
          <h2>
            <Button variant="ghost" onClick={() => void open(channel.id)}>
              {channel.name}
            </Button>
          </h2>
          {tasks.length ? (
            <ul>
              {tasks.map(({ root, task }) => (
                <li key={root}>
                  <Button
                    variant="ghost"
                    onClick={() => void open(channel.id, root)}
                  >
                    {task.title}
                  </Button>
                  {task.description ? <p>{task.description}</p> : null}
                  {task.assignee ? <p>Assigned to {task.assignee}</p> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p>No task details saved for this channel on this device yet.</p>
          )}
        </section>
      ))}
    </>
  );
}
