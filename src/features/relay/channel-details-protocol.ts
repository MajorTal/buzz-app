import type { EventTemplate } from "nostr-tools";
import { sessionMetadata } from "../sessions/metadata.ts";
import type { RelayEvent } from "./events.ts";
import {
  exactLifecycleTag,
  lifecycleChannelId,
  lifecycleRecord,
  lifecycleSettings,
} from "./channel-lifecycle-protocol.ts";

export type ChannelDetailsDraft = Readonly<{
  name: string;
  description: string;
  visibility: "public" | "private";
  /** Absent means ongoing; retain existing custom temporary intervals. */
  ttlSeconds?: number | undefined;
}>;
export type ChannelDetails = ChannelDetailsDraft &
  Readonly<{
    channelId: string;
    version: string;
    canEdit: boolean;
  }>;

/** Missing or contradictory flags are unknown, never implicitly public. */
export function channelVisibility(
  event: RelayEvent,
): "public" | "private" | undefined {
  const flags = event.tags.filter(
    ([key]) => key === "public" || key === "private",
  );
  const flag = flags[0];
  return flags.length === 1 && flag?.length === 1
    ? (flag[0] as "public" | "private")
    : undefined;
}

/** Match buzz-core canonical_channel_name: Rust char::is_whitespace uses
 * Unicode White_Space (unlike JS trim, which omits U+0085 and includes U+FEFF). */
export function canonicalDetailsName(name: string): string {
  return name.replace(/^[#\p{White_Space}]+|\p{White_Space}+$/gu, "");
}

/** Shared field feedback; the command validator remains the write boundary. */
export function detailsDraftErrors(draft: ChannelDetailsDraft) {
  return {
    name:
      !draft ||
      typeof draft.name !== "string" ||
      !draft.name ||
      draft.name !== canonicalDetailsName(draft.name) ||
      [...draft.name].length > 120
        ? "Enter a channel name of 1–120 characters without a leading #."
        : undefined,
    description:
      !draft ||
      typeof draft.description !== "string" ||
      [...draft.description].length > 1000
        ? "Use a description of at most 1,000 characters."
        : draft.description.includes("Buzz session (")
          ? 'Remove "Buzz session (" from the description; that text is used by Buzz for work sessions.'
          : undefined,
    lifetime:
      draft?.ttlSeconds !== undefined &&
      (!Number.isInteger(draft.ttlSeconds) ||
        draft.ttlSeconds <= 0 ||
        draft.ttlSeconds > 2_147_483_647)
        ? "Channel duration could not be verified."
        : undefined,
    visibility:
      !draft ||
      (draft.visibility !== "public" && draft.visibility !== "private")
        ? "Channel visibility could not be verified."
        : undefined,
  };
}

export function validateDetailsDraft(draft: ChannelDetailsDraft): void {
  const errors = detailsDraftErrors(draft);
  const error =
    errors.name ?? errors.description ?? errors.visibility ?? errors.lifetime;
  if (error) throw new Error(error);
}

export function detailsSettings(
  events: readonly RelayEvent[],
  id: string,
  viewer: string,
  relayAuthor: string,
) {
  const metadata = lifecycleRecord(events, 39000, id, relayAuthor);
  if (!metadata)
    throw new Error("Current channel details could not be verified.");
  // Reuse exact roster/admin validation, not cached roster roles or local key custody.
  const authority = lifecycleSettings(events, id, viewer, relayAuthor);
  const admins = lifecycleRecord(events, 39001, id, relayAuthor);
  const role = admins?.tags.find(
    ([key, value]) => key === "p" && value === viewer,
  )?.[2];
  const visibility = channelVisibility(metadata);
  const name = exactLifecycleTag(metadata, "name");
  const description = exactLifecycleTag(metadata, "about") ?? "";
  const ttl = exactLifecycleTag(metadata, "ttl");
  const ttlSeconds = parseDetailsTtl(ttl);
  if (!name || !visibility)
    throw new Error("Current channel details could not be verified.");
  const details: ChannelDetails = Object.freeze({
    channelId: id,
    version: metadata.id,
    name,
    description,
    visibility,
    ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
    canEdit:
      authority.channelType !== "dm" &&
      exactLifecycleTag(metadata, "archived") !== "true" &&
      sessionMetadata(description) === undefined &&
      (role === "owner" || role === "admin"),
  });
  return { details, metadata };
}

export function detailsTemplate(
  id: string,
  draft: ChannelDetailsDraft,
  base: ChannelDetailsDraft,
): EventTemplate {
  validateDetailsDraft(draft);
  return {
    kind: 9002,
    created_at: Math.floor(Date.now() / 1000),
    content: "",
    tags: [
      ["h", lifecycleChannelId(id)],
      ["name", draft.name],
      ["about", draft.description],
      // Omission preserves current visibility, including in the remaining read/write race.
      ...(draft.visibility !== base.visibility
        ? [["visibility", draft.visibility === "private" ? "private" : "open"]]
        : []),
      // Re-sending an unchanged TTL resets the relay's cleanup deadline.
      ...(draft.ttlSeconds !== base.ttlSeconds
        ? [
            [
              "ttl",
              draft.ttlSeconds === undefined ? "" : String(draft.ttlSeconds),
            ],
          ]
        : []),
    ],
  };
}

/** A relay metadata TTL must be an unambiguous positive i32; only absence is ongoing. */
function parseDetailsTtl(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value) || Number(value) > 2_147_483_647)
    throw new Error("Channel duration could not be verified.");
  return Number(value);
}

/** Separate from lifecycle and outbox admission. Admits only explicit open/private visibility. */
export function validateDetailsTemplate(event: EventTemplate): void {
  if (
    event?.kind !== 9002 ||
    event.content !== "" ||
    !Number.isSafeInteger(event.created_at) ||
    event.created_at < 0 ||
    !Array.isArray(event.tags) ||
    ![3, 4, 5].includes(event.tags.length) ||
    !event.tags.every(
      (tag) =>
        Array.isArray(tag) &&
        tag.length === 2 &&
        tag.every((value) => typeof value === "string"),
    ) ||
    !["h", "name", "about"].every(
      (key, index) => event.tags[index]?.[0] === key,
    ) ||
    ![[], ["visibility"], ["ttl"], ["visibility", "ttl"]].some(
      (keys) =>
        keys.length === event.tags.length - 3 &&
        keys.every((key, index) => event.tags[index + 3]?.[0] === key),
    )
  )
    throw new Error("Invalid channel details command.");
  const visibility = event.tags.find(([key]) => key === "visibility");
  if (visibility && !["private", "open"].includes(visibility[1] ?? ""))
    throw new Error("Invalid channel details command.");
  const ttl = event.tags.find(([key]) => key === "ttl")?.[1];
  lifecycleChannelId(event.tags[0]?.[1] ?? "");
  validateDetailsDraft({
    name: event.tags[1]?.[1] ?? "",
    description: event.tags[2]?.[1] ?? "",
    visibility: visibility?.[1] === "private" ? "private" : "public",
    ttlSeconds: ttl === "" ? undefined : parseDetailsTtl(ttl),
  });
}
