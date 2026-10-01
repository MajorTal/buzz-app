// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { EditableInput } from "./EditableInput";
import type { ComposerInputElement } from "./composer-dom";
import { composerDOMFixture } from "./composer-testing";
import { composerMarkdown } from "./composer-markdown";
import { mentionDraft, type MentionDraft } from "./mention-draft";

composerDOMFixture();
afterEach(cleanup);

function mount(initial: string | MentionDraft = "") {
  const ref = createRef<ComposerInputElement>();
  let draft: MentionDraft = mentionDraft(initial);
  const text = draft.text;
  function Editor() {
    const [value, setValue] = useState(draft);
    return (
      <EditableInput
        ref={ref}
        draft={value}
        value={value.text}
        disabled={false}
        placeholder="Draft"
        maxLength={16000}
        // Explicit recipients render as mention tokens, as in RichComposerInput.
        decorationsFor={(current) =>
          current.recipients.map(({ start, end, name }) => ({
            start,
            end,
            content: <span data-mention>@{name}</span>,
          }))
        }
        onFormatsChange={() => {}}
        onDraftChange={(next) => {
          draft = next;
          setValue(next);
        }}
      />
    );
  }
  render(<Editor />, { reactStrictMode: true });
  const input = ref.current;
  if (!input) throw new Error("Editor did not mount");
  act(() => {
    input.focus();
    input.setSelectionRange(text.length, text.length);
  });
  return {
    input,
    user: userEvent.setup(),
    markdown: () => composerMarkdown(draft),
    draft: () => draft,
  };
}

/** Exercise ProseMirror's actual MutationObserver/readDOMChange seam, including
 * marksAcross on deletion. This is not a claim about native WebKit keystrokes. */
async function deleteCodeTail(input: ComposerInputElement, count = 1) {
  const previous = input.value;
  act(() => {
    input.focus();
    fireEvent(
      input,
      new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "deleteContentBackward",
      }),
    );
    const text = input.querySelector("code")?.firstChild;
    if (!(text instanceof Text)) throw new Error("Code text did not mount");
    const selection = document.getSelection();
    if (!selection) throw new Error("DOM selection unavailable");
    const end = text.length - count;
    if (end) {
      text.deleteData(end, count);
      selection.collapse(text, end);
    } else {
      const paragraph = input.querySelector("p");
      if (!paragraph) throw new Error("Paragraph did not mount");
      paragraph.replaceChildren(document.createElement("br"));
      selection.collapse(paragraph, 0);
    }
  });
  await waitFor(() => expect(input).toHaveValue(previous.slice(0, -count)));
}

it("keeps explicit code mode through DOM deletions, but clears it after the last character", async () => {
  const h = mount();
  act(() => h.input.toggleFormat("code"));
  await h.user.keyboard("abc");
  await deleteCodeTail(h.input);
  await h.user.keyboard("d");
  expect(h.markdown()).toBe("`abd`");
  await deleteCodeTail(h.input);
  expect(h.markdown()).toBe("`ab`");
  act(() => h.input.undo(false));
  expect(h.markdown()).toBe("`abd`");
  act(() => h.input.undo(true));
  expect(h.markdown()).toBe("`ab`");
  await deleteCodeTail(h.input, 2);
  await h.user.keyboard("plain");
  expect(h.markdown()).toBe("plain");
});

it.each(["typed", "explicit-off"])(
  "does not reenable code after deletion in %s mode",
  async (mode) => {
    const h = mount();
    if (mode === "typed") await h.user.keyboard("`abc`");
    else {
      act(() => h.input.toggleFormat("code"));
      await h.user.keyboard("abc");
      act(() => h.input.toggleFormat("code"));
    }
    await deleteCodeTail(h.input);
    await h.user.keyboard("d");
    expect(h.markdown()).toBe("`ab`d");
  },
);

it("does not borrow backticks inside existing rich code for a newly typed span", async () => {
  const h = mount("`");
  act(() => {
    h.input.setSelectionRange(0, 1);
    h.input.toggleFormat("code");
    h.input.setSelectionRange(1, 1);
  });
  await h.user.keyboard(" `next`!");
  expect(h.input.querySelectorAll("code")).toHaveLength(2);
  expect(h.input.querySelectorAll("code")[1]).toHaveTextContent("next");
  expect(h.input).toHaveValue("` next!");
  expect(h.markdown()).toBe("`` ` `` `next`!");
});

