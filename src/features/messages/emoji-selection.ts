/** Shift+Arrow treats a rendered shortcode as one unit while preserving the anchor. */
export function extendEmojiSelection(
  spans: readonly { start: number; end: number }[],
  input: Pick<
    HTMLTextAreaElement,
    "selectionStart" | "selectionEnd" | "selectionDirection"
  >,
  key: "ArrowLeft" | "ArrowRight",
) {
  const {
    selectionStart: start,
    selectionEnd: end,
    selectionDirection,
  } = input;
  const left = key === "ArrowLeft";
  let anchor = selectionDirection === "backward" ? end : start;
  const focus = selectionDirection === "backward" ? start : end;
  const emoji = spans.find((span) =>
    left
      ? focus > span.start && focus <= span.end
      : focus >= span.start && focus < span.end,
  );
  if (!emoji) return;
  // A pointer can put the hidden text caret inside a displayed shortcode.
  if (start === end && anchor > emoji.start && anchor < emoji.end)
    anchor = left ? emoji.end : emoji.start;
  const next = left ? emoji.start : emoji.end;
  return {
    start: Math.min(anchor, next),
    end: Math.max(anchor, next),
    direction: next < anchor ? ("backward" as const) : ("forward" as const),
  };
}
