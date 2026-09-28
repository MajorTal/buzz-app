// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RelaySession } from "../relay/session";
import type { ThreadSnapshot } from "../relay/threads";
import type { PageNavigation } from "../navigation/service";
import { SessionMessageTarget } from "./SessionMessageTarget";

const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollIntoView",
);
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  // Browser-only APIs are fixture boundaries; actual layout is tested in Playwright.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  if (originalScrollIntoView)
    Object.defineProperty(
      HTMLElement.prototype,
      "scrollIntoView",
      originalScrollIntoView,
    );
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  vi.unstubAllGlobals();
});
function setup() {
  const views: ReturnType<typeof makeView>[] = [];
  function makeView() {
    let snapshot: ThreadSnapshot = {
      status: "loading",
      root: undefined,
      replies: [],
      error: undefined,
      canLoadMore: false,
      limited: false,
      targetStatus: "loading",
    };
    const listeners = new Set<() => void>();
    return {
      snapshot: () => snapshot,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      refresh: vi.fn(async () => {}),
      loadMore: vi.fn(async () => {}),
      dispose: vi.fn(),
      update(next: Partial<ThreadSnapshot>) {
        snapshot = { ...snapshot, ...next };
        for (const listener of listeners) listener();
      },
    };
  }
  const profiles = new Map();
  const channels = { status: "ready", channels: [] };
  const unread = { manual: "none" };
  const session = {
    unread: { snapshot: () => unread, subscribe: () => () => {} },
    presence: {
      status: () => "unknown",
      limited: () => false,
      subscribe: () => () => {},
    } satisfies Pick<
      RelaySession["presence"],
      "status" | "limited" | "subscribe"
    >,
    thread: vi.fn(() => {
      const view = makeView();
      views.push(view);
      return view;
    }),
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: async () => {},
    },
    channels: { list: () => channels, subscribeList: () => () => {} },
    messages: {},
    media: () => undefined,
  } as unknown as RelaySession;
  function request(id: string) {
    const controller = new AbortController();
    const navigation = {
      entryId: id,
      signal: controller.signal,
      complete: vi.fn((result) => {
        if (result.status === "failed") controller.abort();
        return true;
      }),
    } as unknown as PageNavigation;
    return { navigation, controller };
  }
  const props = {
    session,
    scope: "test",
    channelId: "channel",
    messageId: "target",
    onOpenLink: () => false,
    onLatest: vi.fn(),
    onRetry: vi.fn(),
  };
  return { views, session, request, props };
}

it.each(["unavailable", "error"] as const)(
  "reports %s and offers a fresh navigation retry",
  async (targetStatus) => {
    const test = setup(),
      { navigation } = test.request("first");
    render(
      <StrictMode>
        <SessionMessageTarget {...test.props} navigation={navigation} />
      </StrictMode>,
    );
    expect(test.views[0]?.dispose).toHaveBeenCalled();
    const current = test.views.at(-1);
    if (!current) throw new Error("Reader did not mount");
    expect(current.refresh).toHaveBeenCalledOnce();
    act(() => current.update({ targetStatus }));
    expect(navigation.complete).toHaveBeenCalledWith({
      status: "failed",
      reason: targetStatus === "unavailable" ? "not-found" : "unavailable",
    });
    expect(current.dispose).toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("could not be opened");
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Retry message" }));
    expect(test.props.onRetry).toHaveBeenCalledOnce();
  },
);

it("offers retry when allocating an exact reader fails", () => {
  const test = setup(),
    { navigation } = test.request("first");
  vi.mocked(test.session.thread).mockImplementation(() => {
    throw new Error("Access revoked");
  });
  render(<SessionMessageTarget {...test.props} navigation={navigation} />);
  expect(navigation.complete).toHaveBeenCalledWith({
    status: "failed",
    reason: "unavailable",
  });
  expect(screen.getByRole("button", { name: "Retry message" })).toBeVisible();
});

it("disposes a superseded reader and ignores late results, then disposes on unmount", () => {
  const test = setup(),
    first = test.request("first"),
    next = test.request("next");
  const mounted = render(
    <SessionMessageTarget {...test.props} navigation={first.navigation} />,
  );
  const old = test.views.at(-1);
  if (!old) throw new Error("Reader did not mount");
  mounted.rerender(
    <SessionMessageTarget
      {...test.props}
      navigation={next.navigation}
      messageId="next-target"
    />,
  );
  expect(old.dispose).toHaveBeenCalled();
  act(() => old.update({ targetStatus: "unavailable" }));
  expect(first.navigation.complete).not.toHaveBeenCalled();
  expect(next.navigation.complete).not.toHaveBeenCalled();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Loading selected message",
  );
  mounted.unmount();
  expect(test.views.at(-1)?.dispose).toHaveBeenCalled();
});

it("keeps a verified exact target readable if unrelated thread context fails", async () => {
  const test = setup(),
    { navigation, controller } = test.request("first");
  render(<SessionMessageTarget {...test.props} navigation={navigation} />);
  const current = test.views.at(-1);
  if (!current) throw new Error("Reader did not mount");
  act(() =>
    current.update({
      status: "error",
      error: "Thread context failed",
      targetStatus: "ready",
      target: {
        id: "target",
        channelId: "channel",
        authorId: "author",
        content: "Selected reply",
        createdAt: 1,
        mentions: [],
        participants: [],
        attachments: [],
        reactions: [],
        replyCount: 0,
      },
    }),
  );
  const selected = screen.getByText("Selected reply");
  expect(selected).toBeVisible();
  // Let reveal run before teardown; rendering text alone can outrun its frame.
  await waitFor(() =>
    expect(selected.closest("[data-message-id]")).toHaveFocus(),
  );
  await waitFor(() =>
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({
      block: "start",
      inline: "nearest",
      behavior: "instant",
    }),
  );
  expect(navigation.complete).not.toHaveBeenCalled();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Back to latest" }));
  expect(test.props.onLatest).toHaveBeenCalledOnce();
  act(() => controller.abort());
  expect(current.dispose).toHaveBeenCalled();
  expect(screen.queryByText("Selected reply")).not.toBeInTheDocument();
});

it("shows removal and retry after an opened navigation can no longer fail", async () => {
  const test = setup(),
    { navigation } = test.request("opened");
  vi.mocked(navigation.complete).mockReturnValue(false);
  render(<SessionMessageTarget {...test.props} navigation={navigation} />);
  const current = test.views.at(-1);
  if (!current) throw new Error("Reader did not mount");
  act(() => current.update({ targetStatus: "unavailable" }));
  expect(navigation.signal.aborted).toBe(false);
  expect(screen.getByRole("alert")).toHaveTextContent("could not be opened");
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Retry message" }));
  expect(test.props.onRetry).toHaveBeenCalledOnce();
});
