import type { AgentLibrarySnapshot } from "../agents/library";
import type { ChannelSummary, Profile } from "../relay/contracts";

/** Classification never grants access: candidates must be in the current relay roster. */
export function sessionAgents(
  channel: ChannelSummary | undefined,
  profiles: ReadonlyMap<string, Profile>,
  library: AgentLibrarySnapshot,
  viewer: string | undefined,
): readonly string[] | undefined {
  if (!channel?.members) return;
  const known = new Set(library.identities.map((agent) => agent.pubkey));
  const members = [...new Set(channel.members)].filter((key) => key !== viewer);
  if (
    library.status !== "ready" &&
    members.some((key) => !known.has(key) && !profiles.get(key)?.isAgent)
  )
    return;
  // Missing profiles can hide a second agent; never guess a sole recipient.
  if (members.some((key) => !known.has(key) && !profiles.has(key))) return;
  return members.filter((key) => known.has(key) || profiles.get(key)?.isAgent);
}

export function sessionRecipients(
  channel: ChannelSummary | undefined,
  profiles: ReadonlyMap<string, Profile>,
  library: AgentLibrarySnapshot,
  viewer: string | undefined,
  explicit: readonly string[],
): readonly string[] {
  if (channel?.channelType !== "session" || explicit.length) return explicit;
  const agents = sessionAgents(channel, profiles, library, viewer);
  if (!agents)
    throw new Error(
      "Session participants are still loading. Retry or @mention an agent.",
    );
  if (agents.length > 1)
    throw new Error(
      "There are multiple agents in this session. @mention who should respond.",
    );
  return agents;
}
