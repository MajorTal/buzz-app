import type { ChannelSummary } from "../../features/relay/contracts";
import type { SidebarPreferences } from "../../features/relay/sidebar-preferences";

/** Preferences only arrange the supplied authorized roster; they never add channels. */
export function sidebarSections(
  channels: readonly ChannelSummary[],
  preferences?: SidebarPreferences,
) {
  const active = channels.filter(
    (channel) =>
      !channel.archived &&
      channel.channelType !== "session" &&
      (!channel.hidden || channel.channelType === "dm"),
  );
  const streams = active.filter(
    (channel) =>
      channel.channelType !== "dm" && channel.channelType !== "forum",
  );
  const stars = new Set(preferences?.starred);
  const groups = preferences?.sections ?? [];
  const ids = new Set(groups.map((group) => group.id));
  const assignment = (id: string) => preferences?.assignments[id];
  return [
    {
      key: "starred",
      title: "Starred",
      icon: "★",
      rows: streams.filter((channel) => stars.has(channel.id)),
    },
    ...groups.map((group) => ({
      key: `group:${group.id}`,
      title: group.name,
      icon: group.icon,
      rows: streams.filter(
        (channel) =>
          !stars.has(channel.id) && assignment(channel.id) === group.id,
      ),
    })),
    {
      key: "channels",
      title: "Channels",
      icon: undefined,
      rows: streams.filter(
        (channel) =>
          !stars.has(channel.id) && !ids.has(assignment(channel.id) ?? ""),
      ),
    },
    {
      key: "forums",
      title: "Forums",
      icon: undefined,
      rows: active.filter((channel) => channel.channelType === "forum"),
    },
    {
      key: "dms",
      title: "DMs",
      icon: undefined,
      rows: active.filter((channel) => channel.channelType === "dm"),
    },
  ].filter((section) => section.rows.length);
}
