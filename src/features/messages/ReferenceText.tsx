import { useChannelIdentityNames } from "../identity-names/react";
import { useSyncExternalStore, type ReactNode } from "react";
import { AtIcon, RobotIcon } from "../../shared/design-system/icons/index";
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
  selectedProfiles?: ReadonlyMap<string, Profile>,
) {
  const profiles = useSyncExternalStore(
    selectedProfiles ? noop : (session?.profiles?.subscribe ?? noop),
    selectedProfiles
      ? () => selectedProfiles
      : (session?.profiles?.snapshot ?? profilesSnapshot),
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
  return {
    profiles,
    channels: channels?.channels ?? emptyChannels,
    agents: agents?.identities ?? emptyAgents,
  };
}

/** Buzz links carry no community, so they always name a channel in the receiving one. */
export function channelForLink(
  url: string,
  channels: readonly ChannelSummary[],
) {
  const parsed = parseBuzzLink(url);
  const target = parsed?.format === "legacy" ? parsed : undefined;
  return target && channels.find((item) => item.id === target.channelId);
}

export function channelLinkLabel(
  url: string,
  channels: readonly ChannelSummary[],
) {
  const channel = channelForLink(url, channels);
  const parsed = parseBuzzLink(url);
  const target = parsed?.format === "legacy" ? parsed : undefined;
  return channel
    ? `${channel.channelType === "dm" || target?.messageId ? "" : "#"}${channel.name}`
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
  channelId,
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
  channelId?: string | undefined;
  interactive?: boolean;
}) {
  const resolveName = useChannelIdentityNames(session, channelId);
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
    const label =
      reference.kind === "channel"
        ? reference.label.slice(1)
        : resolveName(reference.id, reference.label.slice(1));
    const Icon = reference.kind === "agent" ? RobotIcon : AtIcon;
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
          channelPrivate={!!reference.private}
        />
      ) : (
        <span
          key={reference.start}
          className={styles.link}
          data-mention-kind={reference.kind}
          title={`${reference.kind === "agent" ? "Agent" : "Person"}: ${label}\n${reference.id}`}
        >
          <Icon aria-hidden="true" className={styles.icon} />
          {label}
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
