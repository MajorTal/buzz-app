import {
  bindSharedTarget,
  parseOpenTarget,
  parseTargetLink,
  type NavigationScope,
  type SharedTarget,
} from "./targets";

type BuzzLink =
  | { format: "shared"; target: SharedTarget }
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
    if (url.hostname === "open")
      return { format: "shared", target: parseTargetLink(href) };
    const channelPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/;
    const eventPattern = /^[a-f0-9]{64}$/i;
    if (url.hostname === "channel" && !url.search) {
      const channelId = decodeURIComponent(url.pathname.slice(1));
      return channelPattern.test(channelId)
        ? { format: "legacy", channelId }
        : null;
    }
    if (url.hostname !== "message" || url.pathname) return null;
    const keys = [...url.searchParams.keys()];
    if (
      new Set(keys).size !== keys.length ||
      keys.some((key) => !["channel", "id", "thread"].includes(key))
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
  const target =
    link.format === "shared"
      ? link.target
      : { ...link, kind: "conversation" as const };
  if (target.kind !== "conversation") return "buzz";
  return target.threadRootId
    ? "thread"
    : target.messageId
      ? "message"
      : "channel";
}

export function buzzLinkTarget(href: string, scope: NavigationScope) {
  const link = parseBuzzLink(href);
  if (!link) return null;
  if (link.format === "shared")
    return bindSharedTarget(link.target, scope.viewer);
  const { format: _format, ...destination } = link;
  return parseOpenTarget({
    version: 1,
    kind: "conversation",
    scope,
    ...destination,
  });
}
