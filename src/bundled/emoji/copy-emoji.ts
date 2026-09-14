/** Preserve event-local shortcodes when copying selected custom emoji images. */
export function copyEmoji(event: ClipboardEvent) {
  if (event.defaultPrevented || !event.clipboardData) return;
  // Editable controls already copy their source text, including shortcodes.
  if (
    event
      .composedPath()
      .some(
        (node) =>
          node instanceof HTMLElement &&
          (node.matches("input, textarea") || node.isContentEditable),
      )
  )
    return;
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return;
  const fragments = Array.from({ length: selection.rangeCount }, (_, index) =>
    selection.getRangeAt(index).cloneContents(),
  );
  if (
    !fragments.some((fragment) =>
      fragment.querySelector("img[data-copy-emoji]"),
    )
  )
    return;
  const values = fragments.map((fragment) => {
    for (const emoji of fragment.querySelectorAll<HTMLImageElement>(
      "img[data-copy-emoji]",
    )) {
      emoji.replaceWith(
        document.createTextNode(emoji.dataset.copyEmoji ?? emoji.alt),
      );
    }
    return selectedText(fragment);
  });
  event.clipboardData.setData("text/plain", values.join("\n"));
  event.preventDefault();
}

// Walk the detached selection only: no hidden DOM insertion, image loads or
// changes to the user's selection. Preserve explicit breaks, blocks, and the
// tab/newline boundaries browsers use for table cells and rows.
function selectedText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node instanceof Element && node.tagName === "BR") return "\n";
  let text = "";
  let previous: Node | undefined;
  for (const child of node.childNodes) {
    const value = selectedText(child);
    const separator = previous && siblingSeparator(previous, child);
    if (separator === "\t") text += separator;
    else if (
      text &&
      value &&
      separator &&
      !text.endsWith(separator) &&
      !value.startsWith(separator)
    )
      text += separator;
    text += value;
    previous = child;
  }
  return text;
}

function siblingSeparator(previous: Node | undefined, current: Node) {
  const previousTag = previous instanceof Element ? previous.tagName : "";
  const currentTag = current instanceof Element ? current.tagName : "";
  if (/^(TD|TH)$/.test(previousTag) || /^(TD|TH)$/.test(currentTag))
    return "\t";
  if (
    /^(TR|THEAD|TBODY|TFOOT)$/.test(previousTag) ||
    /^(TR|THEAD|TBODY|TFOOT)$/.test(currentTag) ||
    /^(DIV|P|LI|OL|UL|SECTION|TABLE|BLOCKQUOTE|PRE|H[1-6])$/.test(
      previousTag,
    ) ||
    /^(DIV|P|LI|OL|UL|SECTION|TABLE|BLOCKQUOTE|PRE|H[1-6])$/.test(currentTag)
  )
    return "\n";
  return "";
}
