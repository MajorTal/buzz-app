import { projectMarkdownAttachments } from "../relay/message-content";
import type { AgentLibrary } from "../agents/library";
import type { ChannelMessage, Profile } from "../relay/contracts";
import { profileMentionParts } from "./profile-mentions";

/** Keep attachment Markdown and turn already-bound names into explicit identities.
 * Edited legacy prose remains unbound; the editor never invents recipients. */
export function messageEditText(
  row: ChannelMessage,
  profiles: ReadonlyMap<string, Profile>,
  agents: AgentLibrary["identities"] = [],
) {
  const { attachmentContentRemoved: _removed, ...source } = row;
  return profileMentionParts(
    { ...source, content: row.sourceContent ?? row.content },
    profiles,
    agents,
  )
    .map(({ text, target }) =>
      target ? `[${text.replace(/[\\[\]]/g, "\\$&")}](${target})` : text,
    )
    .join("");
}

/** Attachments are not editable in this surface; original metadata stays signed. */
export function validateMessageEdit(
  row: ChannelMessage,
  initial: string,
  content: string,
) {
  const urls = new Set(row.attachments.map((attachment) => attachment.url));
  const before = projectMarkdownAttachments(initial, urls);
  const after = projectMarkdownAttachments(content, urls);
  if (
    [...urls].some(
      (url) => initial.split(url).length !== content.split(url).length,
    ) ||
    JSON.stringify([before.urls, before.names]) !==
      JSON.stringify([after.urls, after.names])
  )
    throw new Error(
      "Keep attachment links unchanged. Only message text can be edited here.",
    );
  return content;
}
