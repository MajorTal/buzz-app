import { useEffect, useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";
import { AgentChoice } from "./AgentChoice";
import { sessionAgents } from "./recipients";

/** The selected target is a composer choice; only relay membership grants access. */
export function SessionAgentControl({
  session,
  channelId,
  value,
  onChange,
  disabled,
}: {
  session: RelaySession;
  channelId: string;
  value: string;
  onChange: (key: string) => void;
  disabled: boolean;
}) {
  const list = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
  );
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const library = useSyncExternalStore(
    session.agentLibrary.subscribe,
    session.agentLibrary.snapshot,
  );
  const channel = list.channels.find((item) => item.id === channelId);
  const parent = list.channels.find(
    (item) => item.id === channel?.parentChannelId,
  );
  const memberKey = channel?.members?.join(":") ?? "";
  useEffect(() => {
    if (memberKey)
      void session.profiles
        .ensure(memberKey.split(":"), "background")
        .catch(() => {});
  }, [session, memberKey]);
  const agents = sessionAgents(channel, profiles, library, session.viewer);
  const implicit = agents?.length === 1 ? agents[0] : "";
  return (
    <AgentChoice
      session={session}
      value={value || implicit || ""}
      onChange={onChange}
      disabled={disabled}
      membersOnly={
        channel?.parentChannelId ? undefined : (channel?.members ?? [])
      }
      allowed={channel?.parentChannelId ? (parent?.members ?? []) : undefined}
      parentName={parent?.name}
      emptyLabel="Automatic / @mentions"
    />
  );
}