it("clearing all code and reentering a code edge leaves subsequent prose unmarked", async () => {
  const h = mount();
  act(() => h.input.toggleFormat("code"));
  await h.user.keyboard("abc");
  act(() => h.input.setSelectionRange(3, 3));
  await h.user.keyboard("plain");
  expect(h.markdown()).toBe("`abc`plain");
  act(() => {
    h.input.setSelectionRange(0, h.input.value.length);
    h.input.insertText("");
  });
  await h.user.keyboard("outside");
  expect(h.markdown()).toBe("outside");
});

it.each([
  ["bullet_list", "ul", "-"],
  ["ordered_list", "ol", "1."],
] as const)(
  "edits %s through continuation, indent/outdent, exit, undo and persistence",
  async (format, tag, marker) => {
    const h = mount("one\ntwo");
    act(() => {
      h.input.setSelectionRange(0, 7);
      h.input.toggleFormat(format);
    });
    expect(h.input.querySelectorAll(`${tag} > li`)).toHaveLength(2);
    act(() => h.input.setSelectionRange(7, 7));
    await h.user.keyboard("{Shift>}{Enter}{/Shift}three");
    expect(h.input.querySelectorAll(`${tag} > li`)).toHaveLength(3);
    await h.user.keyboard("{Tab}");
    expect(h.input.querySelector(`${tag} ${tag}`)).not.toBeNull();
    await h.user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(h.input.querySelector(`${tag} ${tag}`)).toBeNull();
    await h.user.keyboard("{Shift>}{Enter}{Enter}{/Shift}outside");
    expect(h.input.querySelector(":scope > p")).toHaveTextContent("outside");
    const wire =
      marker === "-"
        ? "- one\n- two\n- three\n\noutside"
        : "1. one\n2. two\n3. three\n\noutside";
    expect(h.markdown()).toBe(wire);
    const saved = JSON.parse(JSON.stringify(h.draft()));
    act(() => h.input.reset(saved));
    expect(h.input.querySelectorAll(`${tag} > li`)).toHaveLength(3);
    expect(h.markdown()).toBe(wire);
  },
);

it("switches an existing list in place, including a nested list's first item", async () => {
  const h = mount("one\ntwo\nthree");
  act(() => {
    h.input.setSelectionRange(0, 13);
    h.input.toggleFormat("bullet_list");
    h.input.setSelectionRange(7, 7);
  });
  await h.user.keyboard("{Tab}");
  expect(h.input.querySelector("ul ul")).not.toBeNull();
  act(() => h.input.toggleFormat("ordered_list"));
  expect(h.input.querySelector("ul > li > ol > li")).toHaveTextContent("two");
  expect(h.input.querySelectorAll(":scope > ul > li")).toHaveLength(2);
  act(() => h.input.undo(false));
  expect(h.input.querySelector("ul ul")).not.toBeNull();
  act(() => h.input.undo(true));
  expect(h.input.querySelector("ul > li > ol > li")).toHaveTextContent("two");
});

it.each(["blockquote", "code_block"] as const)(
  "exits %s and clears its structure with select-all deletion",
  async (format) => {
    const h = mount("one");
    act(() => h.input.toggleFormat(format));
    await h.user.keyboard(
      "{Shift>}{Enter}{/Shift}two{Shift>}{Enter}{Enter}{/Shift}outside",
    );
    expect(h.input.querySelector(":scope > p")).toHaveTextContent("outside");
    expect(h.markdown()).toBe(
      format === "blockquote"
        ? "> one\n> two\n\noutside"
        : "```\none\ntwo\n```\n\noutside",
    );
    await h.user.keyboard("{Control>}a{/Control}{Backspace}");
    expect(h.input).toHaveValue("");
    expect(h.input.querySelector("pre, blockquote")).toBeNull();
    await h.user.keyboard("plain");
    expect(h.markdown()).toBe("plain");
  },
);

it("switches a nested bullet to its ordered ancestor's type without outdenting", async () => {
  const h = mount("one\ntwo\nthree");
  act(() => {
    h.input.setSelectionRange(0, 13);
    h.input.toggleFormat("ordered_list");
    h.input.setSelectionRange(7, 7);
  });
  await h.user.keyboard("{Tab}");
  act(() => h.input.toggleFormat("bullet_list"));
  expect(h.input.querySelector("ol ul")).not.toBeNull();
  act(() => h.input.toggleFormat("ordered_list"));
  expect(h.input.querySelector("ol ol > li")).toHaveTextContent("two");
  expect(h.input.querySelectorAll(":scope > ol > li")).toHaveLength(2);
});

