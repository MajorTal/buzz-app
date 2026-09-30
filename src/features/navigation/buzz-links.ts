import {
  entityTarget,
  parseEntityLink,
  type EntityRoute,
} from "../projects/routes";
import { parseOpenTarget, type NavigationScope } from "./targets";

type BuzzLink =
  | { format: "entity"; route: EntityRoute }
  | {
      format: "legacy";
      channelId: string;
      messageId?: string;
      threadRootId?: string;
    };

/** True for any `buzz:` scheme link, regardless of case. Classification must
 * match `parseBuzzLink`, which normalizes the scheme via `URL`; a lowercase-only
 * `startsWith` check would misroute `BUZZ://…` to external handling. */
export function isBuzzLink(href: string): boolean {
  try {
    return new URL(href).protocol === "buzz:";
  } catch {
    return false;
  }
}

/** Legacy links are relative to the receiving conversation's community, never an access grant. */
export function parseBuzzLink(href: string): BuzzLink | null {
  try {
    if (href.length > 32768) return null;
    const url = new URL(href);
    if (
      url.protocol !== "buzz:" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash
    )
      return null;
    const entity = parseEntityLink(url);
    if (entity) return { format: "entity", route: entity };
    const channelPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/;
    const eventPattern = /^[a-f0-9]{64}$/i;
    // Query parameters outside a form's grammar are ignored, values and repeats
    // included, as the original Buzz desktop client does. The channel forms carry
    // everything in the path, so any query is ignored there.
    if (url.hostname === "channel") {
      const parts = url.pathname.slice(1).split("/").map(decodeURIComponent);
      const [channelId = "", messageId] = parts;
      if (
        parts.length > 2 ||
        !channelPattern.test(channelId) ||
        (messageId !== undefined && !eventPattern.test(messageId))
      )
        return null;
      return {
        format: "legacy",
        channelId,
        ...(messageId ? { messageId: messageId.toLowerCase() } : {}),
      };
    }
    if (url.hostname !== "message" || url.pathname) return null;
    // A duplicated known key is ambiguous and still rejects.
    if (
      ["channel", "id", "thread"].some(
        (key) => url.searchParams.getAll(key).length > 1,
      )
    )
      return null;
    const channelId = url.searchParams.get("channel") ?? "";
    const messageId = url.searchParams.get("id") ?? "";
    const threadRootId = url.searchParams.get("thread");
    if (
      !channelPattern.test(channelId) ||
      !eventPattern.test(messageId) ||
      (threadRootId !== null && !eventPattern.test(threadRootId))
    )
      return null;
    return {
      format: "legacy",
      channelId,
      messageId: messageId.toLowerCase(),
      ...(threadRootId ? { threadRootId: threadRootId.toLowerCase() } : {}),
    };
  } catch {
    return null;
  }
}

export function buzzLinkKind(href: string) {
  const link = parseBuzzLink(href);
  if (!link) return null;
  if (link.format === "entity") return "buzz";
  return link.threadRootId ? "thread" : link.messageId ? "message" : "channel";
}

export function buzzLinkTarget(href: string, scope: NavigationScope) {
  const link = parseBuzzLink(href);
  if (!link) return null;
  if (link.format === "entity") return entityTarget(link.route, scope);
  const { format: _format, ...destination } = link;
  return parseOpenTarget({
    version: 1,
    kind: "conversation",
    scope,
    ...destination,
  });
}
