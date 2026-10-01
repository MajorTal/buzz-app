import {
  projectComposerDocument,
  readComposerSnapshot,
} from "./composer-document";

export type MentionRecipient = Readonly<{ pubkey: string; name: string }>;
export type DraftRecipient = MentionRecipient &
  Readonly<{ start: number; end: number }>;
// Serializable draft metadata must not expose editor implementation types to plugins.
export type ComposerSnapshot = { version: 1; content: unknown };
export type MentionDraft = {
  text: string;
  recipients: readonly DraftRecipient[];
  document?: ComposerSnapshot;
};
// The timeline binds a signed name up to the next non-name character, so the
// inline Markdown delimiters *, ~ and ` end a mention here as well: typing a
// closing delimiter after a chip keeps its recipient. An underscore remains a
// name suffix, as it does on the timeline.
const boundary = (text: string, end: number) =>
  end === text.length || /[\s.,!?;:()[\]{}*~`]/u.test(text[end] ?? "");
/** Old text-only drafts remain text-only: restoring prose never creates notifications. */
export function mentionDraft(value: unknown): MentionDraft {
  if (typeof value === "string") return { text: value, recipients: [] };
  if (!value || typeof value !== "object") return { text: "", recipients: [] };
  const record = value as Record<string, unknown>;
  const doc = readComposerSnapshot(record.document);
  const { text, recipients, document } = doc
    ? projectComposerDocument(doc).draft
    : record;
  if (typeof text !== "string") return { text: "", recipients: [] };
  const safe = Array.isArray(recipients)
    ? recipients.filter(
        (item): item is DraftRecipient =>
          !!item &&
          typeof item === "object" &&
          typeof item.pubkey === "string" &&
          /^[0-9a-f]{64}$/.test(item.pubkey) &&
          typeof item.name === "string" &&
          !!item.name.trim() &&
          Number.isInteger(item.start) &&
          Number.isInteger(item.end) &&
          item.start >= 0 &&
          item.end <= text.length &&
          text.slice(item.start, item.end) === `@${item.name}` &&
          boundary(text, item.end),
      )
    : [];
  return {
    text,
    ...(doc ? { document: document as ComposerSnapshot } : {}),
    recipients: safe
      .slice(0, 32)
      .map(({ pubkey, name, start, end }) => ({ pubkey, name, start, end })),
  };
}
/** Prefill exact, already-selected identities; never infer recipients from prose. */
export function followupDraft(
  recipients: readonly MentionRecipient[],
): MentionDraft {
  const next: MentionDraft = { text: "", recipients: [] };
  const spans: DraftRecipient[] = [];
  const unique = new Map(recipients.map((item) => [item.pubkey, item]));
  for (const { pubkey, name } of [...unique.values()].slice(0, 32)) {
    const start = next.text.length;
    const text = `@${name} `;
    if (start + text.length > 16000) break;
    next.text += text;
    spans.push({ pubkey, name, start, end: next.text.length - 1 });
  }
  return mentionDraft({ text: next.text, recipients: spans });
}
/** Known editor replacement keeps only untouched spans. */
export function replaceMentionDraft(
  value: MentionDraft,
  start: number,
  end: number,
  inserted: string,
): MentionDraft {
  const text = value.text.slice(0, start) + inserted + value.text.slice(end);
  const delta = inserted.length - (end - start);
  return mentionDraft({
    text,
    recipients: value.recipients.flatMap((item) => {
      if (item.end <= start) return [item];
      if (item.start >= end)
        return [{ ...item, start: item.start + delta, end: item.end + delta }];
      return [];
    }),
  });
}
export type MentionEdit = Readonly<{
  text: string;
  start: number;
  end: number;
  inputType: string;
}>;
/** Preserve identity only when the browser supplied the actual replacement range.
 * Matching before/after prose cannot distinguish a paste from untouched text. */
export function editMentionDraft(
  value: MentionDraft,
  text: string,
  edit?: MentionEdit,
): MentionDraft {
  if (
    edit?.text === value.text &&
    Number.isInteger(edit.start) &&
    Number.isInteger(edit.end) &&
    edit.start >= 0 &&
    edit.end >= edit.start &&
    edit.end <= value.text.length
  ) {
    const insertion = [
      "insertText",
      "insertReplacementText",
      "insertFromPaste",
      "insertLineBreak",
    ].includes(edit.inputType);
    const selectionDeletion =
      edit.inputType.startsWith("delete") && edit.end > edit.start;
    // Collapsed word/grapheme deletion, IME and history operations have no reliable
    // textarea target range. They fail closed instead of reconstructing one.
    const length = text.length - (value.text.length - (edit.end - edit.start));
    if (
      (insertion || (selectionDeletion && length === 0)) &&
      length >= 0 &&
      text.slice(0, edit.start) === value.text.slice(0, edit.start) &&
      text.slice(edit.start + length) === value.text.slice(edit.end)
    )
      return replaceMentionDraft(
        value,
        edit.start,
        edit.end,
        text.slice(edit.start, edit.start + length),
      );
  }
  return { text, recipients: [] };
}