it.each([true, false])(
  "continues a list with explicit Bold=%s typing mode",
  async (enabled) => {
    const h = mount("one");
    act(() => {
      h.input.setSelectionRange(0, 3);
      h.input.toggleFormat("bold");
      h.input.toggleFormat("bullet_list");
      h.input.setSelectionRange(3, 3);
      if (!enabled) h.input.toggleFormat("bold");
    });
    await h.user.keyboard("{Shift>}{Enter}{/Shift}two");
    const item = h.input.querySelectorAll("li")[1];
    if (!item) throw new Error("List did not split");
    expect(!!item.querySelector("strong")).toBe(enabled);
  },
);

const imp = { pubkey: "a".repeat(64), name: "Imp" };
const jitter = { pubkey: "b".repeat(64), name: "Jitter" };
// Display names with a space are one token too; the label never splits.
const maryJane = { pubkey: "c".repeat(64), name: "Mary Jane" };
const mattToohey = { pubkey: "d".repeat(64), name: "Matt Toohey" };
/** Every `@Name` of these people in the text is an explicit, resolved recipient. */
function mentioned(text: string): MentionDraft {
  return {
    text,
    recipients: [imp, jitter, maryJane, mattToohey].flatMap((recipient) => {
      const start = text.indexOf(`@${recipient.name}`);
      return start < 0
        ? []
        : [{ ...recipient, start, end: start + recipient.name.length + 1 }];
    }),
  };
}
const selection = (input: ComposerInputElement) =>
  [input.selectionStart, input.selectionEnd, input.selectionDirection] as const;
/** Arrow keys are deliberately low-level: user-event cannot extend a selection. */
const shiftArrow = (
  input: ComposerInputElement,
  key: "ArrowLeft" | "ArrowRight",
) =>
  act(() => {
    fireEvent.keyDown(input, { key: "Shift", keyCode: 16, shiftKey: true });
    fireEvent.keyDown(input, {
      key,
      code: key,
      keyCode: key === "ArrowLeft" ? 37 : 39,
      shiftKey: true,
    });
  });

it.each([jitter.name, maryJane.name])(
  "extends a backward selection over @%s before it and keeps the anchor",
  (name) => {
    const text = `@Imp say hello to @${name} `;
    const mention = text.lastIndexOf("@");
    const h = mount(mentioned(text));
    expect(h.input.querySelectorAll("[data-mention]")).toHaveLength(2);
    act(() => h.input.setSelectionRange(text.length, text.length));
    // The browser itself answers the first Shift+Left by selecting the trailing
    // space. Model that native result, then let the editor handle the second.
    act(() => {
      const space = h.input.querySelector("p")?.lastChild;
      if (!(space instanceof Text)) throw new Error("Missing trailing text");
      document.getSelection()?.setBaseAndExtent(space, 1, space, 0);
    });
    shiftArrow(h.input, "ArrowLeft");
    expect(selection(h.input)).toEqual([mention, text.length, "backward"]);
    expect(text.slice(mention)).toBe(`@${name} `);
    expect(h.input.selectionEnd - h.input.selectionStart).toBeLessThanOrEqual(
      h.input.value.length,
    );
    shiftArrow(h.input, "ArrowRight");
    expect(selection(h.input)).toEqual([
      text.length - 1,
      text.length,
      "backward",
    ]);
  },
);

it.each([
  [
    "after a mention with no trailing space",
    "@Imp say hello to @Jitter",
    25,
    "ArrowLeft",
    [18, 25, "backward"],
  ],
  [
    "before a mention",
    "@Imp say hello to @Jitter ",
    18,
    "ArrowRight",
    [18, 25, "forward"],
  ],
  [
    "after the mention at the start",
    "@Imp say hello to @Jitter ",
    4,
    "ArrowLeft",
    [0, 4, "backward"],
  ],
  [
    "the document start",
    "@Imp say hello to @Jitter ",
    0,
    "ArrowRight",
    [0, 4, "forward"],
  ],
  ["the document end", "hello @Jitter", 13, "ArrowLeft", [6, 13, "backward"]],
  [
    "after a two-word mention with no trailing space",
    "@Imp say hello to @Mary Jane",
    28,
    "ArrowLeft",
    [18, 28, "backward"],
  ],
  [
    "before a two-word mention",
    "@Imp say hello to @Mary Jane ",
    18,
    "ArrowRight",
    [18, 28, "forward"],
  ],
  [
    "after the two-word mention at the start",
    "@Mary Jane says hello",
    10,
    "ArrowLeft",
    [0, 10, "backward"],
  ],
  [
    "the document start before a two-word mention",
    "@Mary Jane says hello",
    0,
    "ArrowRight",
    [0, 10, "forward"],
  ],
  [
    "the document end after a two-word mention",
    "hello @Mary Jane",
    16,
    "ArrowLeft",
    [6, 16, "backward"],
  ],
] as const)(
  "Shift+Arrow from %s selects the whole mention",
  (_, text, caret, key, expected) => {
    const h = mount(mentioned(text));
    act(() => h.input.setSelectionRange(caret, caret));
    shiftArrow(h.input, key);
    expect(selection(h.input)).toEqual(expected);
  },
);

