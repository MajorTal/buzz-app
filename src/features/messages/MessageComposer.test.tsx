// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect } from "react";
import type { Contribution } from "../../plugins/contributions";
import type {
  ComposerTool,
  ComposerToolProps,
  InlineRenderer,
} from "../conversation/contracts";
import { MessageComposer, type MessageComposerProps } from "./MessageComposer";
import type { RelaySession } from "../relay/session";
import { emojiMatches, type CustomEmoji } from "../relay/emoji";
import { CustomEmoji as CustomEmojiImage } from "../../bundled/emoji/CustomEmoji";
import type { ComposerInputElement } from "./composer-dom";

const first = { pubkey: "a".repeat(64), name: "Honey" };
const second = { pubkey: "b".repeat(64), name: "Honey" };

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

function mount(options: Partial<MessageComposerProps> = {}) {
  let commands: ComposerToolProps;
  function Tool(props: ComposerToolProps) {
    useLayoutEffect(() => {
      commands = props;
    });
    return (
      <>
        <button type="button" onClick={() => props.insertMention(first)}>
          First Honey
        </button>
        <button type="button" onClick={() => props.insertMention(second)}>
          Second Honey
        </button>
      </>
    );
  }
  const tools: readonly Contribution<ComposerTool>[] = [
    {
      id: "fixture",
      key: "test/fixture",
      pluginId: "test",
      revision: "1",
      title: "Fixture tools",
      component: Tool,
    },
  ];
  const emojiListeners = new Set<() => void>();
  let emoji = {
    status: "ready" as const,
    entries: [] as readonly CustomEmoji[],
  };
  const messages = {
    send: vi.fn<RelaySession["messages"]["send"]>(() => "channel-id"),
    reply: vi.fn<RelaySession["messages"]["reply"]>(() => "reply-id"),
  };
  const typing: ReturnType<RelaySession["typing"]["snapshot"]> = [];
  const profiles = new Map();
  const session = {
    messages,
    typing: { snapshot: () => typing, subscribe: () => () => {} },
    profiles: { snapshot: () => profiles, subscribe: () => () => {} },
    emoji: {
      snapshot: () => emoji,
      subscribe(listener: () => void) {
        emojiListeners.add(listener);
        return () => {
          emojiListeners.delete(listener);
        };
      },
      ensure: vi.fn(() => Promise.resolve()),
      refresh: vi.fn(() => Promise.resolve()),
    },
    media: (url: string) => url,
    outbox: { supports: () => true },
  } as unknown as RelaySession;
  const onSend = vi.fn();
  const inline: readonly Contribution<InlineRenderer>[] = [
    {
      id: "emoji",
      key: "test/emoji",
      pluginId: "test",
      revision: "1",
      title: "Emoji",
      matches: ({ text, message }) => [
        ...emojiMatches(text, message.emoji ?? []),
      ],
      component: ({ text, content, media }) => {
        const entry = content.message.emoji?.find(
          (entry) => `:${entry.shortcode}:` === text.toLowerCase(),
        );
        return entry ? <CustomEmojiImage emoji={entry} media={media} /> : text;
      },
    },
  ];
  let props: MessageComposerProps = {
    session,
    onSend,
    scope: "scope",
    channelId: "channel",
    channelName: "General",
    extensions: {
      tools: { snapshot: () => tools, subscribe: () => () => {} },
      inline: { snapshot: () => inline, subscribe: () => () => {} },
    },
    ...options,
  };
  const view = render(<MessageComposer {...props} />, {
    reactStrictMode: true,
  });
  const input = () =>
    within(view.container).getByRole<ComposerInputElement>("textbox");
  return {
    ...view,
    input,
    messages,
    onSend,
    session,
    emojiListeners,
    user: userEvent.setup(),
    commands: () => commands,
    retarget(next: Partial<MessageComposerProps>) {
      props = { ...props, ...next };
      view.rerender(<MessageComposer {...props} />);
    },
    setEmoji(entries: readonly CustomEmoji[]) {
      act(() => {
        emoji = { status: "ready", entries };
        for (const listener of emojiListeners) listener();
      });
    },
    fill(text: string) {
      fireEvent.input(input(), { target: { value: text } });
      input().setSelectionRange(text.length, text.length);
    },
    submit() {
      fireEvent.submit(within(view.container).getByRole("form"));
    },
  };
}

