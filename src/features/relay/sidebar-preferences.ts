import type { RelayEvent } from "./events.ts";
import type { RelayReader } from "./reader.ts";

export const SIDEBAR_COORDINATES = [
  "channel-sections",
  "channel-stars",
  "channel-mutes",
] as const;
export type SidebarGroups = Readonly<{
  sections: readonly Readonly<{
    id: string;
    name: string;
    icon?: string;
    order: number;
  }>[];
  assignments: Readonly<Record<string, string>>;
}>;
export type SidebarPreferences = SidebarGroups &
  Readonly<{
    starred: readonly string[];
    muted: readonly string[];
  }>;
export type SidebarAssignmentIntent = Readonly<{
  channelId: string;
  sectionId?: string;
}>;
export type SidebarAssignmentMutator = (
  intent: SidebarAssignmentIntent,
  signal: AbortSignal,
) => Promise<SidebarGroups>;
export type SidebarStarMutator = (
  intent: Readonly<{ channelId: string; starred: boolean }>,
  signal: AbortSignal,
) => Promise<readonly string[]>;
export type SidebarMuteMutator = (
  intent: Readonly<{ channelId: string; muted: boolean }>,
  signal: AbortSignal,
) => Promise<readonly string[]>;
export type SidebarDecoder = (
  events: readonly RelayEvent[],
  signal: AbortSignal,
) => Promise<SidebarPreferences>;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid sidebar preferences");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error("Invalid sidebar preference text");
  return value;
}
/** Read-only legacy projection. Never merge, migrate, or publish account preferences. */
export function projectSidebarPreferences(
  sections: unknown,
  stars: unknown,
  mutes?: unknown,
): SidebarPreferences {
  const result: {
    sections: { id: string; name: string; icon?: string; order: number }[];
    assignments: Record<string, string>;
    starred: string[];
    muted: string[];
  } = {
    sections: [],
    assignments: {},
    starred: [],
    muted: [],
  };
  if (sections !== undefined) {
    const data = object(sections);
    if (
      data.version !== 1 ||
      !Array.isArray(data.sections) ||
      data.sections.length > 100
    )
      throw new Error("Unsupported sidebar groups");
    const ids = new Set<string>();
    result.sections = data.sections
      .map((raw) => {
        const entry = object(raw);
        const id = text(entry.id);
        if (
          ids.has(id) ||
          typeof entry.order !== "number" ||
          !Number.isFinite(entry.order)
        )
          throw new Error("Invalid sidebar group order");
        ids.add(id);
        return {
          id,
          name: text(entry.name),
          order: entry.order,
          ...(entry.icon === undefined ? {} : { icon: text(entry.icon, 128) }),
        };
      })
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const assignments = Object.entries(object(data.assignments));
    if (assignments.length > 1000)
      throw new Error("Sidebar assignment budget exceeded");
    result.assignments = Object.fromEntries(
      assignments
        .map(([id, section]) => [text(id), text(section)])
        .filter(([, section]) => ids.has(section as string)),
    );
  }
  if (stars !== undefined) {
    const data = object(stars);
    if (data.version !== 1) throw new Error("Unsupported sidebar stars");
    const entries = Object.entries(object(data.channels));
    if (entries.length > 500) throw new Error("Sidebar star budget exceeded");
    for (const [id, raw] of entries) {
      text(id);
      const entry = object(raw);
      if (
        typeof entry.starred !== "boolean" ||
        typeof entry.updatedAt !== "number" ||
        !Number.isFinite(entry.updatedAt) ||
        entry.updatedAt < 0
      )
        throw new Error("Invalid sidebar star");
      if (entry.starred) result.starred.push(id);
    }
  }
  if (mutes !== undefined) {
    const data = object(mutes);
    if (data.version !== 1) throw new Error("Unsupported channel mutes");
    const entries = Object.entries(object(data.channels));
    if (entries.length > 500) throw new Error("Channel mute budget exceeded");
    for (const [id, raw] of entries) {
      text(id);
      const entry = object(raw);
      if (
        typeof entry.muted !== "boolean" ||
        typeof entry.updatedAt !== "number" ||
        !Number.isFinite(entry.updatedAt) ||
        entry.updatedAt < 0
      )
        throw new Error("Invalid channel mute");
      if (entry.muted) result.muted.push(id);
    }
  }
  return result;
}

export async function readSidebarPreferences(
  reader: RelayReader,
  viewer: string,
  decode: SidebarDecoder,
  signal: AbortSignal,
): Promise<SidebarPreferences> {
  let events: readonly RelayEvent[];
  try {
    events = await reader.read(
      SIDEBAR_COORDINATES.map((coordinate) => ({
        kinds: [30078],
        authors: [viewer],
        "#d": [coordinate],
        limit: 1,
      })),
      // One user-visible groups/stars read must not wait behind bulk profile enrichment.
      { signal, priority: "foreground" },
    );
    signal.throwIfAborted();
  } catch (error) {
    const cause = signal.aborted ? signal.reason : error;
    if (cause instanceof Error && cause.name === "AbortError") throw cause;
    throw new Error(
      `Preference query: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  try {
    const result = await decode(events, signal);
    signal.throwIfAborted();
    return result;
  } catch (error) {
    const cause = signal.aborted ? signal.reason : error;
    if (cause instanceof Error && cause.name === "AbortError") throw cause;
    throw new Error(
      `Preference decode: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}
