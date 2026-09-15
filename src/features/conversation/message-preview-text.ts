/** A compact excerpt: stop before an empty paragraph rather than clamping a blank line. */
export function messagePreviewText(content: string): string {
  const text = content.trim();
  const paragraphBreak = /\r?\n[^\S\r\n]*\r?\n/.exec(text);
  return paragraphBreak
    ? `${text.slice(0, paragraphBreak.index).trimEnd()}…`
    : text;
}
