// @vitest-environment jsdom
import {
  act,
  cleanup,
  render,
  screen,
  fireEvent,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { CompletionResult } from "../../features/conversation/contracts";
import type {
  ChannelList,
  ChannelSummary,
} from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { scanMarkdown } from "../../features/relay/message-content";
import { MessageMarkdown } from "../../features/messages/MessageMarkdown";
import { LinkLabel } from "../links/InlineLink";
import { ChannelCompletion } from "./ChannelCompletion";

afterEach(cleanup);
const channel = (
  id: string,
  extra: Partial<ChannelSummary> = {},
): ChannelSummary => ({
  id,
  name: id,
  channelType: "stream",
  members: ["viewer"],
  ...extra,
});
function fixture(
  channels: readonly ChannelSummary[],
  viewer: string | undefined = "viewer",
) {
  let list: ChannelList = { status: "ready", channels };
  let result: CompletionResult | undefined;
  const listeners = new Set<() => void>();
  const withdrawals = vi.fn();
  const ensureList = vi.fn(),
    refreshList = vi.fn();
  const session = {
    viewer,
    channels: {
      list: () => list,
      ensureList,
      refreshList,
      subscribeList(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as RelaySession;
  const publish = vi.fn((next: CompletionResult) => {
    result = next;
    return () => {
      withdrawals();
      if (result === next) result = undefined;
    };
  });
  return {
    session,
    listeners,
    withdrawals,
    ensureList,
    refreshList,
    publish,
    result: () => {
      if (!result) throw new Error("No published result");
      return result;
    },
    set(next: ChannelList, notify = true) {
      list = next;
      if (notify)
        act(() => {
          for (const listener of listeners) listener();
        });
    },
    element(query = "") {
      return (
        <StrictMode>
          <ChannelCompletion
            session={session}
            scope="test"
            channelId="source"
            observation={{
              revision: 1,
              text: `#${query}`,
              start: query.length + 1,
              end: query.length + 1,
            }}
            query={{ start: 0, end: query.length + 1, query }}
            publish={publish}
          />
        </StrictMode>
      );
    },
  };
}
it("offers only freshly confirmed joined streams/forums, including private channels", () => {
  const t = fixture([
    channel("stream"),
    channel("forum", { channelType: "forum" }),
    channel("private", { private: true }),
    channel("archived", { archived: true }),
    channel("cached", { cached: true }),
    channel("readOnly", { readOnly: true }),
    channel("dm", { channelType: "dm" }),
    channel("session", { channelType: "session" }),
    { id: "unknown", name: "unknown", members: ["viewer"] },
    channel("outside", { members: ["other"] }),
    { id: "missing", name: "missing", channelType: "stream" },
    channel("blank", { name: " " }),
    channel("multiline", { name: "a\n\nb" }),
  ]);
  render(t.element());
  expect(t.result().items.map((item) => item.id)).toEqual([
    "forum",
    "private",
    "stream",
  ]);
  expect(t.result().items[1]?.detail).toBe("Private channel");
  expect(t.ensureList).not.toHaveBeenCalled();
  expect(t.refreshList).not.toHaveBeenCalled();
});
it("does not offer channels without a viewer", () => {
  const t = fixture([channel("a")]);
  const session = { ...t.session, viewer: undefined };
  render(
    <ChannelCompletion
      session={session}
      scope="test"
      channelId="source"
      observation={{ revision: 1, text: "#", start: 1, end: 1 }}
      query={{ start: 0, end: 1, query: "" }}
      publish={t.publish}
    />,
  );
  expect(t.result().items).toEqual([]);
});
it("ranks exact/prefix/substring case-insensitively, qualifies namesakes, and caps at 20", () => {
  const t = fixture([
    channel("z", { name: "crew" }),
    channel("a", { name: "crew" }),
    channel("b", { name: "Crew-tools" }),
    channel("c", { name: "My crew" }),
    ...Array.from({ length: 25 }, (_, i) => channel(`unrelated-${i}`)),
  ]);
  const view = render(t.element("CREW"));
  expect(t.result().items.map((item) => item.id)).toEqual(["a", "z", "b", "c"]);
  expect(
    t
      .result()
      .items.slice(0, 2)
      .map((item) => item.detail),
  ).toEqual(["a", "z"]);
  view.rerender(t.element());
  expect(t.result().items).toHaveLength(20);
  expect(t.result().status).toBe("Keep typing to narrow the list.");
});
it("inserts an escaped ID-backed Markdown link, not notification intent", () => {
  const name = "a [b] *c* &amp; <d> \\ !";
  const t = fixture([channel("id-with-(parens)", { name })]);
  render(t.element());
  const edit = t.result().items[0]?.edit;
  expect(edit).not.toHaveProperty("mention");
  const tree = scanMarkdown(edit?.text ?? "").tree;
  expect(tree.children?.[0]?.children?.[0]).toMatchObject({
    type: "link",
    url: "buzz://channel/id-with-%28parens%29",
    children: [{ type: "text", value: `#${name}` }],
  });
});
it.each<Partial<ChannelSummary>>([
  {},
  { members: [] },
  { archived: true },
  { cached: true },
  { readOnly: true },
  { name: "renamed" },
])("rechecks selection before React can repaint: %j", (change) => {
  const t = fixture([channel("a")]);
  render(t.element());
  const old = t.result().items[0];
  expect(old?.canSelect?.("a")).toBe(true);
  t.set(
    {
      status: "ready",
      channels: Object.keys(change).length ? [channel("a", change)] : [],
    },
    false,
  );
  expect(old?.canSelect?.("a")).toBe(false);
});
it("withdraws on updates and unsubscribes on disposal under StrictMode", () => {
  const t = fixture([channel("a")]);
  const view = render(t.element());
  expect(t.listeners.size).toBe(1);
  const before = t.withdrawals.mock.calls.length;
  t.set({ status: "ready", channels: [] });
  expect(t.withdrawals).toHaveBeenCalledTimes(before + 1);
  expect(t.result().items).toEqual([]);
  view.unmount();
  expect(t.listeners.size).toBe(0);
  expect(t.withdrawals).toHaveBeenCalledTimes(before + 2);
});
it("distinguishes loading, empty and failed lists; only explicit retry refreshes", () => {
  const t = fixture([]);
  t.set({ status: "loading", channels: [] });
  render(t.element());
  expect(t.result().status).toBe("Loading channels…");
  t.set({ status: "ready", channels: [] });
  expect(t.result().status).toBeUndefined();
  t.set({ status: "error", channels: [channel("a")], error: "offline" });
  expect(t.result().items).toHaveLength(1);
  expect(t.result().status).toBe("Could not refresh channels.");
  expect(t.refreshList).not.toHaveBeenCalled();
  act(() => t.result().retry?.());
  expect(t.refreshList).toHaveBeenCalledTimes(1);
});

it.each([true, false])(
  "renders the authored label and stable target with member visibility %s",
  (member) => {
    const name = "crew-ops [a] & <b>";
    const row = channel("stable", { name, private: true });
    const t = fixture([row]);
    render(t.element());
    const content = t.result().items[0]?.edit.text ?? "";
    const onOpenLink = vi.fn(() => member);
    const links = [
      {
        id: "links",
        key: "buzz.links/links",
        pluginId: "buzz.links",
        revision: "1",
        title: "Links",
        matches: () => true,
        component: ({ url }: { url: string }) => <LinkLabel href={url} />,
      },
    ];
    render(
      <MessageMarkdown
        row={{
          id: "message",
          channelId: "source",
          authorId: "author",
          content,
          createdAt: 1,
          mentions: [],
          participants: [],
          attachments: [],
          reactions: [],
          replyCount: 0,
        }}
        directory={{
          profiles: new Map(),
          agents: [],
          channels: member ? [row] : [],
        }}
        extensions={{
          tools: { snapshot: () => [], subscribe: () => () => {} },
          inline: { snapshot: () => [], subscribe: () => () => {} },
          links: { snapshot: () => links, subscribe: () => () => {} },
        }}
        media={() => undefined}
        onOpenLink={onOpenLink}
      />,
    );
    const link = screen.getByRole("link", { name: `#${name}` });
    expect(link.textContent).toBe(`#${name}`);
    expect(link.getAttribute("href")).toBe("buzz://channel/stable");
    expect(screen.getAllByRole("link")).toHaveLength(1);
    fireEvent.click(link);
    expect(onOpenLink).toHaveBeenCalledWith("buzz://channel/stable");
    if (!member)
      expect(screen.getByRole("status").textContent).toContain(
        "couldn’t be opened here",
      );
  },
);
