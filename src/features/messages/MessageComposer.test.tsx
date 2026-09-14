import { assert, afterEach, beforeEach, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode, type ReactElement } from "react";
import { ComposerTools } from "../conversation/ComposerTools";
import type { ConversationExtensions } from "../conversation/contracts";
import { MessageComposer } from "./MessageComposer";
import {
  isEmojiOnly,
  isUnicodeEmojiOnly,
  singleCustomEmoji,
  usesLargeEmojiPresentation,
} from "./emoji-size";
import type { RelaySession } from "../relay/session";
import type { CustomEmoji } from "../relay/emoji";

// Production handlers with a shallow hook harness; not DOM focus/layout evidence.
const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as unknown[],
  refIndex: 0,
  index: 0,
  id: 0,
  effects: [] as (() => void)[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: () => {},
  useCallback: (callback: unknown) => callback,
  useLayoutEffect: (effect: () => void) => hooks.effects.push(effect),
  useId: () => `composer-${++hooks.id}`,
  useRef: (initial: unknown) => {
    const i = hooks.refIndex++;
    if (!(i in hooks.refs))
      hooks.refs[i] = {
        current:
          initial === null
            ? {
                focus: vi.fn(),
                style: {},
                children: [],
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
                ownerDocument: {
                  addEventListener: vi.fn(),
                  removeEventListener: vi.fn(),
                  activeElement: null,
                },
                isConnected: true,
                selectionStart: 0,
                selectionEnd: 0,
                setSelectionRange(start: number, end: number) {
                  this.selectionStart = start;
                  this.selectionEnd = end;
                },
              }
            : initial,
      };
    return hooks.refs[i];
  },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) =>
    snapshot(),
  useState(initial: unknown) {
    const i = hooks.index++;
    if (!(i in hooks.states))
      hooks.states[i] = typeof initial === "function" ? initial() : initial;
    return [
      hooks.states[i],
      (value: unknown) => {
        hooks.states[i] = value;
      },
    ];
  },
}));
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
const storage = new Map<string, string>();
beforeEach(() => {
  hooks.states = [];
  hooks.effects = [];
  hooks.refs = [];
  hooks.refIndex = 0;
  hooks.index = hooks.id = 0;
  storage.clear();
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());
function mount(
  threadRootId?: string,
  scope = "scope",
  writable = true,
  emojiEntries: readonly CustomEmoji[] = [],
) {
  hooks.states = [];
  hooks.effects = [];
  hooks.refs = [];
  hooks.refIndex = 0;
  const messages = {
    send: vi.fn(() => "channel-id"),
    reply: vi.fn(() => "reply-id"),
  };
  const onSend = vi.fn();
  const session = {
    messages,
    emoji: {
      snapshot: () => ({ status: "ready", entries: emojiEntries }),
      subscribe: () => () => {},
      ensure: () => Promise.resolve(),
      refresh: () => Promise.resolve(),
    },
    media: (url: string) => url,
    outbox: { supports: () => writable },
  } as unknown as RelaySession;
  const render = () => {
    hooks.index = hooks.refIndex = 0;
    const scoped = MessageComposer({
      session,
      extensions: {} as ConversationExtensions,
      scope,
      channelId: "channel",
      channelName: "General",
      onSend,
      ...(threadRootId ? { threadRootId } : {}),
    });
    const tree = (
      scoped.type as (
        props: typeof scoped.props,
      ) => ReactElement<Record<string, unknown>>
    )(scoped.props);
    const field = elements(tree).find((element) => element.type === "textarea");
    if (field) {
      const ref = field.props.ref as { current: HTMLTextAreaElement };
      const length = (field.props.value as string).length;
      ref.current.setSelectionRange(
        Math.min(ref.current.selectionStart, length),
        Math.min(ref.current.selectionEnd, length),
      );
    }
    for (const effect of hooks.effects.splice(0)) effect();
    return tree;
  };
  const input = () => {
    const field = elements(render()).find((e) => e.type === "textarea");
    if (!field) throw new Error("No composer input");
    return field;
  };
  return {
    render,
    input,
    messages,
    onSend,
    type(text: string) {
      const field = input();
      (field.props.onInput as (e: unknown) => void)({
        currentTarget: { value: text },
      });
      const ref = field.props.ref as { current: HTMLTextAreaElement };
      ref.current.setSelectionRange(text.length, text.length);
    },
    submit() {
      (render().props.onSubmit as (e: unknown) => void)({
        preventDefault() {},
      });
    },
    key(shiftKey = false, isComposing = false) {
      const preventDefault = vi.fn();
      (input().props.onKeyDown as (e: unknown) => void)({
        key: "Enter",
        shiftKey,
        nativeEvent: { isComposing },
        preventDefault,
      });
      return preventDefault;
    },
  };
}
it("reuses the editor for channel sends and thread replies, preserving keyboard behavior", () => {
  const channel = mount();
  channel.type("channel draft");
  channel.submit();
  expect(channel.messages.send).toHaveBeenCalledExactlyOnceWith(
    "channel",
    "channel draft",
    [],
  );
  expect(channel.messages.reply).not.toHaveBeenCalled();
  const thread = mount("root");
  thread.type("thread draft");
  expect(thread.key(true)).not.toHaveBeenCalled();
  expect(thread.key(false, true)).not.toHaveBeenCalled();
  expect(thread.messages.reply).not.toHaveBeenCalled();
  expect(thread.key()).toHaveBeenCalledTimes(1);
  expect(thread.messages.reply).toHaveBeenCalledExactlyOnceWith(
    "channel",
    "root",
    "thread draft",
    [],
  );
  expect(thread.messages.send).not.toHaveBeenCalled();
  expect(thread.onSend).toHaveBeenCalledExactlyOnceWith("reply-id");
  expect(thread.input().props.value).toBe("");
});
it("keeps channel, separate thread and identity drafts isolated across remounts", () => {
  mount().type("channel draft");
  mount("one").type("first thread");
  mount("two").type("second thread");
  mount("one", "other identity").type("other identity");
  expect(mount().input().props.value).toBe("channel draft");
  expect(mount("one").input().props.value).toBe("first thread");
  expect(mount("two").input().props.value).toBe("second thread");
  expect(mount("one", "other identity").input().props.value).toBe(
    "other identity",
  );
});
it("keeps the draft on synchronous rejection and clears only after the outbox accepts intent", () => {
  const h = mount("root");
  h.type("retry me");
  h.messages.reply.mockImplementationOnce(() => {
    throw new Error("outbox full");
  });
  h.submit();
  expect(h.input().props.value).toBe("retry me");
  expect(h.onSend).not.toHaveBeenCalled();
  expect(
    elements(h.render()).some(
      (e) => e.props.role === "alert" && e.props.children === "outbox full",
    ),
  ).toBe(true);
  h.submit();
  expect(h.input().props.value).toBe("");
});
it("gives the channel and thread separate input/label identities, and gates unsupported writes", () => {
  const channel = mount().render(),
    thread = mount("root").render();
  const channelInput = elements(channel).find((e) => e.type === "textarea");
  const threadInput = elements(thread).find((e) => e.type === "textarea");
  expect(threadInput?.props.id).not.toBe(channelInput?.props.id);
  expect(threadInput?.props.placeholder).toBe("Reply to thread");
  expect(elements(thread).find((e) => e.type === "label")?.props.htmlFor).toBe(
    threadInput?.props.id,
  );
  expect(
    elements(mount("root", "scope", false).render()).some(
      (e) => e.type === "textarea",
    ),
  ).toBe(false);
});

it("enlarges Unicode-only drafts and restores normal text presentation", () => {
  for (const emoji of ["😀", " 👋🏽 ", "👨‍👩‍👧‍👦", "🇬🇧", "1️⃣"])
    expect(isUnicodeEmojiOnly(emoji)).toBe(true);
  for (const other of ["", "1", ":party:", "😀a", "😀 hello"])
    expect(isUnicodeEmojiOnly(other)).toBe(false);

  const h = mount();
  h.type("😀");
  expect(h.input().props["data-single-emoji"]).toBe(true);
  h.type("😀 hello");
  expect(h.input().props["data-single-emoji"]).toBeUndefined();
  h.type("😀 🙏 👏");
  expect(h.input().props["data-single-emoji"]).toBe(true);
  h.type("😀 🙏 👏 😄");
  expect(h.input().props["data-single-emoji"]).toBe(true);
  h.type("😀 🙏 hello");
  expect(h.input().props["data-single-emoji"]).toBeUndefined();
});

it("recognizes an exact custom emoji draft without treating shortcode prose as emoji", () => {
  const party = { shortcode: "party", url: "https://example.test/party.png" };
  expect(singleCustomEmoji(":PARTY: ", [party])).toBe(party);
  expect(singleCustomEmoji("hello :party:", [party])).toBeUndefined();
  expect(singleCustomEmoji(":missing:", [party])).toBeUndefined();
  expect(isEmojiOnly(":party: 😀 :PARTY:", [party])).toBe(true);
  expect(isEmojiOnly(":party: hello", [party])).toBe(false);
  expect(usesLargeEmojiPresentation(":party: 😀 :PARTY:", [party])).toBe(true);
  expect(
    usesLargeEmojiPresentation(":party: 😀 :PARTY: :party:", [party]),
  ).toBe(true);
});

it.each([undefined, "root"])(
  "carries exact namesake selection into %s, restores it, and never resolves typed names",
  (root) => {
    const first = { pubkey: "a".repeat(64), name: "Honey" };
    const second = { pubkey: "b".repeat(64), name: "Honey" };
    let h = mount(root);
    h.type("@Honey prose only");
    h.submit();
    expect(
      (root ? h.messages.reply : h.messages.send).mock.calls[0]?.at(-1),
    ).toEqual([]);
    h.type("Please help ");
    for (const recipient of [first, second]) {
      const picker = elements(h.render()).find((e) => e.type === ComposerTools);
      assert.exists(picker);
      (picker.props.insertMention as (value: unknown) => void)(recipient);
    }
    h = mount(root);
    expect(
      elements(h.render()).filter((e) => e.props.title === second.pubkey),
    ).toHaveLength(1);
    h.submit();
    expect(
      (root ? h.messages.reply : h.messages.send).mock.calls[0]?.at(-1),
    ).toEqual([first.pubkey, second.pubkey]);
    expect(h.input().props.value).toBe("");
    h = mount(root);
    h.type("@Honey typed after send");
    h.submit();
    expect(
      (root ? h.messages.reply : h.messages.send).mock.calls[0]?.at(-1),
    ).toEqual([]);
  },
);
it("deleting a mention or removing its chip removes notification intent", () => {
  const h = mount();
  const choose = () => {
    const picker = elements(h.render()).find((e) => e.type === ComposerTools);
    assert.exists(picker);
    (picker.props.insertMention as (v: unknown) => void)({
      pubkey: "a".repeat(64),
      name: "Honey",
    });
  };
  choose();
  h.type("no recipient now");
  h.submit();
  expect(h.messages.send.mock.calls[0]?.at(-1)).toEqual([]);
  choose();
  const remove = elements(h.render()).find(
    (e) => e.props.title === "a".repeat(64),
  );
  assert.exists(remove);
  (remove.props.onClick as () => void)();
  h.submit();
  expect(h.messages.send.mock.calls[1]?.at(-1)).toEqual([]);
});

it("ambiguous namesake deletion cannot notify the wrong remaining identity", () => {
  const h = mount();
  for (const key of ["a", "b"]) {
    const picker = elements(h.render()).find((e) => e.type === ComposerTools);
    assert.exists(picker);
    (picker.props.insertMention as (v: unknown) => void)({
      pubkey: key.repeat(64),
      name: "Honey",
    });
  }
  h.type("@Honey help");
  h.submit();
  expect(h.messages.send.mock.calls[0]?.at(-1)).toEqual([]);
});

it("serializes text and mention commands in one turn and rejects malformed recipients", () => {
  const h = mount();
  h.type("Hi ");
  const tools = elements(h.render()).find((e) => e.type === ComposerTools);
  assert.exists(tools);
  const insertText = tools.props.insertText as (text: string) => boolean;
  const insertMention = tools.props.insertMention as (
    recipient: unknown,
  ) => boolean;
  expect(insertText("there ")).toBe(true);
  expect(insertMention({ pubkey: "a".repeat(64), name: "Honey" })).toBe(true);
  expect(insertText("and ")).toBe(true);
  expect(insertMention({ pubkey: "b".repeat(64), name: "Honey" })).toBe(true);
  expect(insertMention({ pubkey: "wrong", name: "Honey" })).toBe(false);
  expect(insertMention({ pubkey: "a".repeat(64), name: "  " })).toBe(false);
  expect(insertMention(null)).toBe(false);
  h.submit();
  expect(h.messages.send).toHaveBeenCalledExactlyOnceWith(
    "channel",
    "Hi there @Honey and @Honey ",
    ["a".repeat(64), "b".repeat(64)],
  );
});

it("keeps custom emoji shortcode text readable in the draft and sends it unchanged", () => {
  const h = mount(undefined, "scope", true, [
    { shortcode: "party", url: "https://emoji.test/party.png" },
  ]);
  const tools = elements(h.render()).find((e) => e.type === ComposerTools);
  assert.exists(tools);
  const insertText = tools.props.insertText as (text: string) => boolean;
  expect(insertText(":party:")).toBe(true);
  expect(h.input().props.value).toBe(":party:");
  expect(h.input().props["data-custom-emoji-only"]).toBe(true);
  expect(insertText(":party:")).toBe(true);
  expect(h.input().props.value).toBe(":party::party:");
  expect(
    elements(h.render()).filter((element) => element.type === "img"),
  ).toHaveLength(2);
  h.submit();
  expect(h.messages.send).toHaveBeenCalledExactlyOnceWith(
    "channel",
    ":party::party:",
    [],
  );
});

it("renders a leading custom emoji inline when text follows it", () => {
  const h = mount(undefined, "scope", true, [
    { shortcode: "bufo", url: "https://emoji.test/bufo.png" },
  ]);
  h.type(":bufo:lakjsdlkjflakjsdf");
  expect(h.input().props["data-custom-emoji-only"]).toBeUndefined();
  expect(h.input().props["data-leading-custom-emoji"]).toBe(true);
  expect(
    elements(h.render()).filter((element) => element.type === "img"),
  ).toHaveLength(1);
  h.submit();
  expect(h.messages.send).toHaveBeenCalledExactlyOnceWith(
    "channel",
    ":bufo:lakjsdlkjflakjsdf",
    [],
  );
});

it("rejects overlong or over-limit edits without changing the draft", () => {
  const h = mount();
  h.type("x".repeat(15999));
  const tools = () => {
    const tool = elements(h.render()).find((e) => e.type === ComposerTools);
    assert.exists(tool);
    return tool;
  };
  const recipient = { pubkey: "a".repeat(64), name: "Honey" };
  expect(
    (tools().props.insertMention as (r: unknown) => boolean)(recipient),
  ).toBe(false);
  expect(h.input().props.value).toBe("x".repeat(15999));
  h.type("");
  for (let i = 0; i < 32; i++)
    expect(
      (tools().props.insertMention as (r: unknown) => boolean)(recipient),
    ).toBe(true);
  const before = h.input().props.value;
  expect(
    (tools().props.insertMention as (r: unknown) => boolean)(recipient),
  ).toBe(false);
  expect(h.input().props.value).toBe(before);
});