it.each([
  [
    "extends a forward selection from prose over a mention",
    "@Imp say hello to @Jitter ",
    16,
    18,
    "forward",
    "ArrowRight",
    [16, 25, "forward"],
  ],
  [
    "extends a backward selection from prose over a mention",
    "@Imp say hello to @Jitter ",
    4,
    8,
    "backward",
    "ArrowLeft",
    [0, 8, "backward"],
  ],
  [
    "shrinks a forward selection off a mention",
    "@Imp say hello to @Jitter ",
    18,
    25,
    "forward",
    "ArrowLeft",
    [18, 18, "forward"],
  ],
  [
    "shrinks a backward selection off a mention",
    "@Imp say hello to @Jitter ",
    18,
    26,
    "backward",
    "ArrowRight",
    [25, 26, "backward"],
  ],
  [
    "extends a forward selection from prose over a two-word mention",
    "@Imp say hello to @Mary Jane ",
    16,
    18,
    "forward",
    "ArrowRight",
    [16, 28, "forward"],
  ],
  [
    "shrinks a forward selection off a two-word mention",
    "@Imp say hello to @Mary Jane ",
    18,
    28,
    "forward",
    "ArrowLeft",
    [18, 18, "forward"],
  ],
  [
    "shrinks a backward selection off a two-word mention",
    "@Imp say hello to @Mary Jane ",
    18,
    29,
    "backward",
    "ArrowRight",
    [28, 29, "backward"],
  ],
  // Two two-word mentions one space apart: the browser selects that space,
  // then the editor extends over the first mention in the same direction.
  [
    "extends a backward selection over the first of two two-word mentions",
    "@Mary Jane @Matt Toohey ",
    10,
    24,
    "backward",
    "ArrowLeft",
    [0, 24, "backward"],
  ],
  [
    "extends a forward selection over the second of two two-word mentions",
    "@Mary Jane @Matt Toohey ",
    0,
    11,
    "forward",
    "ArrowRight",
    [0, 23, "forward"],
  ],
] as const)("%s", (_, text, start, end, direction, key, expected) => {
  const h = mount(mentioned(text));
  act(() => h.input.setSelectionRange(start, end, direction));
  expect(selection(h.input)).toEqual([start, end, direction]);
  shiftArrow(h.input, key);
  expect(selection(h.input)).toEqual(expected);
});

it("retains the native caret after replacing text with an unchanged suffix", async () => {
  const h = mount(":unknown:");
  act(() => {
    const text = h.input.querySelector("p")?.firstChild;
    if (!(text instanceof Text)) throw new Error("Missing native text node");
    text.data = ":nosource:";
    document.getSelection()?.collapse(text, text.length);
  });
  await waitFor(() => expect(h.input).toHaveValue(":nosource:"));
  expect(h.input.selectionStart).toBe(10);
  expect(h.input.selectionEnd).toBe(10);
});

/** A character the host's native text-input path can commit as typed text for
 * a caret or function key. The desktop build committed U+001D on a Right
 * Arrow press: a key's raw keyboard-layout translation is a C0 control (the
 * arrows are U+001C through U+001F), which WebKit does not strip from a key
 * event's text. AppKit's own NSEvent carries the private-use function-key
 * character instead (NSUpArrowFunctionKey U+F700 onwards), which WebKit strips
 * and the guard refuses as well. DEL and the C1 controls are as glyphless. */
const controlKeys = [
  ["Left Arrow's layout translation U+001C", "\u001C"],
  ["Right Arrow's layout translation U+001D", "\u001D"],
  ["Up Arrow's layout translation U+001E", "\u001E"],
  ["Down Arrow's layout translation U+001F", "\u001F"],
  ["Home's layout translation U+0001", "\u0001"],
  ["End's layout translation U+0004", "\u0004"],
  ["Page Up's layout translation U+000B", "\u000B"],
  ["Page Down's layout translation U+000C", "\u000C"],
  ["DEL U+007F", "\u007F"],
  ["the first C1 control U+0080", "\u0080"],
  ["the last C1 control U+009F", "\u009F"],
  ["Up Arrow's function-key character U+F700", "\uF700"],
  ["Down Arrow's function-key character U+F701", "\uF701"],
  ["Left Arrow's function-key character U+F702", "\uF702"],
  ["Right Arrow's function-key character U+F703", "\uF703"],
  ["F1's function-key character U+F704", "\uF704"],
  ["Home's function-key character U+F729", "\uF729"],
  ["End's function-key character U+F72B", "\uF72B"],
  ["Page Up's function-key character U+F72C", "\uF72C"],
  ["Page Down's function-key character U+F72D", "\uF72D"],
] as const;
/** Right Arrow committed as text in both forms the host can produce. Each
 * carries a label because neither character has a glyph: interpolated raw
 * into a case name or an assertion message they read identically. */
