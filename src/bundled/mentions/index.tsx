import { MentionCompletion } from "./MentionCompletion";
import { mentionQuery } from "./mention-query";
import type { PluginModule } from "../../plugins/api";
import { MentionPicker } from "./MentionPicker";

export const inject = ["conversation"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.conversation.registerCompletion({
    id: "typeahead",
    title: "Mention",
    order: -10,
    match: ({ text, start }) => mentionQuery(text, start),
    component: MentionCompletion,
  });
  ctx.conversation.registerTool({
    id: "picker",
    title: "Mentions",
    order: -10,
    component: ({
      session,
      channelId,
      disabled,
      insertMention,
      inviteAgents,
    }) => (
      <MentionPicker
        session={session}
        channelId={channelId}
        disabled={disabled}
        inviteAgents={inviteAgents}
        select={insertMention}
      />
    ),
  });
};
