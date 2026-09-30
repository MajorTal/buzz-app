/** Syntax only: no channel reads or work for ordinary typing. */
export function channelQuery(text: string, caret: number) {
  if (!Number.isInteger(caret) || caret < 0 || caret > text.length) return null;
  const before = text.slice(Math.max(0, caret - 160), caret);
  const match = before.match(/(?:^|[\s([{])#([^\s#[\](){}`<>\\]*)$/u);
  if (!match) return null;
  const query = match[1] ?? "";
  const start = caret - query.length - 1;
  if (start && !/[\s([{]/u.test(text[start - 1] ?? "")) return null;
  return { start, end: caret, query };
}