const rightArrowCharacters = [
  ["Right Arrow's layout translation U+001D", "\u001D"],
  ["Right Arrow's function-key character U+F703", "\uF703"],
] as const;
const caretKeys = [
  "ArrowRight",
  "ArrowLeft",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "Shift",
  "Meta",
  "Escape",
] as const;
/** A caret keydown as WebKit reports it when the key event's text is the key's
 * layout translation: `key` is the control character while `code` and the
 * legacy key code still name the key. */
const mangledCaretKeys = {
  ArrowLeft: { key: "\u001C", keyCode: 37 },
  ArrowRight: { key: "\u001D", keyCode: 39 },
  ArrowUp: { key: "\u001E", keyCode: 38 },
  ArrowDown: { key: "\u001F", keyCode: 40 },
  Home: { key: "\u0001", keyCode: 36 },
  End: { key: "\u0004", keyCode: 35 },
  PageUp: { key: "\u000B", keyCode: 33 },
  PageDown: { key: "\u000C", keyCode: 34 },
} as const;
type MangledCaretKey = keyof typeof mangledCaretKeys;
function mangled(
  code: MangledCaretKey,
  init: Omit<KeyboardEventInit, "key" | "code" | "keyCode"> = {},
) {
  return { ...mangledCaretKeys[code], code, ...init };
}

/** Everything the composer persists or shows: the draft with its document
 * snapshot, and the rendered DOM. */
function snapshot(h: ReturnType<typeof mount>) {
  return { draft: JSON.stringify(h.draft()), html: h.input.innerHTML };
}

/** Presses a caret key: through user-event where it models the key, and as a
 * bare keydown/keyup pair for Home and End, whose caret movement jsdom does
 * not implement on a contenteditable element. */
async function press(h: ReturnType<typeof mount>, key: string) {
  if (key !== "Home" && key !== "End") {
    await h.user.keyboard(`{${key}}`);
    return;
  }
  const target = document.activeElement ?? h.input;
  fireEvent.keyDown(target, { key, code: key });
  fireEvent.keyUp(target, { key, code: key });
}

/** The browser's own insertion of text the host committed: a cancelable
 * beforeinput, then the DOM change ProseMirror observes. With `beforeinput`
 * false the change arrives as an uncancelable or unannounced one would.
 * Returns whether the DOM was changed. */
function nativeInsert(
  input: ComposerInputElement,
  text: string,
  beforeinput = true,
) {
  let inserted = false;
  act(() => {
    input.focus();
    if (
      beforeinput &&
      !input.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: text,
        }),
      )
    )
      return;
    const selection = document.getSelection();
    const focus = selection?.focusNode;
    if (!selection || !focus) throw new Error("DOM selection unavailable");
    let node: Text;
    let offset = selection.focusOffset;
    if (focus instanceof Text) node = focus;
    else {
      node = document.createTextNode("");
      focus.insertBefore(node, focus.childNodes[offset] ?? null);
      offset = 0;
    }
    node.insertData(offset, text);
    selection.collapse(node, offset + text.length);
    inserted = true;
  });
  return inserted;
}

/** jsdom has no `Selection.modify`. This stand-in records the browser caret
 * motion the composer asks for and performs the moves it can without layout,
 * so the editor's selection sync after the move is exercised too: a character
 * within a text node, a line as the editor's text between newlines at the
 * nearest column (the document's end past the last line, as in a browser),
 * and the document boundaries. A focus at an element boundary, as ProseMirror
 * places it after select-all, first resolves into the text ending there. */
