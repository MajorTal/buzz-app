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
    muted: [],
    starred: ["star", "archived", "hidden", "revoked", "dm", "forum"],
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
it("Star placement is exclusive and Unstar restores the saved assignment", () => {
  const channels = [row("alpha"), row("beta")];
  const saved = {
    sections: [{ id: "work", name: "Work", order: 0 }],
    assignments: { beta: "work" },
    muted: [],
    starred: ["alpha", "beta"],
  };
  const placements = (starred: string[]) =>
    sidebarSections(channels, { ...saved, starred }).map((section) => [
      section.key,
      section.rows.map((channel) => channel.id),
    ]);
  expect(placements(saved.starred)).toEqual([["starred", ["alpha", "beta"]]]);
  expect(placements(["alpha"])).toEqual([
    ["starred", ["alpha"]],
    ["group:work", ["beta"]],
  ]);
  expect(saved.assignments).toEqual({ beta: "work" });
});
