import { invoke } from "@tauri-apps/api/core";
import { eventDto, type RelayEvent } from "./events";
import {
  projectSidebarPreferences,
  type SidebarAssignmentIntent,
  type SidebarGroups,
  type SidebarSortMode,
} from "./sidebar-preferences";
import type { ReadTransport } from "./transport";

const coordinates = [
  "channel-sections",
  "channel-stars",
  "channel-mutes",
  "channel-sort",
] as const;
type Coordinate = (typeof coordinates)[number];
type Head = { payload: Record<string, unknown>; createdAt: number };
const empty = (coordinate: Coordinate): Record<string, unknown> =>
  coordinate === "channel-sections"
    ? { version: 1, sections: [], assignments: {} }
    : coordinate === "channel-sort"
      ? { version: 1, groups: {} }
      : { version: 1, channels: {} };
const cancelled = (signal: AbortSignal) => signal.throwIfAborted();
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

export function nativeSidebar(transport: ReadTransport) {
  const viewer = transport.viewer;
  const writer = transport.writer;
  // Session store serializes its writers. A separate session or device can still race
  // this whole-record read/replace; readback verifies the requested intent only.
  async function decode(events: readonly RelayEvent[], signal: AbortSignal) {
    cancelled(signal);
    const raw = await invoke<Record<string, unknown>>("relay_decode_sidebar", {
      events,
    });
    cancelled(signal);
    return projectSidebarPreferences(
      raw["channel-sections"],
      raw["channel-stars"],
      raw["channel-mutes"],
      raw["channel-sort"],
    );
  }
  async function head(
    coordinate: Coordinate,
    signal: AbortSignal,
  ): Promise<Head> {
    cancelled(signal);
    const events = await transport.query(
      [
        {
          kinds: [30078],
          authors: [viewer],
          "#d": [coordinate],
          limit: 1,
          consistency: "strong",
        },
      ],
      signal,
    );
    cancelled(signal);
    if (!events.length) return { payload: empty(coordinate), createdAt: 0 };
    const raw = await invoke<Record<string, unknown>>("relay_decode_sidebar", {
      events,
    });
    cancelled(signal);
    const payload = raw[coordinate];
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new Error("Invalid sidebar record");
    // The Rust decoder checks signature, author, coordinate and plaintext budget.
    const value = payload as Record<string, unknown>;
    project(coordinate, value);
    return { payload: value, createdAt: events[0]?.created_at ?? 0 };
  }
  function project(
    coordinate: Coordinate,
    value: unknown,
    sectionIds?: readonly string[],
  ) {
    return projectSidebarPreferences(
      coordinate === "channel-sections" ? value : undefined,
      coordinate === "channel-stars" ? value : undefined,
      coordinate === "channel-mutes" ? value : undefined,
      coordinate === "channel-sort" ? value : undefined,
      sectionIds,
    );
  }
  async function mutate<T>(
    coordinate: Coordinate,
    signal: AbortSignal,
    prepare: (current: Record<string, unknown>) => {
      next: Record<string, unknown>;
      result: T;
    },
    confirms: (current: Record<string, unknown>) => boolean,
    conflict: string,
  ): Promise<T> {
    const current = await head(coordinate, signal);
    const draft = prepare(current.payload);
    if (same(current.payload, draft.next)) return draft.result;
    // Reject unsupported/over-budget writes at the existing projection boundary.
    project(coordinate, draft.next);
    if (
      new TextEncoder().encode(JSON.stringify(draft.next)).length >
      128 * 1024
    )
      throw new Error("Sidebar plaintext budget exceeded");
    const event = eventDto(
      await invoke<unknown>("relay_sign_sidebar", {
        coordinate,
        payload: draft.next,
        createdAt: Math.max(
          Math.floor(Date.now() / 1000),
          current.createdAt + 1,
        ),
      }),
    );
    cancelled(signal);
    if (!writer) throw new Error("Native relay writer is unavailable");
    await writer.publish(event, signal);
    const confirmed = await head(coordinate, signal);
    if (!confirms(confirmed.payload)) throw new Error(conflict);
    return prepare(confirmed.payload).result;
  }
  return {
    decodeSidebarPreferences: decode,
    async writeSidebarAssignment(
      intent: SidebarAssignmentIntent,
      signal: AbortSignal,
    ): Promise<SidebarGroups> {
      const { channelId, sectionId, createSection } = intent;
      if (
        !channelId.trim() ||
        channelId.length > 256 ||
        (sectionId !== undefined &&
          (!sectionId.trim() || sectionId.length > 256)) ||
        (createSection &&
          (sectionId !== undefined ||
            !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(
              createSection.id,
            ) ||
            !createSection.name.trim() ||
            createSection.name.length > 256))
      )
        throw new Error("Invalid sidebar assignment intent");
      const section = createSection?.id ?? sectionId;
      const prepare = (current: Record<string, unknown>) => {
        const existing = current.sections as SidebarGroups["sections"];
        const sections = [...existing];
        if (createSection) {
          const name = createSection.name.trim();
          const found = sections.find((entry) => entry.id === section);
          if (found && found.name !== name)
            throw new Error("The new section changed; reload and try again");
          if (!found)
            sections.push({
              id: createSection.id,
              name,
              order: Math.max(-1, ...sections.map((entry) => entry.order)) + 1,
            });
        }
        if (
          section !== undefined &&
          !sections.some((entry) => entry.id === section)
        )
          throw new Error("Sidebar group no longer exists");
        const assignments = {
          ...(current.assignments as Record<string, string>),
        };
        if (section === undefined) delete assignments[channelId];
        else assignments[channelId] = section;
        const next = { ...current, sections, assignments };
        const { sections: projected, assignments: mapped } = project(
          "channel-sections",
          next,
        );
        return { next, result: { sections: projected, assignments: mapped } };
      };
      return mutate(
        "channel-sections",
        signal,
        prepare,
        (value) => {
          const assigned = value.assignments as Record<string, string>;
          return (
            assigned[channelId] === section &&
            (!createSection ||
              (value.sections as SidebarGroups["sections"]).some(
                (entry) =>
                  entry.id === section &&
                  entry.name === createSection.name.trim(),
              ))
          );
        },
        "Sidebar groups changed on another device; reload and try again",
      );
    },
    async writeSidebarStar(
      intent: { channelId: string; starred: boolean },
      signal: AbortSignal,
    ) {
      return writeToggle(
        "channel-stars",
        "starred",
        intent,
        signal,
        "Sidebar stars changed on another device; reload and try again",
      );
    },
    async writeSidebarMute(
      intent: { channelId: string; muted: boolean },
      signal: AbortSignal,
    ) {
      return writeToggle(
        "channel-mutes",
        "muted",
        intent,
        signal,
        "Sidebar mutes changed on another device; reload and try again",
      );
    },
    async writeSidebarSort(
      group: string,
      mode: SidebarSortMode,
      sectionIds: readonly string[],
      signal: AbortSignal,
    ) {
      if (
        group.length > 264 ||
        !["alpha", "recent"].includes(mode) ||
        sectionIds.length > 100 ||
        sectionIds.some((id) => !id.trim() || id.length > 256) ||
        (!["starred", "channels", "forums", "dms"].includes(group) &&
          !(
            group.startsWith("section:") && sectionIds.includes(group.slice(8))
          ))
      )
        throw new Error("Invalid sidebar sort intent");
      const prepare = (current: Record<string, unknown>) => {
        const groups = {
          ...(current.groups as Record<string, SidebarSortMode>),
        };
        if (mode === "alpha") delete groups[group];
        else groups[group] = mode;
        const next = { ...current, groups };
        return {
          next,
          result: project("channel-sort", next, sectionIds).sort ?? {},
        };
      };
      return mutate(
        "channel-sort",
        signal,
        prepare,
        (value) =>
          ((value.groups as Record<string, string>)[group] ?? "alpha") === mode,
        "Sidebar sort changed on another device; reload and try again",
      );
    },
  };
  async function writeToggle(
    coordinate: "channel-stars" | "channel-mutes",
    field: "starred" | "muted",
    intent: { channelId: string; starred?: boolean; muted?: boolean },
    signal: AbortSignal,
    conflict: string,
  ) {
    const { channelId } = intent;
    const enabled = intent[field];
    if (
      !channelId.trim() ||
      channelId.length > 256 ||
      typeof enabled !== "boolean"
    )
      throw new Error(
        `Invalid sidebar ${field === "starred" ? "star" : "mute"} intent`,
      );
    const prepare = (current: Record<string, unknown>) => {
      const channels = current.channels as Record<
        string,
        Record<string, unknown>
      >;
      const previous = Object.hasOwn(channels, channelId)
        ? channels[channelId]
        : undefined;
      if (
        previous?.[field] === enabled ||
        (!previous && !enabled && field === "starred")
      )
        return {
          next: current,
          result: project(coordinate, current)[
            field === "starred" ? "starred" : "muted"
          ],
        };
      const now = Date.now();
      const next = {
        ...current,
        channels: {
          ...channels,
          [channelId]: {
            ...previous,
            [field]: enabled,
            updatedAt: Math.max(now, Number(previous?.updatedAt ?? 0) + 1),
          },
        },
      };
      return {
        next,
        result: project(coordinate, next)[
          field === "starred" ? "starred" : "muted"
        ],
      };
    };
    return mutate(
      coordinate,
      signal,
      prepare,
      (value) => {
        const entry = (
          value.channels as Record<string, Record<string, unknown>>
        )[channelId];
        // An unmute must leave its explicit tombstone, not disappear on readback.
        return (
          entry?.[field] === enabled ||
          (field === "starred" && !enabled && entry === undefined)
        );
      },
      conflict,
    );
  }
}
