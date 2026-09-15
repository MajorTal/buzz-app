import type { ChannelSummary, Profile } from "../relay/contracts";
import type { AgentLibrary } from "../agents/library";

export type MessageReference = {
  start: number;
  end: number;
  label: string;
  kind: "channel" | "person" | "agent";
  id: string;
};

/** Names are display evidence only. People must also have an explicit signed mention. */
export function messageReferences(
  text: string,
  mentions: readonly string[],
  profiles: ReadonlyMap<string, Profile>,
  channels: readonly ChannelSummary[],
  agents: AgentLibrary["identities"],
): MessageReference[] {
  const candidates = [
    ...channels
      .filter((channel) => !channel.archived)
      .map((channel) => ({
        label: `#${channel.name}`,
        kind: "channel" as const,
        id: channel.id,
      })),
    ...mentions.flatMap((id) => {
      const agent = agents.find((entry) => entry.pubkey === id);
      const name = profiles.get(id)?.name ?? agent?.name;
      return name
        ? [
            {
              label: `@${name}`,
              id,
              kind: agent ? ("agent" as const) : ("person" as const),
            },
          ]
        : [];
    }),
  ];
  const unique = candidates
    .filter((candidate) => text.includes(candidate.label))
    .filter(
      (candidate) =>
        !candidates.some(
          (other) =>
            other.label === candidate.label && other.id !== candidate.id,
        ),
    )
    .sort((a, b) => b.label.length - a.label.length);
  const result: MessageReference[] = [];
  for (const candidate of unique) {
    let from = 0;
    while (from < text.length) {
      const start = text.indexOf(candidate.label, from);
      if (start < 0) break;
      const end = start + candidate.label.length;
      from = end;
      if (
        (start > 0 && !/[\s([{]/u.test(text[start - 1] ?? "")) ||
        (end < text.length && !/[\s.,!?;:)\]}]/u.test(text[end] ?? "")) ||
        result.some((entry) => start < entry.end && end > entry.start)
      )
        continue;
      result.push({ ...candidate, start, end });
    }
  }
  return result.sort((a, b) => a.start - b.start);
}
