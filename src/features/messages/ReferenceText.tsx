import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { IconAt, IconRobot } from "@tabler/icons-react";
import type { RelaySession } from "../relay/session";
import type { Profile, ChannelSummary } from "../relay/contracts";
import { messageReferences } from "./message-references";
import { MessageLink } from "../conversation/MessageLink";
import type { ConversationExtensions } from "../conversation/contracts";
import { parseBuzzLink } from "../navigation/buzz-links";
import type { AgentLibrary } from "../agents/library";
import styles from "../../shared/InlineReference.module.css";

const emptyProfiles: ReadonlyMap<string, Profile> = new Map();
const emptyChannels: readonly ChannelSummary[] = [];
const emptyAgents: AgentLibrary["identities"] = [];
export const emptyReferenceDirectory = {
  profiles: emptyProfiles,
  channels: emptyChannels,
  agents: emptyAgents,
};
const noop = () => () => {};
const profilesSnapshot = () => emptyProfiles;
const channelsSnapshot = () => undefined;
const agentsSnapshot = () => undefined;

export function useReferenceDirectory(
  session: RelaySession | undefined,
  hasMentions: boolean,
) {
  const profiles = useSyncExternalStore(
    session?.profiles?.subscribe ?? noop,
    session?.profiles?.snapshot ?? profilesSnapshot,
    profilesSnapshot,
  );
  const channels = useSyncExternalStore(
    session?.channels?.subscribeList ?? noop,
    session?.channels?.list ?? channelsSnapshot,
    channelsSnapshot,
  );
  const agents = useSyncExternalStore(
    session?.agentLibrary?.subscribe ?? noop,
    session?.agentLibrary?.snapshot ?? agentsSnapshot,
    agentsSnapshot,
  );
  useEffect(() => {
    if (hasMentions && agents?.status === "idle")
      void session?.agentLibrary.refresh();
  }, [session, hasMentions, agents?.status]);
  return {
    profiles,
    channels: channels?.channels ?? emptyChannels,
    agents: agents?.identities ?? emptyAgents,
  };
}

export function channelLinkLabel(
  url: string,
  scope: string | undefined,
  channels: readonly ChannelSummary[],
) {
  const parsed = parseBuzzLink(url);
  const target =
    parsed?.format === "legacy"
      ? parsed
      : parsed?.target.kind === "conversation" &&
          parsed.target.scope.communityOrigin === scope?.slice(0, -65)
        ? parsed.target
        : undefined;
  const channel =
    target && channels.find((item) => item.id === target.channelId);
  return channel
    ? `${channel.channelType === "dm" || target.messageId ? "" : "#"}${channel.name}`
    : undefined;
}

export function ReferenceText({
  text,
  mentions,
  directory,
  renderText,
  onOpenLink,
  extensions,
  session,
  scope,
  interactive = true,
}: {
  text: string;
  mentions: readonly string[];
  directory: ReturnType<typeof useReferenceDirectory>;
  renderText(text: string): ReactNode;
  onOpenLink(url: string): boolean;
  extensions?: ConversationExtensions | undefined;
  session?: RelaySession | undefined;
  scope?: string | undefined;
  interactive?: boolean;
}) {
  const references = messageReferences(
    text,
    mentions,
    directory.profiles,
    directory.channels,
    directory.agents,
  );
  if (!references.length) return renderText(text);
  const parts: ReactNode[] = [];
  let offset = 0;
  for (const reference of references) {
    parts.push(
      <span key={`text:${offset}`}>
        {renderText(text.slice(offset, reference.start))}
      </span>,
    );
    const Icon = reference.kind === "agent" ? IconRobot : IconAt;
    parts.push(
      reference.kind === "channel" ? (
        <MessageLink
          key={reference.start}
          url={`buzz://channel/${encodeURIComponent(reference.id)}`}
          label={reference.label}
          registry={extensions?.links}
          onOpenLink={onOpenLink}
          session={session}
          scope={scope}
          interactive={interactive}
        />
      ) : (
        <span
          key={reference.start}
          className={styles.link}
          data-mention-kind={reference.kind}
          title={`${reference.kind === "agent" ? "Agent" : "Person"}: ${reference.label.slice(1)}\n${reference.id}`}
        >
          <Icon aria-hidden="true" className={styles.icon} />
          {reference.label.slice(1)}
        </span>
      ),
    );
    offset = reference.end;
  }
  parts.push(
    <span key={`text:${offset}`}>{renderText(text.slice(offset))}</span>,
  );
  return <>{parts}</>;
}
