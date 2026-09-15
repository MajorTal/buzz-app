import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent,
  type InputEvent as ReactInputEvent,
  type CompositionEvent,
  type RefObject,
  type HTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import {
  editorSelection,
  editorText,
  setEditorSelection,
  sourceOffset,
  editAdjacentLink,
  normalizeTokenCaret,
  highlightEditorSelection,
  type ComposerInputElement,
} from "./composer-dom";
import styles from "./EditableInput.module.css";
import { messageLinkParts } from "./message-link-parts";
import {
  updatePlainLinks,
  type PlainLink,
  type ComposerEdit,
} from "./composer-link-edit";

export type EditorDecoration = {
  start: number;
  end: number;
  content: ReactNode;
  editAsText?: boolean;
};
export type EditableInputProps = Omit<
  HTMLAttributes<ComposerInputElement>,
  "onChange"
> & {
  ref: RefObject<ComposerInputElement | null>;
  value: string;
  disabled: boolean;
  placeholder: string;
  maxLength: number;
  onUndo(redo: boolean): void;
};

/** The DOM owns native editing/IME; React only owns the noneditable token contents. */
export function EditableInput({
  ref,
  value,
  disabled,
  placeholder,
  maxLength,
  onUndo,
  decorations,
  ...events
}: EditableInputProps & { decorations: readonly EditorDecoration[] }) {
  const element = useRef<ComposerInputElement>(null);
  const composing = useRef(false);
  const pendingEdit = useRef<ComposerEdit | undefined>(undefined);
  const linkEdits = useRef({
    text: value,
    links: [] as { start: number; end: number }[],
    plain: [] as PlainLink[],
  });
  const pendingSelection =
    useRef<ReturnType<typeof editorSelection>>(undefined);
  const current = useRef({ onUndo, maxLength, insertText });
  current.current = { onUndo, maxLength, insertText };
  const [revision, refresh] = useState(0);
  const [hosts, setHosts] = useState<
    { start: number; end: number; element: HTMLSpanElement }[]
  >([]);
  const shape = JSON.stringify(
    decorations.map(({ start, end, editAsText }) => [start, end, editAsText]),
  );
  useLayoutEffect(() => {
    const root = element.current;
    if (!root) return;
    let last = { start: 0, end: 0, backward: false };
    const selection = () => editorSelection(root) ?? last;
    Object.defineProperties(root, {
      value: {
        configurable: true,
        get: () => editorText(root),
        set: (text: string) => {
          root.textContent = text;
        },
      },
      selectionStart: { configurable: true, get: () => selection().start },
      selectionEnd: { configurable: true, get: () => selection().end },
      selectionDirection: {
        configurable: true,
        get: () => (selection().backward ? "backward" : "forward"),
      },
      disabled: {
        configurable: true,
        get: () => root.getAttribute("aria-disabled") === "true",
      },
      readOnly: {
        configurable: true,
        get: () =>
          root.getAttribute("aria-readonly") === "true" ||
          root.contentEditable === "false",
        set: (value: boolean) => {
          root.setAttribute("aria-readonly", String(value));
          root.contentEditable = String(!value && !root.disabled);
        },
      },
      setSelectionRange: {
        configurable: true,
        value: (start: number, end: number, direction?: string) => {
          pendingSelection.current = undefined;
          last = { start, end, backward: direction === "backward" };
          setEditorSelection(root, start, end, last.backward);
        },
      },
    });
    ref.current = root;
    const focus = () =>
      setEditorSelection(root, last.start, last.end, last.backward);
    root.addEventListener("focus", focus);
    const select = () => {
      if (!composing.current) normalizeTokenCaret(root);
      highlightEditorSelection(root);
      const next = editorSelection(root);
      if (!next) return;
      last = next;
      root.dispatchEvent(new Event("select"));
    };
    const before = (event: InputEvent) => {
      if (event.inputType.startsWith("history")) {
        event.preventDefault();
        current.current.onUndo(event.inputType === "historyRedo");
        return;
      }
      // Native edit commands (including WebKit's Delete menu action) can arrive
      // without keydown. Do not spend the first deletion on our caret marker.
      if (
        event.cancelable &&
        !event.isComposing &&
        !root.disabled &&
        !root.readOnly &&
        ["deleteContentBackward", "deleteContentForward"].includes(
          event.inputType,
        )
      ) {
        normalizeTokenCaret(root);
        const backward = event.inputType === "deleteContentBackward";
        if (editAdjacentLink(root, backward, false, false) === false) {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (root.selectionStart === root.selectionEnd) {
            const caret = root.selectionStart;
            const segments = new Intl.Segmenter(undefined, {
              granularity: "grapheme",
            }).segment(root.value);
            const character = segments.containing(backward ? caret - 1 : caret);
            if (!character) return;
            root.setSelectionRange(
              character.index,
              character.index + character.segment.length,
            );
          }
          current.current.insertText("", event.inputType);
          return;
        }
      }
      const target = event.getTargetRanges?.()[0];
      if (
        target &&
        root.contains(target.startContainer) &&
        root.contains(target.endContainer) &&
        !event.isComposing
      ) {
        const start = sourceOffset(
          root,
          target.startContainer,
          target.startOffset,
        );
        const end = sourceOffset(root, target.endContainer, target.endOffset);
        // Expose the browser's real deletion range to mention tracking.
        if (event.inputType.startsWith("delete") && start !== end)
          root.setSelectionRange(start, end);
      }
      if (
        event.data &&
        root.value.length -
          (root.selectionEnd - root.selectionStart) +
          event.data.length >
          current.current.maxLength
      )
        event.preventDefault();
      if (!event.defaultPrevented)
        pendingEdit.current = {
          text: root.value,
          start: root.selectionStart,
          end: root.selectionEnd,
        };
    };
    const openToken = (event: MouseEvent) => {
      const target =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-source]")
          : null;
      if (root.disabled || root.readOnly || !target || !root.contains(target))
        return;
      const index = [...root.childNodes].indexOf(target);
      const start = sourceOffset(root, root, index);
      const end = start + editorText(target).length;
      root.focus();
      root.setSelectionRange(start, end);
    };
    const placeAfterToken = (event: MouseEvent) => {
      if (root.disabled || root.readOnly) return;
      if (event.detail >= 3) {
        // Browsers stop paragraph selection at contenteditable=false islands.
        const position = root.selectionStart;
        const start =
          position === 0 ? 0 : root.value.lastIndexOf("\n", position - 1) + 1;
        const newline = root.value.indexOf("\n", position);
        root.setSelectionRange(
          start,
          newline < 0 ? root.value.length : newline + 1,
        );
        return;
      }
      const token =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-source]")
          : null;
      if (
        !token?.parentNode ||
        !root.contains(token) ||
        root.disabled ||
        root.readOnly ||
        event.shiftKey ||
        event.detail !== 1 ||
        !root.ownerDocument.getSelection()?.isCollapsed
      )
        return;
      const index = [...token.parentNode.childNodes].indexOf(token);
      const end =
        sourceOffset(root, token.parentNode, index) + editorText(token).length;
      root.focus();
      root.setSelectionRange(end, end);
    };
    root.addEventListener("click", placeAfterToken);
    root.addEventListener("dblclick", openToken);
    root.addEventListener("beforeinput", before, true);
    root.ownerDocument.addEventListener("selectionchange", select);
    return () => {
      root.removeEventListener("focus", focus);
      root.removeEventListener("click", placeAfterToken);
      root.removeEventListener("dblclick", openToken);
      root.removeEventListener("beforeinput", before, true);
      root.ownerDocument.removeEventListener("selectionchange", select);
      ref.current = null;
    };
  }, [ref]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only source/ranges rebuild the editing DOM; content changes stay in portals.
  useLayoutEffect(() => {
    const root = element.current;
    if (!root || composing.current) return;
    const previous = linkEdits.current;
    const plain = updatePlainLinks(
      previous.text,
      value,
      previous.links,
      previous.plain,
      pendingEdit.current,
    );
    pendingEdit.current = undefined;
    const visible = decorations.filter(
      (item) =>
        !item.editAsText ||
        !plain.some(
          (range) => item.start < range.end && item.end > range.start,
        ),
    );
    linkEdits.current = {
      text: value,
      plain,
      links: visible
        .filter((item) => item.editAsText)
        .map(({ start, end }) => ({ start, end })),
    };
    const selection = editorSelection(root);
    const fragment = root.ownerDocument.createDocumentFragment();
    const next = [];
    let offset = 0;
    const appendText = (text: string, afterToken: boolean) => {
      if (!afterToken) {
        fragment.append(root.ownerDocument.createTextNode(text));
        return;
      }
      // A real text position after an inline object gives WebKit a caret box.
      // editorText/source offsets exclude this rendering-only boundary character.
      const span = root.ownerDocument.createElement("span");
      span.dataset.editorText = "";
      span.append(root.ownerDocument.createTextNode(`\u200B${text}`));
      fragment.append(span);
    };
    for (const decoration of visible) {
      appendText(value.slice(offset, decoration.start), next.length > 0);
      const host = root.ownerDocument.createElement("span");
      host.contentEditable = "false";
      host.dataset.source = value.slice(decoration.start, decoration.end);
      if (decoration.editAsText) host.dataset.editAsText = "";
      host.className = styles.token ?? "";
      fragment.append(host);
      next.push({
        start: decoration.start,
        end: decoration.end,
        element: host,
      });
      offset = decoration.end;
    }
    appendText(value.slice(offset), next.length > 0);
    const tail = root.ownerDocument.createElement("br");
    tail.dataset.placeholder = "true";
    fragment.append(tail);
    root.replaceChildren(fragment);
    pendingSelection.current = selection;
    setHosts(next);
    // Only changes to source/ranges rebuild editing DOM; profile/icon updates stay in portals.
  }, [value, shape, revision]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: restore once after the portal hosts have committed their children.
  useLayoutEffect(() => {
    const root = element.current;
    const selection = pendingSelection.current;
    pendingSelection.current = undefined;
    // Portals now contain their rendered link/mention. Restore against its final
    // layout, without overriding a newer selection from a composer command.
    if (root && selection && root.ownerDocument.activeElement === root)
      setEditorSelection(
        root,
        Math.min(root.value.length, selection.start),
        Math.min(root.value.length, selection.end),
        selection.backward,
      );
    if (
      root?.hasAttribute("data-single-emoji") &&
      root.selectionStart === root.value.length &&
      root.selectionEnd === root.value.length
    )
      root.scrollTop = Math.max(0, root.scrollHeight - root.clientHeight);
  }, [hosts]);

  function insertText(text: string, inputType = "insertFromPaste") {
    const root = element.current;
    if (!root || root.disabled || root.readOnly) return;
    if (!composing.current) normalizeTokenCaret(root);
    text = text.replace(/\r\n?/g, "\n");
    if (
      root.value.length -
        (root.selectionEnd - root.selectionStart) +
        text.length >
      current.current.maxLength
    )
      return;
    const event = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType,
      data: text,
    });
    if (!root.dispatchEvent(event)) return;
    const selection = root.ownerDocument.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return;
    range.deleteContents();
    const node = root.ownerDocument.createTextNode(text);
    range.insertNode(node);
    selection.setBaseAndExtent(node, text.length, node, text.length);
    root.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType, data: text }),
    );
    return true;
  }
  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: rich content needs a contenteditable textbox. */}
      <div
        {...events}
        ref={element}
        role="textbox"
        aria-multiline="true"
        aria-label={placeholder}
        aria-disabled={disabled || undefined}
        contentEditable={!disabled}
        suppressContentEditableWarning
        tabIndex={disabled ? -1 : 0}
        className={styles.input}
        data-placeholder={placeholder}
        data-empty={!value || undefined}
        onPaste={(event) => {
          event.preventDefault();
          const root = element.current;
          if (!root || root.disabled || root.readOnly) return;
          let text = event.clipboardData.getData("text/plain");
          let link = false;
          messageLinkParts(text, undefined, (start, end) => {
            if (start === 0 && end === text.length) link = true;
          });
          const reuseSpace = link && root.value[root.selectionEnd] === " ";
          if (
            link &&
            !reuseSpace &&
            root.value.length -
              (root.selectionEnd - root.selectionStart) +
              text.length <
              maxLength
          )
            text += " ";
          if (insertText(text) && reuseSpace) {
            const caret = root.selectionStart + 1;
            root.setSelectionRange(caret, caret);
          }
        }}
        onCopy={(event) => {
          const root = element.current;
          if (!root) return;
          event.preventDefault();
          event.clipboardData.setData(
            "text/plain",
            root.value.slice(root.selectionStart, root.selectionEnd),
          );
        }}
        onCut={(event) => {
          const root = element.current;
          if (!root) return;
          event.preventDefault();
          event.clipboardData.setData(
            "text/plain",
            root.value.slice(root.selectionStart, root.selectionEnd),
          );
          insertText("", "deleteByCut");
        }}
        onDrop={(event) => {
          event.preventDefault();
        }}
        onInput={(event) => {
          const root = element.current;
          if (root && root.value.length > maxLength) {
            if (!composing.current) {
              root.value = value;
              root.setSelectionRange(value.length, value.length);
              refresh((value) => value + 1);
            }
            return;
          }
          events.onInput?.(event as ReactInputEvent<ComposerInputElement>);
          if (!composing.current && root?.value === value)
            refresh((revision) => revision + 1);
        }}
        onKeyDown={(event) => {
          if (
            composing.current ||
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229
          ) {
            events.onKeyDown?.(event as KeyboardEvent<ComposerInputElement>);
            return;
          }
          // A key can arrive before the native selectionchange notification.
          if (element.current) normalizeTokenCaret(element.current);
          if (
            (event.metaKey || event.ctrlKey) &&
            !event.altKey &&
            ["z", "y"].includes(event.key.toLowerCase())
          ) {
            event.preventDefault();
            onUndo(event.shiftKey || event.key.toLowerCase() === "y");
            return;
          }
          events.onKeyDown?.(event as KeyboardEvent<ComposerInputElement>);
          const root = element.current;
          if (
            root &&
            !root.disabled &&
            !root.readOnly &&
            !event.defaultPrevented &&
            ["ArrowLeft", "ArrowRight"].includes(event.key)
          )
            if (
              editAdjacentLink(
                root,
                event.key === "ArrowLeft",
                true,
                event.shiftKey,
              )
            ) {
              event.preventDefault();
              return;
            }
          if (
            root &&
            !event.defaultPrevented &&
            !event.altKey &&
            ["Home", "End"].includes(event.key)
          ) {
            event.preventDefault();
            const selection = editorSelection(root);
            const anchor = selection?.backward
              ? root.selectionEnd
              : root.selectionStart;
            const focus = selection?.backward
              ? root.selectionStart
              : root.selectionEnd;
            const end = root.value.indexOf("\n", focus);
            const next =
              event.key === "Home"
                ? event.metaKey || event.ctrlKey
                  ? 0
                  : focus === 0
                    ? 0
                    : root.value.lastIndexOf("\n", focus - 1) + 1
                : event.metaKey || event.ctrlKey || end < 0
                  ? root.value.length
                  : end;
            root.setSelectionRange(
              event.shiftKey ? Math.min(anchor, next) : next,
              event.shiftKey ? Math.max(anchor, next) : next,
              event.shiftKey && next < anchor ? "backward" : "forward",
            );
            return;
          }
          if (
            !event.defaultPrevented &&
            event.key === "Enter" &&
            !composing.current
          ) {
            event.preventDefault();
            insertText("\n", "insertLineBreak");
          }
        }}
        onCompositionStart={(event) => {
          composing.current = true;
          events.onCompositionStart?.(
            event as CompositionEvent<ComposerInputElement>,
          );
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          const root = element.current;
          if (root && root.value.length > maxLength) {
            root.value = value;
            root.setSelectionRange(value.length, value.length);
          }
          events.onCompositionEnd?.(
            event as CompositionEvent<ComposerInputElement>,
          );
          refresh((value) => value + 1);
        }}
      />
      {hosts.map((host) => {
        const decoration = decorations.find(
          (item) => item.start === host.start && item.end === host.end,
        );
        return (
          decoration &&
          createPortal(
            decoration.content,
            host.element,
            `${host.start}:${host.end}`,
          )
        );
      })}
    </>
  );
}
