import type { ChannelMessage } from "../relay/contracts";
import { scanMarkdown, MAX_MARKDOWN_LENGTH } from "../relay/message-content";
import { parseOpenTarget } from "../navigation/targets";
import { profileMentionParts } from "./profile-mentions";
import { isLiteralMarkdownContext } from "./markdown-preparation";

export function messageCopyText(
  row: ChannelMessage,
  profiles: Parameters<typeof profileMentionParts>[1],
  agents: Parameters<typeof profileMentionParts>[2],
): string {
  let content = row.content;
  if (content.length <= MAX_MARKDOWN_LENGTH) {
    const scan = scanMarkdown(content);
    if (!scan.tooDeep) {
      const ranges: { start: number; end: number }[] = [];
      const pending = [scan.tree];
      while (pending.length) {
        const node = pending.pop();
        if (!node) continue;
        if (isLiteralMarkdownContext(node.type)) {
          const start = node.position?.start.offset;
          const end = node.position?.end.offset;
          if (start !== undefined && end !== undefined)
            ranges.push({ start, end });
        } else if ("children" in node) pending.push(...node.children);
      }
      let offset = 0;
      content = profileMentionParts(row, profiles, agents)
        .map((part) => {
          const start = offset;
          offset += part.text.length;
          if (
            !part.target ||
            ranges.some((range) => start < range.end && offset > range.start)
          )
            return part.text;
          const label = part.text.replace(/[\\[\]]/g, "\\$&");
          return `[${label}](${part.target})`;
        })
        .join("");
    }
  }
  // Projection separates attachments from prose. Keep their original destinations.
  return [content, ...row.attachments.map((attachment) => attachment.url)]
    .filter(Boolean)
    .join("\n\n");
}

export function messageCopyLink(
  row: ChannelMessage,
  scope: string | undefined,
): string | undefined {
  if (!scope || (row.delivery && !["accepted", "seen"].includes(row.delivery)))
    return undefined;
  try {
    const target = parseOpenTarget({
      version: 1,
      kind: "conversation",
      scope: { communityOrigin: scope.slice(0, -65), viewer: scope.slice(-64) },
      channelId: row.channelId,
      messageId: row.id,
      ...(row.threadRootId ? { threadRootId: row.threadRootId } : {}),
    });
    if (target.kind !== "conversation" || !target.messageId) return undefined;
    // Buzz links carry no community or identity: they bind to the recipient's
    // selected community, so the sender's scope is deliberately left out.
    const params = new URLSearchParams({
      channel: target.channelId,
      id: target.messageId,
      ...(target.threadRootId ? { thread: target.threadRootId } : {}),
    });
    return `buzz://message?${params}`;
  } catch {
    return undefined;
  }
}