it("sends channel messages and thread replies through real form and keyboard events", async () => {
  const h = mount();
  await h.user.type(h.input(), "channel draft");
  await h.user.click(screen.getByRole("button", { name: "Send message" }));
  expect(h.messages.send).toHaveBeenCalledExactlyOnceWith(
    "channel",
    "channel draft",
    [],
  );
  expect(h.messages.reply).not.toHaveBeenCalled();
  h.retarget({ threadRootId: "root" });
  await h.user.type(h.input(), "thread draft");
  await h.user.keyboard("{Shift>}{Enter}{/Shift}");
  expect(h.input()).toHaveValue("thread draft\n");
  // This checks the composition guard, not native IME behavior.
  fireEvent.keyDown(h.input(), { key: "Enter", isComposing: true });
  expect(h.messages.reply).not.toHaveBeenCalled();
  await h.user.keyboard("{Enter}");
  expect(h.messages.reply).toHaveBeenCalledExactlyOnceWith(
    "channel",
    "root",
    "thread draft\n",
    [],
  );
  expect(h.messages.send).toHaveBeenCalledTimes(1);
  expect(h.onSend.mock.calls).toEqual([["channel-id"], ["reply-id"]]);
  expect(h.input()).toHaveValue("");
});

it("isolates channel, thread and identity drafts through retargeting and remounting", () => {
  const h = mount();
  h.fill("channel draft");
  h.retarget({ threadRootId: "one" });
  expect(h.input()).toHaveValue("");
  h.fill("first thread");
  h.retarget({ threadRootId: "two" });
  h.fill("second thread");
  h.retarget({ threadRootId: "one", scope: "other identity" });
  expect(h.input()).toHaveValue("");
  h.fill("other identity");
  h.retarget({ threadRootId: "one", scope: "scope" });
  expect(h.input()).toHaveValue("first thread");
  h.retarget({ threadRootId: "two" });
  expect(h.input()).toHaveValue("second thread");
  h.unmount();
  const restored = mount();
  expect(restored.input()).toHaveValue("channel draft");
  restored.retarget({ threadRootId: "one", scope: "other identity" });
  expect(restored.input()).toHaveValue("other identity");
});

