import type { RelaySession } from "../relay/session";
import type { MentionRecipient } from "./mention-draft";
import { availableMentionAgents } from "../agents/mention-choices";
import { knownAgentPubkeys } from "../agents/known";

/**
 * Base Buzz discovery rule: known-archived identities leave forward-looking
 * choices, fail-open while archive state is unknown, and never hide the viewer
 * from themself (NIP-IA archival stays visible to its subject).
 */
export function archivedMention(session: RelaySession, pubkey: string) {
  return (
    pubkey !== session.viewer && session.archives?.state(pubkey) === "archived"
  );
}

/** Recipient eligibility, shared by menus, draft naming and insertion. No reads or writes. */
export function mentionCandidates(
  session: RelaySession,
  channelId: string,
  inviteAgents = false,
  roster?: readonly MentionRecipient[],
  directory: readonly (MentionRecipient & { isAgent?: true })[] = [],
) {
  const channel = session.channels
    .list()
    .channels.find((c) => c.id === channelId);
  const members = roster?.map((p) => p.pubkey) ?? channel?.members ?? [];
  const memberKeys = new Set(members);
  const agents = session.agentChoices.snapshot().identities;
  const profiles = session.profiles.snapshot();
  const known = knownAgentPubkeys(profiles, {
    definitions: [],
    identities: agents,
  });
  const choices = new Map<string, MentionRecipient>();
  if (!channel?.archived && !channel?.readOnly) {
    for (const person of roster ??
      (inviteAgents && channel?.channelType !== "dm"
        ? agents
        : availableMentionAgents(
            channel,
            agents,
            false,
            session.outbox?.supports(9000),
          )))
      choices.set(person.pubkey, { pubkey: person.pubkey, name: person.name });
    if (
      !roster &&
      !inviteAgents &&
      (channel?.channelType === "stream" || channel?.channelType === "forum")
    )
      for (const person of directory) choices.set(person.pubkey, person);
    for (const pubkey of members)
      choices.set(pubkey, {
        pubkey,
        name:
          profiles.get(pubkey)?.name ||
          choices.get(pubkey)?.name ||
          pubkey.slice(0, 12),
      });
  }
  return [...choices.values()]
    .filter(
      (p) =>
        /^[0-9a-f]{64}$/.test(p.pubkey) && !archivedMention(session, p.pubkey),
    )
    .map((recipient) => ({
      recipient,
      member: memberKeys.has(recipient.pubkey),
      agent:
        known.has(recipient.pubkey) ||
        directory.some((p) => p.pubkey === recipient.pubkey && p.isAgent),
      owned:
        !!session.viewer &&
        profiles.get(recipient.pubkey)?.ownerPubkey === session.viewer,
      managed: agents.some((a) => a.pubkey === recipient.pubkey && a.managed),
      aliases: [
        ...new Set(
          [
            profiles.get(recipient.pubkey)?.name ||
              directory.find((person) => person.pubkey === recipient.pubkey)
                ?.name ||
              roster?.find((person) => person.pubkey === recipient.pubkey)
                ?.name,
            ...agents
              .filter((a) => a.pubkey === recipient.pubkey)
              .map((a) => a.name),
          ].filter((name): name is string => !!name),
        ),
      ],
    }));
}

/** Session lifetime isolates community/viewer; bounded per-destination explicit choices. */
const histories = new WeakMap<RelaySession, Map<string, Map<string, number>>>();
export function mentionHistory(session: RelaySession, channelId: string) {
  return histories.get(session)?.get(channelId);
}
export function rememberMention(
  session: RelaySession,
  channelId: string,
  pubkey: string,
) {
  let destinations = histories.get(session);
  if (!destinations) {
    destinations = new Map();
    histories.set(session, destinations);
  }
  let history = destinations.get(channelId);
  if (!history) {
    history = new Map();
    destinations.set(channelId, history);
  }
  const next = Math.max(0, ...history.values()) + 1;
  history.delete(pubkey);
  history.set(pubkey, next);
  if (history.size > 100) history.delete(history.keys().next().value ?? "");
  if (destinations.size > 100)
    destinations.delete(destinations.keys().next().value ?? "");
}
