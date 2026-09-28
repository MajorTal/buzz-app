import { npubEncode } from "nostr-tools/nip19";

/** Private, community-scoped recipes. Never an OG channel-sections writer. */
export const KIT_TAG = "buzz-channel-kit-v1";
export const KIT_RECORD_BYTES = 16 * 1024;
export const CANVAS_BYTES = 24 * 1024;
export type Lineup = { teamIds: string[]; agents: string[]; canvas: string };
export type Team = { type: "team"; id: string; name: string; agents: string[] };
export type Template = Lineup & {
  type: "template";
  id: string;
  name: string;
  description: string;
};
export type Group = { id: string; name: string; defaultTemplateId: string };
export type Groups = {
  type: "groups";
  id: "personal";
  groups: Group[];
  assignments: Record<string, string>;
};
export type KitValue = Team | Template | Groups;
export type KitRecord = {
  version: 1;
  community: string;
  deleted: boolean;
  value: KitValue;
};
export type KitEntry = {
  record: KitRecord;
  eventId: string;
  createdAt: number;
};
export type AgentChoice = {
  pubkey: string;
  name: string;
  avatar?: string | undefined;
};
export const emptyLineup = (): Lineup => ({
  teamIds: [],
  agents: [],
  canvas: "",
});
const keyPattern = /^[0-9a-f]{64}$/;
const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid channel recipe");
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, nonempty = false): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (nonempty && !value.trim())
  )
    throw new Error("Invalid channel recipe text");
  return value;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !idPattern.test(value))
    throw new Error("Invalid channel recipe ID");
  return value;
}
function keys(value: unknown, pattern: RegExp, max: number): string[] {
  if (
    !Array.isArray(value) ||
    value.length > max ||
    value.some((v) => typeof v !== "string" || !pattern.test(v)) ||
    new Set(value).size !== value.length
  )
    throw new Error("Invalid channel recipe selection");
  return [...value] as string[];
}
export function parseLineup(raw: unknown): Lineup {
  const v = object(raw);
  const canvas = text(v.canvas, CANVAS_BYTES);
  if (new TextEncoder().encode(canvas).length > CANVAS_BYTES)
    throw new Error("Canvas is too large (24 KiB maximum)");
  return {
    teamIds: keys(v.teamIds, idPattern, 100),
    agents: keys(v.agents, keyPattern, 200),
    canvas,
  };
}
export function parseKitRecord(raw: unknown, community: string): KitRecord {
  const r = object(raw),
    v = object(r.value);
  if (
    r.version !== 1 ||
    r.community !== community ||
    typeof r.deleted !== "boolean"
  )
    throw new Error("Unsupported recipe or wrong community");
  let value: KitValue;
  if (v.type === "team")
    value = {
      type: "team",
      id: id(v.id),
      name: text(v.name, 120, true),
      agents: keys(v.agents, keyPattern, 200),
    };
  else if (v.type === "template")
    value = {
      type: "template",
      id: id(v.id),
      name: text(v.name, 120, true),
      description: text(v.description, 1000),
      ...parseLineup(v),
    };
  else if (v.type === "groups" && v.id === "personal") {
    if (!Array.isArray(v.groups) || v.groups.length > 100)
      throw new Error("Too many personal groups");
    const groups = v.groups.map((raw) => {
      const g = object(raw);
      return {
        id: id(g.id),
        name: text(g.name, 120, true),
        defaultTemplateId:
          g.defaultTemplateId === "" ? "" : id(g.defaultTemplateId),
      };
    });
    if (new Set(groups.map((g) => g.id)).size !== groups.length)
      throw new Error("Duplicate personal group");
    const assignments = Object.entries(object(v.assignments));
    if (
      assignments.length > 1000 ||
      assignments.some(
        ([channel, group]) =>
          !/^[0-9a-f-]{36}$/.test(channel) ||
          !groups.some((g) => g.id === group),
      )
    )
      throw new Error("Invalid personal group placement");
    value = {
      type: "groups",
      id: "personal",
      groups,
      assignments: Object.fromEntries(assignments) as Record<string, string>,
    };
  } else throw new Error("Unsupported channel recipe type");
  const result: KitRecord = {
    version: 1,
    community,
    deleted: r.deleted,
    value,
  };
  if (
    new TextEncoder().encode(JSON.stringify(result)).length > KIT_RECORD_BYTES
  )
    throw new Error(
      "This saved recipe exceeds 16 KiB; shorten its Canvas or selections",
    );
  return result;
}
export function coordinate(record: KitRecord) {
  return `${KIT_TAG}:${encodeURIComponent(record.community)}:${record.value.type}:${record.value.id}`;
}
export function resolveLineup(
  lineup: Lineup,
  entries: readonly KitEntry[],
  agents: readonly AgentChoice[],
) {
  const selected = new Set(lineup.agents);
  for (const teamId of lineup.teamIds) {
    const entry = entries.find(
      (e) => e.record.value.type === "team" && e.record.value.id === teamId,
    );
    if (!entry || entry.record.deleted || entry.record.value.type !== "team")
      throw new Error(
        `A selected team is unavailable (${teamId}); remove or replace it`,
      );
    entry.record.value.agents.forEach((key) => {
      selected.add(key);
    });
  }
  if (selected.size > 200)
    throw new Error("Choose at most 200 distinct agents");
  const available = new Map(agents.map((a) => [a.pubkey, a]));
  return [...selected].map((pubkey) => {
    const agent = available.get(pubkey);
    if (!agent)
      throw new Error(
        `Agent ${npubEncode(pubkey)} is unavailable in this community; remove or replace it`,
      );
    return agent;
  });
}
