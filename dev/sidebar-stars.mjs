import { finalizeEvent, getPublicKey, nip44 } from "nostr-tools";
import { decodeSidebarPreferences } from "./sidebar-preferences.mjs";

const COORDINATE = "channel-stars";
export function assertSidebarStarIntent(intent) {
  if (
    !intent ||
    typeof intent !== "object" ||
    Array.isArray(intent) ||
    typeof intent.channelId !== "string" ||
    !intent.channelId.trim() ||
    intent.channelId.length > 256 ||
    typeof intent.starred !== "boolean" ||
    Object.keys(intent).some((key) => !["channelId", "starred"].includes(key))
  )
    throw new Error("Invalid sidebar star intent");
}

/** One explicit star intent against a fresh signed head; keep unstar tombstones. */
export function prepareSidebarStar(events, intent, secret, now = Date.now()) {
  assertSidebarStarIntent(intent);
  // The shared bounded decoder verifies signature, own author, schema and budgets.
  decodeSidebarPreferences(events, secret);
  if (
    events.length > 1 ||
    events.some(
      (event) =>
        !event.tags.some(
          ([name, value]) => name === "d" && value === COORDINATE,
        ),
    )
  )
    throw new Error("Invalid sidebar star head");
  const viewer = getPublicKey(secret);
  const key = nip44.v2.utils.getConversationKey(secret, viewer);
  try {
    const head = events[0];
    const current = head
      ? JSON.parse(nip44.v2.decrypt(head.content, key))
      : { version: 1, channels: {} };
    const previous = Object.hasOwn(current.channels, intent.channelId)
      ? current.channels[intent.channelId]
      : undefined;
    if (previous?.starred === intent.starred) return { stars: current };
    const stars = {
      ...current,
      channels: {
        ...current.channels,
        [intent.channelId]: {
          ...previous,
          starred: intent.starred,
          updatedAt: Math.max(now, (previous?.updatedAt ?? 0) + 1),
        },
      },
    };
    const event = finalizeEvent(
      {
        kind: 30078,
        content: nip44.v2.encrypt(JSON.stringify(stars), key),
        created_at: Math.max(
          Math.floor(now / 1000),
          (head?.created_at ?? 0) + 1,
        ),
        tags: [
          ["d", COORDINATE],
          ["t", COORDINATE],
        ],
      },
      secret,
    );
    // Refuse over-budget changes rather than silently trimming other channels.
    decodeSidebarPreferences([event], secret);
    return { stars, event };
  } finally {
    key.fill(0);
  }
}

export async function mutateSidebarStar(intent, secret, readHead, publish) {
  assertSidebarStarIntent(intent);
  const draft = prepareSidebarStar(await readHead(), intent, secret);
  if (!draft.event) return draft.stars;
  await publish(draft.event);
  const confirmation = prepareSidebarStar(await readHead(), intent, secret);
  if (confirmation.event)
    throw new Error(
      "Sidebar stars changed on another device; reload and try again",
    );
  return confirmation.stars;
}
