/**
 * Manual top-layer popovers paint above modal backdrops regardless of z-index.
 * Surfaces that promote themselves must step aside for a modal they are not in.
 */
export function behindActiveModal(element: Element) {
  // A nested confirmation hides or inerts its parent modal; skip those.
  const modal = [...document.querySelectorAll('[aria-modal="true"]')]
    .filter((candidate) => !candidate.closest('[inert], [aria-hidden="true"]'))
    .at(-1);
  return !!modal && !modal.contains(element);
}

/** Modal open/close need not move focus or the pointer; watch the document. */
export function observeModals(update: () => void) {
  const observer = new MutationObserver(update);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["aria-modal", "aria-hidden", "inert"],
  });
  return () => observer.disconnect();
}