function stubSelectionModify() {
  const texts = (node: Node) => {
    if (node instanceof Text) return [node];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const found: Text[] = [];
    while (walker.nextNode()) found.push(walker.currentNode as Text);
    return found;
  };
  const resolve = (node: Node, offset: number): [Text, number] | null => {
    if (node instanceof Text) return [node, offset];
    const before = node.childNodes[offset - 1];
    const after = node.childNodes[offset];
    const end = before && texts(before).at(-1);
    if (end) return [end, end.length];
    const start = after && texts(after)[0];
    return start ? [start, 0] : null;
  };
  const modify = vi.fn(function (
    this: Selection,
    alter: string,
    direction: string,
    granularity: string,
  ) {
    const focus = this.focusNode && resolve(this.focusNode, this.focusOffset);
    const root = focus?.[0].parentElement?.closest('[role="textbox"]');
    if (!focus || !root) return;
    const [text, offset] = focus;
    const forward = direction === "right" || direction === "forward";
    let target: [Text, number] | undefined;
    if (granularity === "character")
      target = [
        text,
        Math.max(0, Math.min(text.length, offset + (forward ? 1 : -1))),
      ];
    else if (granularity === "line" || granularity === "documentboundary") {
      const all = texts(root);
      const value = all.map((node) => node.data).join("");
      const at = all
        .slice(0, all.indexOf(text))
        .reduce((sum, node) => sum + node.length, offset);
      const lineStart = (pos: number) =>
        pos ? value.lastIndexOf("\n", pos - 1) + 1 : 0;
      const lineEnd = (pos: number) => {
        const end = value.indexOf("\n", pos);
        return end === -1 ? value.length : end;
      };
      let next: number;
      if (granularity === "documentboundary") next = forward ? value.length : 0;
      else {
        const start = lineStart(at);
        const end = lineEnd(at);
        if (forward)
          next =
            end === value.length
              ? end
              : Math.min(end + 1 + (at - start), lineEnd(end + 1));
        else
          next =
            start === 0
              ? 0
              : Math.min(lineStart(start - 1) + (at - start), start - 1);
      }
      for (const node of all) {
        if (next <= node.length) {
          target = [node, next];
          break;
        }
        next -= node.length;
      }
    }
    if (!target) return;
    if (alter === "extend") this.extend(...target);
    else this.collapse(...target);
  });
  Object.defineProperty(Selection.prototype, "modify", {
    configurable: true,
    value: modify,
  });
  return modify;
}
function setPlatform(platform: string) {
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    value: platform,
  });
}
afterEach(() => {
  Reflect.deleteProperty(Selection.prototype, "modify");
  Reflect.deleteProperty(navigator, "platform");
});

it.each(controlKeys)(
  "refuses %s committed as text at both native seams",
  async (_label, character) => {
    const h = mount("abc");
    const before = snapshot(h);
    // The cancelable seam: the DOM never changes.
    expect(nativeInsert(h.input, character)).toBe(false);
    expect(snapshot(h)).toEqual(before);
    // The observed seam: an insertion that arrived anyway is redrawn away.
    expect(nativeInsert(h.input, character, false)).toBe(true);
    await waitFor(() => expect(h.input.textContent).toBe("abc"));
    expect(snapshot(h)).toEqual(before);
    expect(h.input.selectionStart).toBe(3);
    expect(h.input.selectionEnd).toBe(3);
    await h.user.keyboard("d");
    expect(h.input).toHaveValue("abcd");
    expect(h.markdown()).toBe("abcd");
  },
);

it.each([
  ["a tab", "\t", "abc\t"],
  ["a newline", "\n", "abc\n"],
  // ProseMirror's DOM parser reads a carriage return as a newline.
  ["a carriage return", "\r", "abc\n"],
  // No key yields a control character beside real text; such text is left
  // alone rather than reshaped under the native selection that describes it.
  ["a control character beside real text, whole", "a\u001D", "abca\u001D"],
])("still inserts %s committed as text", async (_label, text, value) => {
  const h = mount("abc");
  expect(nativeInsert(h.input, text)).toBe(true);
  await waitFor(() => expect(h.input).toHaveValue(value));
  expect(h.draft().text).toBe(value);
  expect(h.input.selectionStart).toBe(value.length);
  expect(h.input.selectionEnd).toBe(value.length);
});

