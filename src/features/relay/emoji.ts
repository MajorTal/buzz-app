import type { EventData } from "./events.ts";

export type CustomEmoji = Readonly<{ shortcode: string; url: string }>;
export const EMOJI_SET = "buzz:custom-emoji";
const CUSTOM_REACTION = /^:([a-z0-9_-]{1,64}):$/i;
/** Reaction text stays small, while a valid custom token gets its two delimiters. */
export function validReactionContent(value: string): boolean {
  return [...value].length <= 64 || CUSTOM_REACTION.test(value);
}
export function normalizeShortcode(value: string): string | undefined {
  const code = value
    .trim()
    .replace(/^:+|:+$/g, "")
    .toLowerCase();
  return /^[a-z0-9_-]{1,64}$/.test(code) ? code : undefined;
}
/** Original URLs belong in events; display URLs are resolved by session.media. */
export function emojiTags(
  event: Pick<EventData, "tags">,
): readonly CustomEmoji[] {
  const entries = new Map<string, CustomEmoji>();
  for (const [name, value, url] of event.tags) {
    if (name !== "emoji" || !value || !url?.trim()) continue;
    const shortcode = normalizeShortcode(value);
    if (shortcode && !entries.has(shortcode))
      entries.set(shortcode, Object.freeze({ shortcode, url: url.trim() }));
  }
  return Object.freeze([...entries.values()]);
}
/** Share token boundaries with the renderer: never substitute inside HTTPS links. */
export const messageParts = (content: string) =>
  content.split(/(https:\/\/[^\s<>"`]+)/g);
const shortcodePattern = () => /(?=(:([a-zA-Z0-9_-]{1,64}):))/g;
export function* emojiMatches(
  content: string,
  entries: readonly CustomEmoji[],
) {
  let end = 0;
  for (const match of content.matchAll(shortcodePattern())) {
    if (match.index < end) continue;
    const emoji = entries.find(
      (entry) => entry.shortcode === match[2]?.toLowerCase(),
    );
    if (!emoji) continue;
    end = match.index + (match[1]?.length ?? 0);
    yield { emoji, start: match.index, end };
  }
}
export function referencedEmoji(content: string): string[] {
  return [
    ...new Set(
      messageParts(content).flatMap((part) =>
        part.startsWith("https://")
          ? []
          : [...part.matchAll(shortcodePattern())].map((m) =>
              (m[2] ?? "").toLowerCase(),
            ),
      ),
    ),
  ];
}
