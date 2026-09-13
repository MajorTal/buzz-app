import type { ChannelSummary, Profile } from "../relay/contracts";
import type { IncomingMessage } from "../relay/incoming";
import { scanMarkdown } from "../relay/message-content";
import type { NotificationCategory } from "./preferences";

export type NotificationText = Readonly<{ title: string; body: string }>;

function shortText(value: string, limit: number) {
  const points = Array.from(
    value
      .replace(/[\p{Cc}\p{Bidi_Control}]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim(),
  );
  return points.length > limit
    ? `${points.slice(0, limit - 1).join("")}…`
    : points.join("");
}

type TextNode = { type: string; value?: string; children?: TextNode[] };
function prose(node: TextNode): string {
  if (node.type === "html" || node.type === "definition") return "";
  if (node.type === "image" || node.type === "imageReference") return "[Image]";
  if (node.type === "break" || node.type === "thematicBreak") return " ";
  if (node.value !== undefined) return node.value;
  const separator = [
    "paragraph",
    "heading",
    "emphasis",
    "strong",
    "link",
    "linkReference",
  ].includes(node.type)
    ? ""
    : " ";
  return (node.children ?? []).map(prose).join(separator);
}

/** Bounded CommonMark text, not rendered HTML or a fetch of linked/attached content. */
export function messagePreview(content: string): string {
  const { tree, tooDeep } = scanMarkdown(content.slice(0, 4096));
  return (tooDeep ? "" : shortText(prose(tree), 200)) || "New message";
}

/** Names are optional cached enrichment; notifications never wait for profile reads. */
export function messageNotificationText(
  message: IncomingMessage,
  category: NotificationCategory,
  channel: ChannelSummary | undefined,
  profile: Profile | undefined,
): NotificationText {
  const sender =
    shortText(profile?.name ?? "", 64) || message.authorId.slice(0, 10);
  const destination =
    channel?.channelType === "dm"
      ? "a direct message"
      : `#${shortText(channel?.name ?? "", 64) || message.channelId.slice(0, 8)}`;
  const title =
    category === "mention"
      ? `${sender} mentioned you in ${destination}`
      : category === "direct"
        ? `${sender} sent you a direct message`
        : `${sender} replied in ${destination}`;
  return Object.freeze({ title, body: messagePreview(message.previewContent) });
}