it.each([
  ["after text", async (h: ReturnType<typeof mount>) => h.input.value],
  [
    "on an empty trailing paragraph",
    async (h: ReturnType<typeof mount>) => {
      await h.user.keyboard("{Shift>}{Enter}{/Shift}");
      expect(h.input).toHaveValue("abc\n");
      return h.input.value;
    },
  ],
  [
    "directly after a mention chip",
    async (h: ReturnType<typeof mount>) => {
      act(() =>
        h.input.insertText("", { pubkey: "a".repeat(64), name: "Honey" }),
      );
      expect(h.input).toHaveValue("abc@Honey ");
      act(() => h.input.setSelectionRange(9, 9));
      return "abc@Honey ";
    },
  ],
  [
    "inside a list item",
    async (h: ReturnType<typeof mount>) => {
      await h.user.keyboard("{Shift>}{Enter}{/Shift}");
      act(() => h.input.toggleFormat("bullet_list"));
      await h.user.keyboard("item");
      expect(h.input.querySelector("ul > li")).toHaveTextContent("item");
      return h.input.value;
    },
  ],
])(
  "keeps the document unchanged by caret keys %s, and by a Right Arrow committed as text in either form",
  async (_context, setup) => {
    const h = mount("abc");
    const value = await setup(h);
    const before = snapshot(h);
    const start = h.input.selectionStart;
    for (const key of caretKeys) {
      await press(h, key);
      expect(snapshot(h), key).toEqual(before);
      expect(h.input.selectionStart, key).toBe(h.input.selectionEnd);
    }
    for (const [label, character] of rightArrowCharacters) {
      act(() => h.input.setSelectionRange(start, start));
      expect(nativeInsert(h.input, character), label).toBe(false);
      expect(snapshot(h), label).toEqual(before);
      expect(nativeInsert(h.input, character, false), label).toBe(true);
      await waitFor(() =>
        expect(h.input.textContent, label).not.toContain(character),
      );
      expect(snapshot(h), label).toEqual(before);
    }
    expect(h.input).toHaveValue(value);
    expect(h.draft().recipients.map((item) => item.name)).toEqual(
      value.includes("@Honey") ? ["Honey"] : [],
    );
  },
);

it("moves the caret for a Right Arrow reported as U+001D instead of typing it", () => {
  const h = mount("abc");
  const modify = stubSelectionModify();
  const before = snapshot(h);
  act(() => h.input.setSelectionRange(1, 1));
  let prevented = false;
  act(() => {
    prevented = !fireEvent.keyDown(h.input, mangled("ArrowRight"));
  });
  expect(prevented).toBe(true);
  expect(modify).toHaveBeenCalledExactlyOnceWith("move", "right", "character");
  expect(h.input.selectionStart).toBe(2);
  expect(h.input.selectionEnd).toBe(2);
  act(() => {
    prevented = !fireEvent.keyDown(h.input, mangled("ArrowLeft"));
  });
  expect(prevented).toBe(true);
  expect(modify).toHaveBeenLastCalledWith("move", "left", "character");
  expect(h.input.selectionStart).toBe(1);
  // Shift extends from the same anchor, as the named key would.
  act(() => {
    fireEvent.keyDown(h.input, mangled("ArrowRight", { shiftKey: true }));
  });
  expect(modify).toHaveBeenLastCalledWith("extend", "right", "character");
  expect(h.input.selectionStart).toBe(1);
  expect(h.input.selectionEnd).toBe(2);
  expect(snapshot(h)).toEqual(before);
});

it("steps over a mention chip for an arrow reported as a control character, as the named key does", () => {
  const h = mount("abc");
  const modify = stubSelectionModify();
  act(() => h.input.insertText("", { pubkey: "a".repeat(64), name: "Honey" }));
  expect(h.input).toHaveValue("abc@Honey ");
  for (const [code, from, to] of [
    ["ArrowRight", 3, 9],
    ["ArrowLeft", 9, 3],
  ] as const) {
    act(() => h.input.setSelectionRange(from, from));
    let prevented = false;
    act(() => {
      prevented = !fireEvent.keyDown(h.input, mangled(code));
    });
    expect(prevented, code).toBe(true);
    expect(h.input.selectionStart, code).toBe(to);
    expect(h.input.selectionEnd, code).toBe(to);
  }
  expect(modify).not.toHaveBeenCalled();
  expect(h.input).toHaveValue("abc@Honey ");
  expect(h.draft().recipients.map((item) => item.name)).toEqual(["Honey"]);
});

/** The editor selection's anchor and head in source offsets, with the text
 * between them. `selectionDirection` reads the editor's own anchor and head,
 * so a backward range here is a TextSelection that kept its direction: an
 * AllSelection always reports its anchor at the start. */
function range(h: ReturnType<typeof mount>) {
  const { selectionStart: start, selectionEnd: end } = h.input;
  const backward = h.input.selectionDirection === "backward";
  return {
    anchor: backward ? end : start,
    head: backward ? start : end,
    text: h.input.value.slice(start, end),
  };
}

