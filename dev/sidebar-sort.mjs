import { finalizeEvent, getPublicKey, nip44, verifyEvent } from "nostr-tools";
import { projectSidebarPreferences } from "../src/features/relay/sidebar-preferences.ts";
import { SIDEBAR_REQUEST_BYTES } from "./sidebar-preferences.mjs";

const SORT_COORDINATE = "channel-sort";
const SORT_KEYS = new Set(["starred", "channels", "forums", "dms"]);
function validSortGroup(group, sectionIds) {
  return (
    SORT_KEYS.has(group) ||
    (group.startsWith("section:") && sectionIds.includes(group.slice(8)))
  );
}
export function assertSidebarSortIntent(intent) {
  if (
    !intent ||
    typeof intent !== "object" ||
    Array.isArray(intent) ||
    typeof intent.group !== "string" ||
    intent.group.length > 264 ||
    !["alpha", "recent"].includes(intent.mode) ||
    !Array.isArray(intent.sectionIds) ||
    intent.sectionIds.length > 100 ||
    intent.sectionIds.some(
      (id) => typeof id !== "string" || !id.trim() || id.length > 256,
    ) ||
    !validSortGroup(intent.group, intent.sectionIds) ||
    Object.keys(intent).some(
      (key) => !["group", "mode", "sectionIds"].includes(key),
    )
  )
    throw new Error("Invalid sidebar sort intent");
}
function parseSortEvent(events, secret, sectionIds) {
  if (
    !Array.isArray(events) ||
    events.length > 1 ||
    Buffer.byteLength(JSON.stringify(events)) > SIDEBAR_REQUEST_BYTES
  )
    throw new Error("Invalid sidebar sort head");
  if (!events.length) return { blob: { version: 1, groups: {} }, createdAt: 0 };
  const [event] = events;
  const viewer = getPublicKey(secret);
  const tags = event?.tags?.filter?.(
    (tag) => Array.isArray(tag) && tag[0] === "d",
  );
  if (
    event?.kind !== 30078 ||
    event.pubkey !== viewer ||
    tags?.length !== 1 ||
    tags[0]?.[1] !== SORT_COORDINATE ||
    typeof event.content !== "string" ||
    !verifyEvent(event)
  )
    throw new Error("Invalid sidebar sort head");
  const key = nip44.v2.utils.getConversationKey(secret, viewer);
  try {
    const plaintext = nip44.v2.decrypt(event.content, key);
    if (Buffer.byteLength(plaintext) > 128 * 1024)
      throw new Error("Sidebar plaintext budget exceeded");
    const blob = JSON.parse(plaintext);
    projectSidebarPreferences(undefined, undefined, blob, sectionIds);
    return { blob, createdAt: event.created_at };
  } finally {
    key.fill(0);
  }
}
export function prepareSidebarSort(events, intent, secret, now = Date.now()) {
  assertSidebarSortIntent(intent);
  const viewer = getPublicKey(secret);
  const current = parseSortEvent(events, secret, intent.sectionIds);
  const groups = { ...current.blob.groups };
  if (intent.mode === "alpha") delete groups[intent.group];
  else groups[intent.group] = intent.mode;
  const projected =
    projectSidebarPreferences(
      undefined,
      undefined,
      { ...current.blob, groups },
      intent.sectionIds,
    ).sort ?? {};
  if (
    Object.keys(groups).length === Object.keys(current.blob.groups).length &&
    Object.entries(groups).every(
      ([group, mode]) => current.blob.groups[group] === mode,
    )
  )
    return { groups: projected };
  const key = nip44.v2.utils.getConversationKey(secret, viewer);
  let content;
  try {
    content = nip44.v2.encrypt(
      JSON.stringify({ ...current.blob, groups }),
      key,
    );
  } finally {
    key.fill(0);
  }
  return {
    groups: projected,
    event: finalizeEvent(
      {
        kind: 30078,
        content,
        created_at: Math.max(Math.floor(now / 1000), current.createdAt + 1),
        tags: [
          ["d", SORT_COORDINATE],
          ["t", SORT_COORDINATE],
        ],
      },
      secret,
    ),
  };
}
export async function mutateSidebarSort(intent, secret, readHead, publish) {
  assertSidebarSortIntent(intent);
  const draft = prepareSidebarSort(await readHead(), intent, secret);
  if (!draft.event) return draft.groups;
  await publish(draft.event);
  const confirmation = prepareSidebarSort(await readHead(), intent, secret);
  if (confirmation.event)
    throw new Error(
      "Sidebar sort changed on another device; reload and try again",
    );
  return confirmation.groups;
}
