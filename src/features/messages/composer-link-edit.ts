type Range = { start: number; end: number };
export type PlainLink = Range;
export type ComposerEdit = Range & { text: string };

/** Keep partially deleted links plain while shifting their ranges with other draft edits. */
export function updatePlainLinks(
  previous: string,
  text: string,
  links: readonly Range[],
  plain: readonly PlainLink[],
  edit?: ComposerEdit,
): PlainLink[] {
  if (previous === text)
    return plain.filter(
      (range) =>
        !(
          edit?.text === previous &&
          edit.start <= range.start &&
          edit.end >= range.end
        ),
    );
  let start = 0;
  let end = previous.length;
  let insertedEnd = text.length;
  if (edit?.text === previous) {
    start = edit.start;
    end = edit.end;
    insertedEnd = end + text.length - previous.length;
  } else {
    // Programmatic edits and undo do not necessarily emit beforeinput.
    while (
      start < Math.min(previous.length, text.length) &&
      previous[start] === text[start]
    )
      start++;
    while (
      end > start &&
      insertedEnd > start &&
      previous[end - 1] === text[insertedEnd - 1]
    ) {
      end--;
      insertedEnd--;
    }
  }
  const delta = text.length - previous.length;
  const changed = links.filter(
    (link) =>
      end > start &&
      start < link.end &&
      end > link.start &&
      !(start <= link.start && end >= link.end),
  );
  return [...plain, ...changed].flatMap((range) => {
    if (start <= range.start && end >= range.end) return [];
    const next =
      end <= range.start
        ? { ...range, start: range.start + delta, end: range.end + delta }
        : start >= range.end
          ? range
          : {
              ...range,
              start: Math.min(range.start, start),
              end: Math.max(insertedEnd, range.end + delta),
            };
    return next.start < next.end ? [next] : [];
  });
}
