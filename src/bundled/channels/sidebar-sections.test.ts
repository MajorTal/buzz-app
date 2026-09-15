import { expect, it } from "vitest";
import type { ChannelSummary } from "../../features/relay/contracts";
import { sidebarSections } from "./sidebar-sections";

const row = (
  id: string,
  extra: Partial<ChannelSummary> = {},
): ChannelSummary => ({ id, name: id, ...extra });
it("intersects groups/stars with active authorized streams, keeping forums and DMs separate", () => {
  const roster = [
    row("star"),
    row("work"),
    row("other"),
    row("archived", { archived: true }),
    row("hidden", { hidden: true }),
    row("dm", { channelType: "dm", hidden: true }),
    row("group-dm", { channelType: "dm", participants: ["a", "b"] }),
    row("forum", { channelType: "forum" }),
    row("session", { channelType: "session" }),
  ];
  const preferences = {
    sections: [{ id: "channels", name: "Channels", order: 0 }],
    assignments: {
      star: "channels",
      work: "channels",
      revoked: "channels",
      "group-dm": "channels",
      other: "missing",
    },
    starred: [
      "star",
      "archived",
      "hidden",
      "revoked",
      "dm",
      "forum",
      "session",
    ],
  };
  const project = (channels: readonly ChannelSummary[]) =>
    sidebarSections(channels, preferences).map((section) => [
      section.key,
      section.rows.map((channel) => channel.id),
    ]);
  expect(project(roster)).toEqual([
    ["starred", ["star"]],
    ["group:channels", ["work"]],
    ["channels", ["other"]],
    ["forums", ["forum"]],
    ["dms", ["dm", "group-dm"]],
  ]);
  expect(
    project(roster.filter((channel) => channel.id !== "star")),
  ).not.toContainEqual(["starred", ["star"]]);
  expect(
    sidebarSections(roster).flatMap((section) =>
      section.rows.map((channel) => channel.id),
    ),
  ).toEqual(["star", "work", "other", "forum", "dm", "group-dm"]);
});
