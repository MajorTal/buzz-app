import { finalizeEvent, getPublicKey, nip44 } from "nostr-tools";
import { decodeSidebarPreferences } from "./sidebar-preferences.mjs";

const COORDINATE = "channel-mutes";
export function assertSidebarMuteIntent(intent) {
  if (
    !intent ||
    typeof intent !== "object" ||
    Array.isArray(intent) ||
    typeof intent.channelId !== "string" ||
    !intent.channelId.trim() ||
    intent.channelId.length > 256 ||
    typeof intent.muted !== "boolean" ||
    Object.keys(intent).some((key) => !["channelId", "muted"].includes(key))
  )
    throw new Error("Invalid sidebar mute intent");
}

/** One explicit mute intent against a fresh signed head; keep unmute tombstones. */
export function prepareSidebarMute(events, intent, secret, now = Date.now()) {
  assertSidebarMuteIntent(intent);
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
    throw new Error("Invalid sidebar mute head");
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
    if (previous?.muted === intent.muted) return { mutes: current };
    const mutes = {
      ...current,
      channels: {
        ...current.channels,
        [intent.channelId]: {
          ...previous,
          muted: intent.muted,
          updatedAt: Math.max(now, (previous?.updatedAt ?? 0) + 1),
        },
      },
    };
    const event = finalizeEvent(
      {
        kind: 30078,
        content: nip44.v2.encrypt(JSON.stringify(mutes), key),
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
    return { mutes, event };
  } finally {
    key.fill(0);
  }
}

export async function mutateSidebarMute(intent, secret, readHead, publish) {
  assertSidebarMuteIntent(intent);
  const draft = prepareSidebarMute(await readHead(), intent, secret);
  if (!draft.event) return draft.mutes;
  await publish(draft.event);
  const confirmation = prepareSidebarMute(await readHead(), intent, secret);
  if (confirmation.event)
    throw new Error(
      "Sidebar mutes changed on another device; reload and try again",
    );
  return confirmation.mutes;
}
