import { finalizeEvent, getPublicKey, nip44, verifyEvent } from "nostr-tools";
import {
  projectSidebarPreferences,
  SIDEBAR_COORDINATES,
} from "../src/features/relay/sidebar-preferences.ts";

export const SIDEBAR_REQUEST_BYTES = 256 * 1024;
export const SIDEBAR_UPLOAD_SLOTS = 2;
export const SIDEBAR_UPLOAD_MS = 10_000;
/** Local host decoder, deliberately not an arbitrary NIP-44 decrypt capability. */
export function decodeSidebarPreferences(events, secret) {
  if (
    !Array.isArray(events) ||
    events.length > SIDEBAR_COORDINATES.length ||
    Buffer.byteLength(JSON.stringify(events)) > SIDEBAR_REQUEST_BYTES
  )
    throw new Error("Invalid sidebar records");
  const viewer = getPublicKey(secret);
  const coordinates = new Set();
  for (const event of events) {
    const tags = event?.tags?.filter?.(
      (tag) => Array.isArray(tag) && tag[0] === "d",
    );
    const coordinate = tags?.[0]?.[1];
    if (
      event?.kind !== 30078 ||
      event.pubkey !== viewer ||
      tags?.length !== 1 ||
      !SIDEBAR_COORDINATES.includes(coordinate) ||
      coordinates.has(coordinate) ||
      typeof event.content !== "string" ||
      !verifyEvent(event)
    )
      throw new Error("Invalid sidebar record");
    coordinates.add(coordinate);
  }
  const key = nip44.v2.utils.getConversationKey(secret, viewer);
  try {
    const decoded = new Map();
    for (const event of events) {
      const plaintext = nip44.v2.decrypt(event.content, key);
      if (Buffer.byteLength(plaintext) > 128 * 1024)
        throw new Error("Sidebar plaintext budget exceeded");
      decoded.set(
        event.tags.find((tag) => tag[0] === "d")[1],
        JSON.parse(plaintext),
      );
    }
    return projectSidebarPreferences(
      decoded.get("channel-sections"),
      decoded.get("channel-stars"),
      decoded.get("channel-mutes"),
    );
  } finally {
    key.fill(0);
  }
}

const SECTION_COORDINATE = "channel-sections";
function validAssignmentIntent(intent) {
  return (
    intent &&
    typeof intent === "object" &&
    !Array.isArray(intent) &&
    typeof intent.channelId === "string" &&
    intent.channelId.trim().length > 0 &&
    intent.channelId.length <= 256 &&
    (intent.sectionId === undefined ||
      (typeof intent.sectionId === "string" &&
        intent.sectionId.trim().length > 0 &&
        intent.sectionId.length <= 256)) &&
    Object.keys(intent).every((key) => ["channelId", "sectionId"].includes(key))
  );
}
export function assertSidebarAssignmentIntent(intent) {
  if (!validAssignmentIntent(intent))
    throw new Error("Invalid sidebar assignment intent");
}
function parseSectionsEvent(events, secret) {
  if (
    !Array.isArray(events) ||
    events.length > 1 ||
    Buffer.byteLength(JSON.stringify(events)) > SIDEBAR_REQUEST_BYTES
  )
    throw new Error("Invalid sidebar group head");
  if (!events.length)
    return {
      blob: { version: 1, sections: [], assignments: {} },
      createdAt: 0,
    };
  const [event] = events;
  const viewer = getPublicKey(secret);
  const tags = event?.tags?.filter?.(
    (tag) => Array.isArray(tag) && tag[0] === "d",
  );
  if (
    event?.kind !== 30078 ||
    event.pubkey !== viewer ||
    tags?.length !== 1 ||
    tags[0]?.[1] !== SECTION_COORDINATE ||
    typeof event.content !== "string" ||
    !verifyEvent(event)
  )
    throw new Error("Invalid sidebar group head");
  const key = nip44.v2.utils.getConversationKey(secret, viewer);
  try {
    const plaintext = nip44.v2.decrypt(event.content, key);
    if (Buffer.byteLength(plaintext) > 128 * 1024)
      throw new Error("Sidebar plaintext budget exceeded");
    const blob = JSON.parse(plaintext);
    projectSidebarPreferences(blob, undefined);
    return { blob, createdAt: event.created_at };
  } finally {
    key.fill(0);
  }
}
/** Narrow host command: mutate one assignment against the latest encrypted head. */
export function prepareSidebarAssignment(
  events,
  intent,
  secret,
  now = Date.now(),
) {
  assertSidebarAssignmentIntent(intent);
  const viewer = getPublicKey(secret);
  const current = parseSectionsEvent(events, secret);
  if (
    intent.sectionId !== undefined &&
    !current.blob.sections.some((section) => section.id === intent.sectionId)
  )
    throw new Error("Sidebar group no longer exists");
  const assignments = {
    ...current.blob.assignments,
    ...(intent.sectionId === undefined
      ? {}
      : { [intent.channelId]: intent.sectionId }),
  };
  if (intent.sectionId === undefined) delete assignments[intent.channelId];
  const blob = { ...current.blob, assignments };
  const groups = projectSidebarPreferences(blob, undefined);
  const previous = Object.hasOwn(current.blob.assignments, intent.channelId)
    ? current.blob.assignments[intent.channelId]
    : undefined;
  if (previous === intent.sectionId) return { groups };
  const key = nip44.v2.utils.getConversationKey(secret, viewer);
  let content;
  try {
    content = nip44.v2.encrypt(JSON.stringify(blob), key);
  } finally {
    key.fill(0);
  }
  return {
    groups,
    event: finalizeEvent(
      {
        kind: 30078,
        content,
        created_at: Math.max(Math.floor(now / 1000), current.createdAt + 1),
        tags: [
          ["d", SECTION_COORDINATE],
          ["t", SECTION_COORDINATE],
        ],
      },
      secret,
    ),
  };
}

/** Publish one assignment, then re-read the coordinate before reporting saved state. */
export async function mutateSidebarAssignment(
  intent,
  secret,
  readHead,
  publish,
) {
  assertSidebarAssignmentIntent(intent);
  const draft = prepareSidebarAssignment(await readHead(), intent, secret);
  if (!draft.event) return draft.groups;
  await publish(draft.event);
  const confirmation = prepareSidebarAssignment(
    await readHead(),
    intent,
    secret,
  );
  if (confirmation.event)
    throw new Error(
      "Sidebar groups changed on another device; reload and try again",
    );
  return confirmation.groups;
}
