import { validReactionContent } from "./emoji";
import type { EventData } from "./events";
import type { Outbox } from "./outbox";

/** Domain convenience only. Delivery and read reconciliation remain session-owned. */
export function createMessages(
  outbox: Outbox | undefined,
  viewer: string | undefined,
  find: (id: string) => EventData | undefined,
  emojiTags: (content: string) => string[][],
  validateMentions: (channelId: string, pubkeys: readonly string[]) => void,
  resolveRecipients: (
    channelId: string,
    pubkeys: readonly string[],
  ) => readonly string[],
) {
  const writer = (kind: number) => {
    if (!outbox?.supports(kind))
      throw new Error("This connection cannot publish that operation");
    return outbox;
  };
  const text = (content: string) => {
    const value = content.trim();
    if (!value) throw new Error("Message is empty");
    return value;
  };
  const mentionTags = (channelId: string, pubkeys: readonly string[]) => {
    if (
      pubkeys.length > 32 ||
      pubkeys.some((key) => !/^[0-9a-f]{64}$/.test(key))
    )
      throw new Error("Choose at most 32 valid mention recipients");
    const unique = [...new Set(resolveRecipients(channelId, pubkeys))];
    validateMentions(channelId, unique);
    return unique.map((key) => ["p", key]);
  };
  return Object.freeze({
    send(channelId: string, content: string, mentions: readonly string[] = []) {
      if (!channelId) throw new Error("A channel is required");
      return writer(9).send({
        kind: 9,
        content: text(content),
        tags: [
          ["h", channelId],
          ...mentionTags(channelId, mentions),
          ...emojiTags(content),
        ],
      });
    },
    reply(
      channelId: string,
      rootId: string,
      content: string,
      mentions: readonly string[] = [],
    ) {
      if (!channelId) throw new Error("A channel is required");
      if (!/^[0-9a-f]{64}$/.test(rootId))
        throw new Error("A valid thread root is required");
      return writer(9).send({
        kind: 9,
        content: text(content),
        tags: [
          ["h", channelId],
          ["e", rootId, "", "reply"],
          ...mentionTags(channelId, mentions),
          ...emojiTags(content),
        ],
      });
    },
    edit(messageId: string, content: string) {
      const original = find(messageId);
      if (!original || ![9, 40002].includes(original.kind))
        throw new Error("Load the message before editing it");
      if (original.pubkey !== viewer)
        throw new Error("Only your own messages can be edited");
      const channelId = original.tags.find((tag) => tag[0] === "h")?.[1];
      if (!channelId) throw new Error("Message has no channel");
      return writer(40003).send({
        kind: 40003,
        content: text(content),
        tags: [["h", channelId], ["e", messageId], ...emojiTags(content)],
      });
    },
    react(messageId: string, content: string) {
      const original = find(messageId);
      if (!original || ![9, 40002].includes(original.kind))
        throw new Error("Load the message before reacting to it");
      const channelId = original.tags.find((tag) => tag[0] === "h")?.[1];
      if (!channelId) throw new Error("Message has no channel");
      const value = text(content);
      if (!validReactionContent(value)) throw new Error("Reaction is too long");
      return writer(7).send({
        kind: 7,
        content: value,
        tags: [["h", channelId], ["e", messageId], ...emojiTags(value)],
      });
    },
    retry(id: string) {
      outbox?.retry(id);
    },
  });
}
