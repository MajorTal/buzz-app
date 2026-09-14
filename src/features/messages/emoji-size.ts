import type { CustomEmoji } from "../relay/emoji";
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const emojiPresentation =
  /\p{Extended_Pictographic}|\p{Regional_Indicator}|[\d#*]\uFE0F?\u20E3/u;

function renderedEmoji(value: string, entries: readonly CustomEmoji[]): string {
  const custom = new Set(entries.map((entry) => entry.shortcode.toLowerCase()));
  return value.replace(
    /:([a-z0-9_-]{1,64}):/gi,
    (literal, shortcode: string) =>
      custom.has(shortcode.toLowerCase()) ? "😀" : literal,
  );
}

export function isUnicodeEmojiOnly(value: string) {
  const content = value.trim();
  if (!content || !emojiPresentation.test(content)) return false;
  for (const { segment } of graphemes.segment(content)) {
    if (/^\s+$/u.test(segment)) continue;
    if (!emojiPresentation.test(segment)) return false;
  }
  return true;
}

export function singleCustomEmoji(
  value: string,
  entries: readonly CustomEmoji[],
) {
  const match = /^:([a-z0-9_-]{1,64}):$/i.exec(value.trim());
  return match
    ? entries.find((entry) => entry.shortcode === match[1]?.toLowerCase())
    : undefined;
}

export function customEmojiOnlySpans(
  value: string,
  entries: readonly CustomEmoji[],
) {
  const byShortcode = new Map(
    entries.map((entry) => [entry.shortcode.toLowerCase(), entry]),
  );
  const spans: { emoji: CustomEmoji; start: number; end: number }[] = [];
  const pattern = /:([a-z0-9_-]{1,64}):/gi;
  let cursor = 0;
  for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
    if (!/^\s*$/u.test(value.slice(cursor, match.index))) return [];
    const emoji = byShortcode.get(match[1]?.toLowerCase() ?? "");
    if (!emoji) return [];
    spans.push({
      emoji,
      start: match.index,
      end: match.index + match[0].length,
    });
    cursor = match.index + match[0].length;
  }
  return spans.length && /^\s*$/u.test(value.slice(cursor)) ? spans : [];
}

export function leadingCustomEmojiSpans(
  value: string,
  entries: readonly CustomEmoji[],
) {
  const byShortcode = new Map(
    entries.map((entry) => [entry.shortcode.toLowerCase(), entry]),
  );
  const spans: { emoji: CustomEmoji; start: number; end: number }[] = [];
  const pattern = /:([a-z0-9_-]{1,64}):/iy;
  let cursor = 0;
  while (cursor < value.length) {
    pattern.lastIndex = cursor;
    const match = pattern.exec(value);
    if (!match) break;
    const emoji = byShortcode.get(match[1]?.toLowerCase() ?? "");
    if (!emoji) break;
    spans.push({ emoji, start: cursor, end: cursor + match[0].length });
    cursor += match[0].length;
  }
  return { spans, end: cursor };
}

export const isEmojiOnly = (
  value: string,
  entries: readonly CustomEmoji[] = [],
) => isUnicodeEmojiOnly(renderedEmoji(value, entries));

export function usesLargeEmojiPresentation(
  value: string,
  entries: readonly CustomEmoji[] = [],
) {
  return isEmojiOnly(value, entries);
}
