import {
  NOSTR_BIND_TAGS,
  validateNostrBindTags,
  type NostrBindEvent,
  type NostrBindTags,
} from "../../features/identity/nostr-bind";

export type NostrBindRequest = Readonly<{
  challengeId: string;
  expiresAt: string;
  tags: NostrBindTags;
}>;
export type NostrBindError = "declined" | "expired" | "unavailable" | "invalid";
export type NostrBindPrompt = Readonly<{
  type: "buzz.nostr-bind.prompt";
  version: 1;
  challengeId: string;
}>;

export type NostrBindResult = Readonly<
  { type: "buzz.nostr-bind.result"; version: 1; challengeId: string } & (
    | { event: NostrBindEvent }
    | { error: NostrBindError }
  )
>;

/**
 * Reads a framed site's `buzz://nostr-bind` link, bound to the origin the host
 * actually framed: the signed origin must be that origin, not merely well formed.
 * Undefined when there is no challenge to answer.
 */
export function parseNostrBindRequest(
  deepLink: unknown,
  framedOrigin: string,
  nowMs: number,
):
  | NostrBindRequest
  | { challengeId: string; error: "invalid" | "expired" }
  | undefined {
  let url: URL;
  try {
    url = new URL(String(deepLink));
  } catch {
    return;
  }
  const one = (name: string) => {
    const values = url.searchParams.getAll(name);
    return values.length === 1 && values[0] ? values[0] : undefined;
  };
  const challengeId = one("challenge_id");
  if (!challengeId || challengeId.length > 64) return;
  const invalid = { challengeId, error: "invalid" } as const;
  if (url.protocol !== "buzz:" || url.hostname !== "nostr-bind") return invalid;
  const mode = one("return");
  const callback = one("callback_url");
  if (
    one("origin") !== framedOrigin ||
    !(mode === "clipboard" || (mode === "browser_fragment_v1" && callback)) ||
    (callback !== undefined && !sameOrigin(callback, framedOrigin))
  )
    return invalid;
  const tags = NOSTR_BIND_TAGS.map((name) => [name, one(name) ?? ""] as const);
  const expiresAt = one("expires_at") ?? "";
  if (Date.parse(expiresAt) <= nowMs) return { challengeId, error: "expired" };
  try {
    validateNostrBindTags(tags, nowMs);
  } catch {
    return invalid;
  }
  return { challengeId, expiresAt, tags };
}

function sameOrigin(value: string, origin: string) {
  try {
    const url = new URL(value);
    return url.origin === origin && !url.username && !url.password;
  } catch {
    return false;
  }
}