it("keeps a Shift move reported as a control character directional when it reaches both document edges, so reversing it shrinks the selection", () => {
  setPlatform("MacIntel");
  const h = mount("abc\ndef");
  const modify = stubSelectionModify();
  const before = snapshot(h);
  expect(range(h)).toEqual({ anchor: 7, head: 7, text: "" });
  // Cmd+Shift+Up from the end selects everything, anchored at the end: not
  // the AllSelection a DOM select-all becomes, whose anchor is the start.
  act(() => {
    fireEvent.keyDown(
      h.input,
      mangled("ArrowUp", { metaKey: true, shiftKey: true }),
    );
  });
  expect(modify).toHaveBeenLastCalledWith(
    "extend",
    "backward",
    "documentboundary",
  );
  expect(range(h)).toEqual({ anchor: 7, head: 0, text: "abc\ndef" });
  // Shift+Down then shrinks the selection from its head, and again back to
  // the anchor, instead of extending from the start.
  act(() => {
    fireEvent.keyDown(h.input, mangled("ArrowDown", { shiftKey: true }));
  });
  expect(modify).toHaveBeenLastCalledWith("extend", "forward", "line");
  expect(range(h)).toEqual({ anchor: 7, head: 4, text: "def" });
  act(() => {
    fireEvent.keyDown(h.input, mangled("ArrowDown", { shiftKey: true }));
  });
  expect(range(h)).toEqual({ anchor: 7, head: 7, text: "" });
  expect(snapshot(h)).toEqual(before);
});

it("shrinks a select-all by one character for a Shift+Left reported as a control character, instead of collapsing it", () => {
  setPlatform("MacIntel");
  const h = mount("abc");
  const modify = stubSelectionModify();
  const before = snapshot(h);
  act(() => {
    fireEvent.keyDown(h.input, { key: "a", code: "KeyA", metaKey: true });
  });
  expect(range(h)).toEqual({ anchor: 0, head: 3, text: "abc" });
  // The whole-document selection's head sits after the paragraph, not after
  // an inline leaf: the move is the browser's, one character at a time.
  let prevented = false;
  act(() => {
    prevented = !fireEvent.keyDown(
      h.input,
      mangled("ArrowLeft", { shiftKey: true }),
    );
  });
  expect(prevented).toBe(true);
  expect(modify).toHaveBeenCalledExactlyOnceWith("extend", "left", "character");
  expect(range(h)).toEqual({ anchor: 0, head: 2, text: "ab" });
  expect(snapshot(h)).toEqual(before);
});

it.each([
  ["MacIntel", "ArrowRight", { altKey: true }, ["move", "right", "word"]],
  [
    "MacIntel",
    "ArrowLeft",
    { metaKey: true },
    ["move", "left", "lineboundary"],
  ],
  [
    "MacIntel",
    "ArrowLeft",
    { metaKey: true, shiftKey: true },
    ["extend", "left", "lineboundary"],
  ],
  ["MacIntel", "ArrowUp", {}, ["move", "backward", "line"]],
  ["MacIntel", "ArrowDown", { shiftKey: true }, ["extend", "forward", "line"]],
  [
    "MacIntel",
    "ArrowUp",
    { altKey: true },
    ["move", "backward", "paragraphboundary"],
  ],
  [
    "MacIntel",
    "ArrowDown",
    { metaKey: true },
    ["move", "forward", "documentboundary"],
  ],
  ["MacIntel", "Home", {}, null],
  ["MacIntel", "End", {}, null],
  [
    "MacIntel",
    "End",
    { shiftKey: true },
    ["extend", "forward", "documentboundary"],
  ],
  ["MacIntel", "PageUp", {}, null],
  ["MacIntel", "PageDown", { shiftKey: true }, null],
  ["Win32", "ArrowRight", { ctrlKey: true }, ["move", "right", "lineboundary"]],
  ["Win32", "ArrowRight", { metaKey: true }, ["move", "right", "character"]],
  ["Win32", "Home", {}, ["move", "backward", "lineboundary"]],
  ["Win32", "End", { shiftKey: true }, ["extend", "forward", "lineboundary"]],
] as const)(
  "on %s asks the browser to move the caret for %s reported as a control character with %o",
  (platform, code, init, call) => {
    setPlatform(platform);
    const h = mount("abc");
    const modify = stubSelectionModify();
    const before = snapshot(h);
    act(() => h.input.setSelectionRange(1, 1));
    let prevented = false;
    act(() => {
      prevented = !fireEvent.keyDown(h.input, mangled(code, init));
    });
    expect(prevented).toBe(true);
    if (call) expect(modify).toHaveBeenCalledExactlyOnceWith(...call);
    else expect(modify).not.toHaveBeenCalled();
    expect(snapshot(h)).toEqual(before);
    expect(h.input).toHaveValue("abc");
  },
);

it("leaves a named caret key to the browser", () => {
  const h = mount("abc");
  const modify = stubSelectionModify();
  act(() => h.input.setSelectionRange(1, 1));
  let prevented = true;
  act(() => {
    prevented = !fireEvent.keyDown(h.input, {
      key: "ArrowRight",
      code: "ArrowRight",
      keyCode: 39,
    });
  });
  expect(prevented).toBe(false);
  expect(modify).not.toHaveBeenCalled();
  expect(h.input.selectionStart).toBe(1);
});
