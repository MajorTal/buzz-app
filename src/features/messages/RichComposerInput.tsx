import type { ConversationExtensions } from "../conversation/contracts";
import type { CustomEmoji } from "../relay/emoji";
import type { RelaySession } from "../relay/session";
import { scanMarkdown } from "../relay/message-content";
import { MessageMarkdown } from "./MessageMarkdown";
import type { MentionDraft } from "./mention-draft";
import { useReferenceDirectory } from "./ReferenceText";
import { messageLinkParts } from "./message-link-parts";
import { messageReferences } from "./message-references";
import { EditableInput, type EditableInputProps } from "./EditableInput";

/** Decorations never change source text or infer notification recipients from names. */
export function RichComposerInput({
  draft,
  session,
  scope,
  channelId,
  extensions,
  emoji,
  ...input
}: EditableInputProps & {
  draft: MentionDraft;
  session: RelaySession;
  scope: string;
  channelId: string;
  extensions: ConversationExtensions | undefined;
  emoji: readonly CustomEmoji[];
}) {
  const directory = useReferenceDirectory(session, draft.recipients.length > 0);
  const profiles = new Map(directory.profiles);
  for (const recipient of draft.recipients)
    profiles.set(recipient.pubkey, {
      ...profiles.get(recipient.pubkey),
      name: recipient.name,
    });
  const { tree, tooDeep } = scanMarkdown(draft.text);
  const literals: { start: number; end: number }[] = [];
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    if (!node) continue;
    if (
      [
        "code",
        "inlineCode",
        "image",
        "imageReference",
        "definition",
        "html",
      ].includes(node.type)
    ) {
      const start = node.position?.start.offset,
        end = node.position?.end.offset;
      if (start !== undefined && end !== undefined)
        literals.push({ start, end });
    } else pending.push(...(node.children ?? []));
  }
  const ranges: {
    start: number;
    end: number;
    mention?: string;
    editAsText?: boolean;
  }[] = [];
  const add = (
    start: number,
    end: number,
    mention?: string,
    editAsText = false,
  ) => {
    if (
      !tooDeep &&
      ![...literals, ...ranges].some(
        (range) => start < range.end && end > range.start,
      )
    )
      ranges.push({ start, end, editAsText, ...(mention ? { mention } : {}) });
  };
  messageLinkParts(draft.text, undefined, (start, end) =>
    add(start, end, undefined, true),
  );
  for (const recipient of draft.recipients)
    add(recipient.start, recipient.end, recipient.pubkey);
  for (const reference of messageReferences(
    draft.text,
    [],
    profiles,
    directory.channels,
    directory.agents,
  ))
    add(reference.start, reference.end, undefined, true);
  const renderableEmoji = emoji.filter((entry) => !!session.media(entry.url));
  const shortcodes = new Set(
    renderableEmoji.map((entry) => entry.shortcode.toLowerCase()),
  );
  for (const match of draft.text.matchAll(/:([a-z0-9_-]{1,64}):/gi))
    if (shortcodes.has(match[1]?.toLowerCase() ?? ""))
      add(match.index, match.index + match[0].length);
  const decorations = ranges
    .sort((a, b) => a.start - b.start)
    .map(({ start, end, mention, editAsText }) => ({
      start,
      end,
      editAsText: !!editAsText,
      content: (
        <MessageMarkdown
          row={{
            id: "composer",
            authorId: "",
            createdAt: 0,
            channelId,
            content: draft.text.slice(start, end),
            mentions: mention ? [mention] : [],
            emoji: renderableEmoji,
            participants: [],
            attachments: [],
            reactions: [],
            replyCount: 0,
          }}
          directory={directory}
          participantProfiles={profiles}
          session={session}
          scope={scope}
          extensions={extensions}
          media={session.media}
          onOpenLink={() => false}
          interactive={false}
        />
      ),
    }));
  return <EditableInput {...input} decorations={decorations} />;
}
