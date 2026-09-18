import { validatedBlurhash } from "./blurhash";
import { threadReference } from "./thread-reference";
import { emojiTags } from "./emoji";
import { objectBody } from "./body";
import { newer } from "./events";
import type { EventData } from "./events";
import type { Attachment, ChannelMessage } from "./contracts";
import { projectMarkdownImages, safeMessageUrl } from "./message-content";

import { channelRowKind, membershipChange } from "./membership";
const HEX64 = /^[0-9a-f]{64}$/;

export function parseAttachments(
  event: EventData,
  markdownImages: readonly string[],
): Attachment[] {
  const result: Attachment[] = [];
  const seen = new Set<string>();
  for (const entry of event.tags) {
    if (entry[0] !== "imeta") continue;
    const fields = Object.fromEntries(
      entry.slice(1).map((field) => {
        const split = field.indexOf(" ");
        return [field.slice(0, split), field.slice(split + 1)];
      }),
    );
    const url = fields.url ? safeMessageUrl(fields.url) : undefined;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    // Treat signed metadata as untrusted layout input. Invalid/missing dimensions
    // use the renderer's stable fallback rather than image-load-driven geometry.
    const dim = /^(\d{1,6})x(\d{1,6})$/.exec(fields.dim ?? "");
    const width = Number(dim?.[1]),
      height = Number(dim?.[2]);
    const blurhash = validatedBlurhash(fields.blurhash);
    result.push({
      url,
      ...(blurhash ? { blurhash } : {}),
      video: fields.m?.startsWith("video/") ?? false,
      ...(width > 0 && height > 0 ? { dimensions: { width, height } } : {}),
    });
  }
  for (const url of markdownImages) {
    if (seen.has(url)) continue;
    seen.add(url);
    result.push({ url, video: /\.(mp4|webm)(?:\?|$)/i.test(url) });
  }
  return result;
}

function parseSummary(
  event: EventData | undefined,
): Pick<ChannelMessage, "replyCount" | "participants"> {
  if (!event) return { replyCount: 0, participants: Object.freeze([]) };
  try {
    const body = objectBody(event.content);
    if (!body) return { replyCount: 0, participants: Object.freeze([]) };
    const replyCount =
      typeof body.reply_count === "number" &&
      Number.isInteger(body.reply_count) &&
      body.reply_count >= 0
        ? body.reply_count
        : 0;
    const participants = Array.isArray(body.participants)
      ? body.participants.filter(
          (value): value is string =>
            typeof value === "string" && HEX64.test(value),
        )
      : [];
    return {
      replyCount,
      participants: Object.freeze([...new Set(participants)]),
    };
  } catch {
    return { replyCount: 0, participants: Object.freeze([]) };
  }
}

/** Folds one window's top-level messages with their aux overlays: author deletes (5/9005),
 * author edits (40003, latest wins), reactions (7) and relay-signed thread summaries (39005).
 * Replies stay out of the top level. Output is ascending by time; ties break on id so windows merge deterministically. */
export function foldMessages(
  channelId: string,
  relayAuthor: string,
  events: readonly EventData[],
  { includeReplies = false }: { includeReplies?: boolean } = {},
): ChannelMessage[] {
  const overlays = new Map<string, EventData[]>();
  const summaries = new Map<string, EventData>();
  for (const event of events) {
    if (channelRowKind(event.kind)) continue;
    if (event.kind === 39005) {
      const target = event.tags.find((entry) => entry[0] === "e")?.[1];
      if (target && event.pubkey === relayAuthor)
        summaries.set(target, newer(summaries.get(target), event));
      continue;
    }
    for (const entry of event.tags) {
      if (entry[0] !== "e" || !entry[1]) continue;
      const list = overlays.get(entry[1]) ?? [];
      list.push(event);
      overlays.set(entry[1], list);
    }
  }
  const deleted = (event: EventData) =>
    overlays
      .get(event.id)
      ?.some(
        (item) => [5, 9005].includes(item.kind) && item.pubkey === event.pubkey,
      ) ?? false;
  const rows: ChannelMessage[] = [];
  for (const event of events) {
    if (!channelRowKind(event.kind)) continue;
    if (!event.tags.some((entry) => entry[0] === "h" && entry[1] === channelId))
      continue;
    if (
      !includeReplies &&
      event.tags.some((entry) => entry[0] === "e" && entry[3] === "reply") &&
      !event.tags.some((entry) => entry[0] === "broadcast" && entry[1] === "1")
    )
      continue;
    const aux = overlays.get(event.id) ?? [];
    if (deleted(event)) continue;
    if (event.kind === 40099) {
      const membership = membershipChange(event, relayAuthor);
      if (membership)
        rows.push(
          Object.freeze({
            id: event.id,
            channelId,
            authorId: event.pubkey,
            createdAt: event.created_at,
            content: "",
            membership,
            mentions: Object.freeze([]),
            attachments: Object.freeze([]),
            reactions: Object.freeze([]),
            replyCount: 0,
            participants: Object.freeze([]),
          }),
        );
      continue;
    }
    const edits = aux
      .filter(
        (item) =>
          item.kind === 40003 && item.pubkey === event.pubkey && !deleted(item),
      )
      .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
    let content = edits[0]?.content ?? event.content;
    if (event.kind === 40002) {
      const body = objectBody(content);
      if (typeof body?.content === "string") content = body.content;
    }
    // Every CommonMark image begins with `![`; avoid a second Markdown parse for
    // ordinary messages, while sharing the parser with every supported image form.
    const projected = content.includes("![")
      ? projectMarkdownImages(content)
      : { content, urls: Object.freeze([] as string[]) };
    rows.push(
      Object.freeze({
        id: event.id,
        channelId,
        threadRootId: threadReference(event)?.rootId,
        authorId: event.pubkey,
        createdAt: event.created_at,
        content: projected.content,
        ...(event.kind === 40002 ? { agentEnvelope: true as const } : {}),
        ...(edits.length ? { edited: true as const } : {}),
        ...(projected.content !== content &&
        projected.content !== content.trimEnd()
          ? { attachmentContentRemoved: true as const }
          : {}),
        mentions: Object.freeze([
          ...new Set(
            event.tags.flatMap(([name, value]) =>
              name === "p" && value && HEX64.test(value) ? [value] : [],
            ),
          ),
        ]),
        attachments: Object.freeze(parseAttachments(event, projected.urls)),
        emoji: emojiTags(
          edits[0]?.tags.some(([name]) => name === "emoji") ? edits[0] : event,
        ),
        reactions: Object.freeze([
          ...new Map(
            aux
              .filter((item) => item.kind === 7 && !deleted(item))
              .map((item) => {
                const emoji = emojiTags(item).find(
                  (emoji) =>
                    item.content.toLowerCase() === `:${emoji.shortcode}:`,
                );
                const reaction = Object.freeze({
                  content: item.content,
                  ...(emoji ? { emoji } : {}),
                });
                return [JSON.stringify(reaction), reaction] as const;
              }),
          ).values(),
        ]),
        ...parseSummary(summaries.get(event.id)),
      }),
    );
  }
  return rows.sort(
    (a, b) => a.createdAt - b.createdAt || b.id.localeCompare(a.id),
  );
}
