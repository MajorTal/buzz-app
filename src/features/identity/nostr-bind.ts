// "Sign in with Buzz": the kind-24243 identity binding old Buzz Desktop signs
// (block/buzz desktop/src-tauri/src/nostr_bind.rs). Shared by the page-side
// request path and the dev broker, which re-validates before signing.
export const NOSTR_BIND_KIND = 24243;
export const NOSTR_BIND_FIXED = Object.freeze({
  audience: "buzz:nostr-identity",
  action: "bind_nostr_identity",
  protocol: "buzz-nostr-identity",
  version: "1",
});
export const NOSTR_BIND_TAGS = Object.freeze([
  "challenge_id",
  "nonce",
  "verification_code",
  "audience",
  "action",
  "protocol",
  "version",
  "origin",
  "expires_at",
] as const);
/** Sites issue short challenges; a far-future expiry is not a sign-in request. */
export const NOSTR_BIND_MAX_TTL_MS = 10 * 60 * 1000;

export type NostrBindTags = readonly (readonly [string, string])[];
export type NostrBindEvent = Readonly<{
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}>;

const FORMATS: Record<string, RegExp> = {
  challenge_id:
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  nonce: /^[A-Za-z0-9_-]{43}$/,
  verification_code: /^\d{6}$/,
  expires_at:
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i,
};

/** A bare https origin, exactly as `URL.origin` spells it. */
export function isBareHttpsOrigin(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
}

/** Exactly the nine tags, in order, with valid values and an unexpired, near expiry. */
export function validateNostrBindTags(
  tags: unknown,
  nowMs: number,
): asserts tags is NostrBindTags {
  if (!Array.isArray(tags) || tags.length !== NOSTR_BIND_TAGS.length)
    throw new Error("Invalid sign-in request");
  NOSTR_BIND_TAGS.forEach((name, index) => {
    const tag = tags[index];
    const value = tag?.[1];
    if (
      !Array.isArray(tag) ||
      tag.length !== 2 ||
      tag[0] !== name ||
      typeof value !== "string" ||
      !(name in NOSTR_BIND_FIXED
        ? value === NOSTR_BIND_FIXED[name as keyof typeof NOSTR_BIND_FIXED]
        : name === "origin"
          ? isBareHttpsOrigin(value)
          : FORMATS[name]?.test(value))
    )
      throw new Error("Invalid sign-in request");
  });
  const expires = Date.parse(tags[8][1]);
  if (!(expires > nowMs && expires <= nowMs + NOSTR_BIND_MAX_TTL_MS))
    throw new Error("Sign-in request expired or too far out");
}

/** The broker's request body: nothing but the binding template. */
export function validateNostrBindTemplate(
  template: unknown,
  nowMs: number,
): asserts template is {
  kind: typeof NOSTR_BIND_KIND;
  content: "";
  tags: NostrBindTags;
} {
  if (
    !template ||
    typeof template !== "object" ||
    Object.keys(template).sort().join() !== "content,kind,tags" ||
    (template as { kind?: unknown }).kind !== NOSTR_BIND_KIND ||
    (template as { content?: unknown }).content !== ""
  )
    throw new Error("Invalid sign-in request");
  validateNostrBindTags((template as { tags?: unknown }).tags, nowMs);
}

/** Signs one binding with the viewer's key through the dev broker's dedicated route. */
export async function signNostrBind(
  tags: NostrBindTags,
): Promise<NostrBindEvent> {
  const template = { kind: NOSTR_BIND_KIND, content: "", tags };
  const response = await fetch("/api/relay/nostr-bind-sign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(template),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("Sign-in could not be signed");
  const { event } = (await response.json()) as { event?: NostrBindEvent };
  if (
    event?.kind !== NOSTR_BIND_KIND ||
    event.content !== "" ||
    JSON.stringify(event.tags) !== JSON.stringify(tags) ||
    typeof event.sig !== "string"
  )
    throw new Error("Sign-in could not be signed");
  return event;
}