it("retains rejected intent and clears the draft only after the outbox accepts it", async () => {
  const h = mount({ threadRootId: "root" });
  h.fill("retry me");
  h.messages.reply.mockImplementationOnce(() => {
    throw new Error("outbox full");
  });
  await h.user.click(screen.getByRole("button", { name: "Send message" }));
  expect(h.input()).toHaveValue("retry me");
  expect(h.onSend).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent("outbox full");
  await h.user.click(screen.getByRole("button", { name: "Send message" }));
  expect(h.messages.reply).toHaveBeenCalledTimes(2);
  expect(h.input()).toHaveValue("");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("labels simultaneous composers independently and prevents disabled or unsupported writes", async () => {
  const channel = mount();
  const thread = mount({ threadRootId: "root" });
  expect(screen.getByLabelText("Message #General")).toBe(channel.input());
  expect(screen.getByRole("textbox", { name: "Reply to thread" })).toBe(
    thread.input(),
  );
  expect(thread.input().id).not.toBe(channel.input().id);
  thread.fill("retain me");
  thread.retarget({ disabled: true });
  expect(thread.input()).toHaveAttribute("aria-disabled", "true");
  expect(thread.input()).toHaveAttribute("contenteditable", "false");
  await thread.user.click(
    within(thread.container).getByRole("button", { name: "Send message" }),
  );
  expect(thread.messages.reply).not.toHaveBeenCalled();
  expect(thread.input()).toHaveValue("retain me");
  thread.retarget({
    session: {
      ...thread.session,
      outbox: { supports: () => false },
    } as unknown as RelaySession,
  });
  expect(
    within(thread.container).queryByRole("textbox"),
  ).not.toBeInTheDocument();
  expect(
    within(thread.container).getByText(
      "This relay connection supports reading only.",
    ),
  ).toBeVisible();
});

it("subscribes to emoji changes and releases the subscription when unmounted", () => {
  const h = mount();
  h.fill(":party:");
  expect(h.input().querySelectorAll("img")).toHaveLength(0);
  expect(h.emojiListeners.size).toBe(1);
  expect(h.session.emoji.ensure).toHaveBeenCalled();
  h.setEmoji([{ shortcode: "party", url: "https://emoji.test/party.png" }]);
  expect(h.input().querySelectorAll("img")).toHaveLength(1);
  h.setEmoji([]);
  expect(h.input().querySelectorAll("img")).toHaveLength(0);
  h.unmount();
  expect(h.emojiListeners.size).toBe(0);
});

it("enlarges Unicode-only drafts and restores normal text presentation", () => {
  const h = mount();
  for (const draft of ["😀", "😀 🙏 👏", "😀 🙏 👏 😄"]) {
    h.fill(draft);
    expect(h.input()).toHaveAttribute("data-single-emoji", "true");
    h.fill(`${draft} hello`);
    expect(h.input()).not.toHaveAttribute("data-single-emoji");
  }
});

it.each([undefined, "root"])(
  "persists exact namesake recipients for %s without resolving typed prose",
  async (root) => {
    const options = root ? { threadRootId: root } : {};
    let h = mount(options);
    h.fill("@Honey prose only");
    h.submit();
    expect(
      (root ? h.messages.reply : h.messages.send).mock.calls[0]?.at(-1),
    ).toEqual([]);
    h.fill("Please help ");
    await h.user.click(screen.getByRole("button", { name: "First Honey" }));
    await h.user.click(screen.getByRole("button", { name: "Second Honey" }));
    h.unmount();
    h = mount(options);
    expect(
      screen.getByRole("button", {
        name: `Remove mention Honey ${second.pubkey}`,
      }),
    ).toBeVisible();
    h.submit();
    expect(
      (root ? h.messages.reply : h.messages.send).mock.calls[0]?.at(-1),
    ).toEqual([first.pubkey, second.pubkey]);
    expect(h.input()).toHaveValue("");
    h.unmount();
    h = mount(options);
    h.fill("@Honey typed after send");
    h.submit();
    expect(
      (root ? h.messages.reply : h.messages.send).mock.calls[0]?.at(-1),
    ).toEqual([]);
  },
);

it("deleting a mention or removing its chip removes notification intent", async () => {
  const h = mount();
  await h.user.click(screen.getByRole("button", { name: "First Honey" }));
  h.fill("no recipient now");
  h.submit();
  expect(h.messages.send.mock.calls[0]?.at(-1)).toEqual([]);
  await h.user.click(screen.getByRole("button", { name: "First Honey" }));
  await h.user.click(
    screen.getByRole("button", {
      name: `Remove mention Honey ${first.pubkey}`,
    }),
  );
  h.submit();
  expect(h.messages.send.mock.calls[1]?.at(-1)).toEqual([]);
});

it("ambiguous namesake replacement cannot notify the wrong remaining identity", async () => {
  const h = mount();
  await h.user.click(screen.getByRole("button", { name: "First Honey" }));
  await h.user.click(screen.getByRole("button", { name: "Second Honey" }));
  h.fill("@Honey help");
  h.submit();
  expect(h.messages.send.mock.calls[0]?.at(-1)).toEqual([]);
});

it("serializes tool commands in one React batch and rejects malformed recipients", () => {
  const h = mount();
  h.fill("Hi ");
  act(() => {
    const { insertText, insertMention } = h.commands();
    expect(insertText("there ")).toBe(true);
    expect(insertMention(first)).toBe(true);
    expect(insertText("and ")).toBe(true);
    expect(insertMention(second)).toBe(true);
    expect(insertMention({ pubkey: "wrong", name: "Honey" })).toBe(false);
    expect(insertMention({ ...first, name: "  " })).toBe(false);
    expect(insertMention(null as unknown as typeof first)).toBe(false);
  });
  h.submit();
  expect(h.messages.send).toHaveBeenCalledExactlyOnceWith(
    "channel",
    "Hi there @Honey and @Honey ",
    [first.pubkey, second.pubkey],
  );
});

it("revokes captured tool commands after retargeting, disabling and unmounting", () => {
  const h = mount();
  h.fill("channel draft");
  const channel = h.commands();
  h.retarget({ threadRootId: "root" });
  act(() => {
    expect(channel.insertText("stale")).toBe(false);
    expect(channel.insertMention(first)).toBe(false);
  });
  expect(h.input()).toHaveValue("");
  const thread = h.commands();
  h.retarget({ disabled: true });
  act(() => {
    expect(thread.insertText("disabled")).toBe(false);
  });
  h.retarget({ disabled: false });
  act(() => {
    expect(h.commands().insertText("current")).toBe(true);
  });
  expect(h.input()).toHaveValue("current");
  const current = h.commands();
  h.unmount();
  act(() => {
    expect(current.insertText("unmounted")).toBe(false);
  });
});

it("keeps custom emoji text readable and sends repeated shortcodes unchanged", () => {
  const h = mount();
  h.setEmoji([{ shortcode: "party", url: "https://emoji.test/party.png" }]);
  act(() => {
    expect(h.commands().insertText(":party:")).toBe(true);
  });
  expect(h.input()).toHaveValue(":party:");
  expect(h.input()).toHaveAttribute("data-single-emoji", "true");
  act(() => {
    expect(h.commands().insertText(":party:")).toBe(true);
  });
  expect(h.input()).toHaveValue(":party::party:");
  expect(h.container.querySelectorAll("img")).toHaveLength(2);
  h.submit();
  expect(h.messages.send).toHaveBeenCalledExactlyOnceWith(
    "channel",
    ":party::party:",
    [],
  );
});

it("renders a leading custom emoji inline without changing trailing text", () => {
  const h = mount();
  h.setEmoji([{ shortcode: "bufo", url: "https://emoji.test/bufo.png" }]);
  h.fill(":bufo:lakjsdlkjflakjsdf");
  expect(h.input()).not.toHaveAttribute("data-single-emoji");
  expect(h.input()).toHaveValue(":bufo:lakjsdlkjflakjsdf");
  expect(h.container.querySelectorAll("img")).toHaveLength(1);
  h.submit();
  expect(h.messages.send).toHaveBeenCalledExactlyOnceWith(
    "channel",
    ":bufo:lakjsdlkjflakjsdf",
    [],
  );
});

it("rejects overlong and over-limit tool edits without changing accepted intent", () => {
  const h = mount();
  h.fill("x".repeat(15999));
  act(() => {
    expect(h.commands().insertMention(first)).toBe(false);
  });
  expect(h.input()).toHaveValue("x".repeat(15999));
  expect(screen.getByRole("alert")).toHaveTextContent("too long");
  h.fill("");
  act(() => {
    for (let i = 0; i < 32; i++)
      expect(h.commands().insertMention(first)).toBe(true);
  });
  const before = h.input().value;
  act(() => {
    expect(h.commands().insertMention(first)).toBe(false);
  });
  expect(h.input()).toHaveValue(before);
  expect(screen.getByRole("alert")).toHaveTextContent("at most 32 recipients");
});
