import { EmojiCompletion } from "./EmojiCompletion";
import { emojiQuery } from "./emoji-query";
import type { PluginModule } from "../../plugins/api";
import type {
  ComposerToolProps,
  ReactionToolProps,
  InlineContent,
} from "../../features/conversation/contracts";
import { emojiMatches } from "../../features/relay/emoji";
import { EmojiPicker } from "./EmojiPicker";
import { CustomEmoji } from "./CustomEmoji";
import { copyEmoji } from "./copy-emoji";

export const inject = ["conversation"];
const entries = (content: InlineContent) =>
  content.reaction
    ? content.reaction.emoji
      ? [content.reaction.emoji]
      : []
    : (content.message.emoji ?? []);
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.effect(() => {
    if (typeof document === "undefined") return () => {};
    document.addEventListener("copy", copyEmoji);
    return () => document.removeEventListener("copy", copyEmoji);
  });
  ctx.conversation.registerCompletion({
    id: "typeahead",
    title: "Emoji",
    order: 0,
    match: (observation) => emojiQuery(observation.text, observation.start),
    component: EmojiCompletion,
  });
  ctx.conversation.registerTool({
    id: "picker",
    title: "Emoji",
    reactionComponent: ({
      session,
      scope,
      disabled,
      select,
    }: ReactionToolProps) => (
      <EmojiPicker
        session={session}
        scope={scope}
        disabled={disabled}
        insert={select}
        reaction
      />
    ),
    component: ({
      session,
      scope,
      disabled,
      insertText,
    }: ComposerToolProps) => (
      <EmojiPicker
        session={session}
        scope={scope}
        disabled={disabled}
        insert={insertText}
      />
    ),
  });
  ctx.conversation.registerInline({
    id: "custom",
    title: "Custom emoji",
    matches: (content) => [...emojiMatches(content.text, entries(content))],
    component: ({ text, content, media }) => {
      const emoji = entries(content).find(
        (entry) => `:${entry.shortcode}:` === text.toLowerCase(),
      );
      return emoji ? <CustomEmoji emoji={emoji} media={media} /> : text;
    },
  });
};
