import { useState } from "react";
import { IconMessageCircle } from "@tabler/icons-react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import {
  useChannelList,
  useChannelWindow,
  useRelayConnection,
} from "../../features/relay/react";
import { ChannelTimeline } from "../../features/messages/ChannelTimeline";
import { MessageComposer } from "../../features/messages/MessageComposer";
import { readView, writeView } from "../../shared/view-state";
import { SessionsWorkspace } from "./SessionsWorkspace";
import { NewSessionComposer } from "../../features/sessions/NewSessionComposer";
import {
  NewSessionView,
  SessionColumn,
  SessionHeading,
} from "../../features/sessions/SessionPresentation";
import styles from "../../features/sessions/Sessions.module.css";

export function SessionsPage({
  relay,
  extensions,
}: {
  relay: RelayData;
  extensions: ConversationExtensions;
}) {
  const connection = useRelayConnection(relay);
  return connection.status === "ready" ? (
    <LiveSessions
      key={`${connection.scope}:${connection.generation}`}
      session={connection.session}
      scope={connection.scope ?? ""}
      extensions={extensions}
    />
  ) : (
    <section className={styles.empty} aria-label="Sessions">
      <IconMessageCircle size={28} />
      <h1>Sessions</h1>
      <p>
        {connection.status === "connecting"
          ? "Connecting to your community…"
          : "Connect to a community to work with your agents."}
      </p>
      {connection.status === "error" && (
        <>
          <p role="alert">{connection.error ?? "The connection failed."}</p>
          <button type="button" onClick={relay.retry}>
            Retry connection
          </button>
        </>
      )}
    </section>
  );
}

function LiveSessions({
  session,
  scope,
  extensions,
}: {
  session: RelaySession;
  scope: string;
  extensions: ConversationExtensions;
}) {
  const list = useChannelList(session.channels);
  const [selected, setSelected] = useState(() => {
    const saved = readView<unknown>(scope, "sessions:selected", "");
    return typeof saved === "string" ? saved : "";
  });
  const selectedSession = list.channels.find(
    (item) => item.id === selected && item.channelType === "session",
  );
  const sessions = list.channels
    .filter((item) => item.channelType === "session" && !item.archived)
    .sort(
      (a, b) =>
        (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id),
    );
  const select = (id: string) => {
    setSelected(id);
    writeView(scope, "sessions:selected", id);
  };
  return (
    <SessionsWorkspace
      sessions={sessions.map((item) => ({
        id: item.id,
        title: item.name,
        ...(item.parentChannelId
          ? {
              parentName:
                list.channels.find(
                  (parent) => parent.id === item.parentChannelId,
                )?.name ?? "Channel session",
            }
          : {}),
      }))}
      selected={selected}
      onSelect={select}
      onNew={() => {
        select("");
      }}
      listStatus={
        list.status === "loading" ? (
          <p role="status">Loading sessions…</p>
        ) : list.status === "error" ? (
          <div role="alert">
            <p>{list.error ?? "Sessions couldn’t load."}</p>
            <button
              type="button"
              onClick={() => session.channels.refreshList?.()}
            >
              Retry
            </button>
          </div>
        ) : undefined
      }
    >
      {selectedSession ? (
        <SessionWork
          key={selectedSession.id}
          session={session}
          scope={scope}
          channel={selectedSession}
          extensions={extensions}
          parentName={
            list.channels.find(
              (item) => item.id === selectedSession.parentChannelId,
            )?.name
          }
        />
      ) : (
        <NewSessionView>
          <NewSessionComposer
            extensions={extensions}
            session={session}
            scope={scope}
            onStarted={select}
          />
        </NewSessionView>
      )}
    </SessionsWorkspace>
  );
}

function SessionWork({
  session,
  scope,
  channel,
  extensions,
  parentName,
}: {
  session: RelaySession;
  scope: string;
  channel: ChannelSummary;
  extensions: ConversationExtensions;
  parentName?: string | undefined;
}) {
  const window = useChannelWindow(session.channels, channel.id);
  const [sent, setSent] = useState<string>();
  const openLink = () => false;
  return (
    <div className={styles.work}>
      <SessionHeading channel={channel} parentName={parentName} />
      <SessionColumn>
        <div className={styles.timeline}>
          {window.status === "error" && !window.rows.length ? (
            <div className={styles.empty} role="alert">
              <p>{window.error}</p>
              <button
                type="button"
                onClick={() => session.channels.ensure(channel.id)}
              >
                Retry messages
              </button>
            </div>
          ) : window.status !== "ready" && !window.rows.length ? (
            <p className={styles.empty} role="status">
              Loading messages…
            </p>
          ) : (
            <ChannelTimeline
              extensions={extensions}
              queries={session}
              scope={scope}
              channelId={channel.id}
              window={window}
              revealMessageId={sent}
              onOpenLink={openLink}
            />
          )}
        </div>
        <MessageComposer
          sessionConversation
          onSend={setSent}
          extensions={extensions}
          session={session}
          scope={scope}
          channelId={channel.id}
          channelName={channel.name}
          label="Message this session"
          disabled={!!channel.archived || window.status !== "ready"}
        />
      </SessionColumn>
    </div>
  );
}
