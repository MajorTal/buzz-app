import { useReading } from "./use-reading";
import { beforeEach, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { ThreadPanel } from "./ThreadPanel";
import { MessageRow } from "./MessageRow";
import { MessageMarkdown } from "./MessageMarkdown";
import { MessageComposer } from "./MessageComposer";
import type { RelaySession } from "../relay/session";
import type { ThreadSnapshot, ThreadView } from "../relay/threads";
import type { ChannelMessage } from "../relay/contracts";

// Shallow production-boundary checks. These invoke returned handlers and effect
// lifetimes; they do not claim browser layout, focus, or React StrictMode validation.
// Reading geometry/dwell has its own real-hook boundary suite. This fixture
// deliberately supplies only the DOM shape needed for positioning.
vi.mock("./use-reading", () => ({ useReading: vi.fn() }));
const hooks = vi.hoisted(() => ({
  refs: [] as { current: unknown }[],
  ref: 0,
  states: [] as unknown[],
  index: 0,
  effects: [] as {
    deps: readonly unknown[];
    cleanup?: (() => void) | undefined;
  }[],
  effect: 0,
  pending: [] as (() => void)[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  memo: (fn: unknown) => fn,
  useCallback: (fn: unknown) => fn,
  useRef(initial: unknown) {
    const index = hooks.ref++;
    hooks.refs[index] ??= { current: initial };
    return hooks.refs[index];
  },
  useMemo: (fn: () => unknown) => fn(),
  useState(initial: unknown) {
    const index = hooks.index++;
    if (!(index in hooks.states)) hooks.states[index] = initial;
    return [
      hooks.states[index],
      (next: unknown) => {
        hooks.states[index] =
          typeof next === "function" ? next(hooks.states[index]) : next;
      },
    ];
  },
  useEffect(create: () => (() => void) | undefined, deps: readonly unknown[]) {
    const index = hooks.effect++;
    const old = hooks.effects[index];
    if (!old || deps.some((value, i) => value !== old.deps[i]))
      hooks.pending.push(() => {
        old?.cleanup?.();
        hooks.effects[index] = { deps, cleanup: create() };
      });
  },
  useLayoutEffect(
    create: () => (() => void) | undefined,
    deps: readonly unknown[],
  ) {
    const index = hooks.effect++;
    const old = hooks.effects[index];
    if (!old || deps.some((value, i) => value !== old.deps[i]))
      hooks.pending.push(() => {
        old?.cleanup?.();
        hooks.effects[index] = { deps, cleanup: create() };
      });
  },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) =>
    snapshot(),
}));
vi.mock("../relay/react", () => {
  const profiles = new Map();
  return { useRowProfiles: () => profiles };
});
beforeEach(() =>
  Object.assign(hooks, {
    refs: [],
    ref: 0,
    states: [],
    index: 0,
    effects: [],
    effect: 0,
    pending: [],
  }),
);
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function button(tree: ReactNode, label: string) {
  const found = elements(tree).find(
    (e) =>
      e.type === "button" &&
      (e.props.children === label || e.props["aria-label"] === label),
  );
  expect(found, label).toBeDefined();
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}
const row: ChannelMessage = {
  id: "a".repeat(64),
  channelId: "channel",
  authorId: "b".repeat(64),
  content: "root",
  createdAt: 1,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 2,
};
function setup() {
  const snapshot: ThreadSnapshot = {
    status: "ready",
    root: row,
    replies: [],
    error: undefined,
    canLoadMore: false,
    limited: false,
  };
  const view = {
    snapshot: () => ({ ...snapshot }),
    subscribe: () => () => {},
    refresh: vi.fn(async () => {}),
    loadMore: vi.fn(async () => {}),
    dispose: vi.fn(),
  } satisfies ThreadView;
  const thread = vi.fn(() => view);
  const ensure = vi.fn(async () => {});
  const session = {
    thread,
    profiles: { ensure },
    messages: { retry: vi.fn() },
    // Geometry fixtures are read-only; reading behavior has its own boundary tests.
    unread: { sync: () => ({ capability: "unsupported" }) },
    media: () => undefined,
  } as unknown as RelaySession;
  const close = vi.fn();
  function render() {
    hooks.ref = hooks.index = hooks.effect = 0;
    const scoped = ThreadPanel({
      session,
      scope: "scope",
      channelName: "General",
      channelId: "channel",
      messageId: row.id,
      close,
      onOpenLink: () => false,
    });
    return (
      scoped.type as (
        props: typeof scoped.props,
      ) => ReactElement<{ onKeyDown(event: unknown): void }>
    )(scoped.props);
  }
  const effects = () => {
    for (const effect of hooks.pending.splice(0)) effect();
  };
  const unmount = () => {
    for (const effect of hooks.effects) effect.cleanup?.();
  };
  return {
    snapshot,
    view,
    thread,
    ensure,
    session,
    close,
    render,
    effects,
    unmount,
  };
}
it("allocates only in the committed effect and disposes each owned view across effect remount", () => {
  const h = setup();
  const tree = h.render();
  expect(h.thread).not.toHaveBeenCalled();
  h.effects();
  expect(h.thread).toHaveBeenCalledExactlyOnceWith("channel", row.id);
  expect(h.view.refresh).toHaveBeenCalledTimes(1);
  (button(tree, "Close thread").props.onClick as () => void)();
  expect(h.close).toHaveBeenCalledTimes(1);
  const stopPropagation = vi.fn();
  tree.props.onKeyDown({ key: "Escape", stopPropagation } as never);
  expect(stopPropagation).toHaveBeenCalledTimes(1);
  expect(h.close).toHaveBeenCalledTimes(2);
  h.unmount();
  expect(h.view.dispose).toHaveBeenCalledTimes(1);
  hooks.effects = [];
  h.render();
  h.effects();
  expect(h.thread).toHaveBeenCalledTimes(2);
  h.unmount();
  expect(h.view.dispose).toHaveBeenCalledTimes(2);
});
it("allocation failure exposes an effective retry rather than leaving a spinner", () => {
  const h = setup();
  h.thread.mockImplementationOnce(() => {
    throw new Error("capacity");
  });
  h.render();
  h.effects();
  const failed = h.render();
  (button(failed, "Retry thread").props.onClick as () => void)();
  h.render();
  h.effects();
  expect(h.thread).toHaveBeenCalledTimes(2);
  expect(h.view.refresh).toHaveBeenCalledTimes(1);
  h.unmount();
});
it("loads history automatically with error-only retry and no routine history controls", () => {
  const h = setup();
  h.render();
  h.effects();
  const panel = h.render();
  const child = elements(panel).find((e) => typeof e.type === "function");
  if (!child) throw new Error("Missing thread messages");
  const renderMessages = child.type as (
    props: Record<string, unknown>,
  ) => ReactElement;
  const render = () => {
    hooks.ref = hooks.index = hooks.effect = 0;
    return renderMessages(child.props);
  };
  hooks.effects = [];
  hooks.refs = [];
  hooks.states = [];
  vi.mocked(useReading).mockClear();
  const tree = render();
  expect(useReading).toHaveBeenCalledWith({
    session: h.session,
    channelId: "channel",
    scroller: expect.objectContaining({ current: null }),
    settled: expect.objectContaining({ current: false }),
  });
  h.effects();
  expect(h.ensure).toHaveBeenCalledExactlyOnceWith(
    [row.authorId],
    "background",
  );
  expect(
    elements(tree).some((e) => e.props.children === "Refresh thread"),
  ).toBe(false);
  expect(elements(tree).some((e) => e.props.children === "Retry thread")).toBe(
    false,
  );
  expect(
    elements(tree).some(
      (e) =>
        e.props.children ===
        "Existing history may be incomplete. New replies appear automatically.",
    ),
  ).toBe(false);
  expect(
    elements(tree).some((e) => e.props.children === "Load more replies"),
  ).toBe(false);
  expect(h.view.loadMore).not.toHaveBeenCalled();
  const mutable = h.snapshot as {
    status: string;
    error: string | undefined;
    canLoadMore: boolean;
    limited: boolean;
  };
  mutable.canLoadMore = true;
  render();
  h.effects();
  expect(h.view.loadMore).toHaveBeenCalledTimes(1);
  mutable.status = "loading";
  render();
  h.effects();
  expect(h.view.loadMore).toHaveBeenCalledTimes(1);
  mutable.status = "error";
  mutable.error = "offline";
  (button(render(), "Retry thread").props.onClick as () => void)();
  h.effects();
  expect(h.view.loadMore).toHaveBeenCalledTimes(1);
  expect(h.view.refresh).toHaveBeenCalledTimes(2);
  mutable.status = "ready";
  mutable.error = undefined;
  mutable.canLoadMore = false;
  expect(elements(render()).some((e) => e.type === "footer")).toBe(false);
  mutable.limited = true;
  expect(
    elements(render()).some(
      (e) => e.props.children === "Thread history limit reached.",
    ),
  ).toBe(true);
  mutable.status = "error";
  mutable.error = "Thread view exceeded its memory limit.";
  const failed = render();
  expect(
    elements(failed).some(
      (e) =>
        typeof e.props.children === "string" &&
        e.props.children.includes("appear automatically"),
    ),
  ).toBe(false);
  (button(failed, "Retry thread").props.onClick as () => void)();
  expect(h.view.refresh).toHaveBeenCalledTimes(3);
  h.effects();
  expect(h.ensure).toHaveBeenCalledTimes(1); // No render-driven missing-profile loop.
});
it("bounds enlarged emoji presentation on sent messages", () => {
  const message = (content: string) =>
    elements(
      MessageRow({
        row: { ...row, content },
        profile: undefined,
        media: () => undefined,
        onOpenLink: () => false,
        day: false,
        retry: undefined,
      }),
    ).find((element) => element.type === MessageMarkdown);
  expect(message("😀 🙏 👏")?.props.largeEmoji).toBe(true);
  expect(message("😀 🙏 👏 😄")?.props.largeEmoji).toBe(false);
});

it("the actual message row rejects attachment URLs outside the shared safe-link policy", () => {
  const tree = MessageRow({
    row: {
      ...row,
      attachments: [
        { url: "https://safe.test/a.png", video: false },
        { url: "https://user:secret@unsafe.test/a.png", video: false },
        { url: "http://unsafe.test/a.png", video: false },
      ],
    },
    profile: undefined,
    media: () => undefined,
    onOpenLink: () => false,
    day: false,
    retry: undefined,
  });
  const links = elements(tree).filter((element) => element.type === "a");
  expect(links).toHaveLength(1);
  expect(links[0]?.props).toMatchObject({
    href: "https://safe.test/a.png",
    rel: "noreferrer",
  });
});

it("the actual message reply button opens that message and retains the trigger focus target", () => {
  const open = vi.fn(),
    focus = vi.fn();
  const tree = MessageRow({
    row,
    profile: undefined,
    media: () => undefined,
    onOpenLink: () => false,
    day: false,
    retry: undefined,
    onOpenThread: open,
  });
  (
    button(tree, "View thread: 2 replies").props.onClick as (
      event: unknown,
    ) => void
  )({ currentTarget: { focus } });
  expect(focus).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledExactlyOnceWith(row.id);
});

function messagesHarness() {
  const h = setup();
  h.render();
  h.effects();
  const child = elements(h.render()).find((e) => typeof e.type === "function");
  if (!child) throw new Error("Missing thread messages");
  const props = child.props;
  const component = child.type as (
    props: Record<string, unknown>,
  ) => ReactElement;
  hooks.effects = [];
  hooks.refs = [];
  hooks.states = [];
  let scrollTop = 0;
  const element = {
    clientHeight: 600,
    scrollHeight: 4000,
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(value: number) {
      scrollTop = Math.max(
        0,
        Math.min(value, this.scrollHeight - this.clientHeight),
      );
    },
  };
  let tree: ReactNode;
  function render() {
    hooks.ref = hooks.index = hooks.effect = 0;
    tree = component(props);
    const section = elements(tree).find(
      (e) => e.props["aria-label"] === "Thread messages",
    );
    if (!section) throw new Error("Missing history region");
    (section.props.ref as { current: unknown }).current = element;
    return section;
  }
  return {
    ...h,
    render,
    tree: () => tree,
    click(label: string) {
      (button(tree, label).props.onClick as () => void)();
    },
    scroll(top: number) {
      element.scrollTop = top;
      const section = elements(tree).find(
        (e) => e.props["aria-label"] === "Thread messages",
      );
      if (!section) throw new Error("Missing history region");
      (section.props.onScroll as (event: unknown) => void)({
        currentTarget: element,
      });
    },
    element,
    snapshot: h.snapshot as {
      status: ThreadSnapshot["status"];
      replies: readonly ChannelMessage[];
      root: ChannelMessage | undefined;
      canLoadMore: boolean;
      limited: boolean;
    },
  };
}
it("positions after successful history loading, then follows live replies without another read", () => {
  const h = messagesHarness();
  h.snapshot.status = "loading";
  h.render();
  h.effects();
  expect(h.element.scrollTop).toBe(0);
  h.snapshot.status = "error";
  h.render();
  h.effects();
  expect(h.element.scrollTop).toBe(0);
  h.snapshot.status = "ready";
  h.render();
  h.effects();
  expect(h.element.scrollTop).toBe(3400);
  h.scroll(3400);
  h.snapshot.replies = [{ ...row, id: "new", content: "live arrival" }];
  h.element.scrollHeight = 4800;
  const section = h.render();
  h.effects();
  expect(h.element.scrollTop).toBe(4200);
  expect(
    elements(section).some(
      (e) =>
        e.type === MessageRow &&
        (e.props.row as ChannelMessage).content === "live arrival",
    ),
  ).toBe(true);
  expect(h.view.refresh).toHaveBeenCalledTimes(1); // Initial open only.
  expect(h.view.loadMore).not.toHaveBeenCalled();
});
it("preserves reading above the bottom through live updates and refresh, then resumes following on return", () => {
  const h = messagesHarness();
  h.render();
  h.effects();
  h.scroll(500);
  h.snapshot.replies = [{ ...row, id: "new", content: "live arrival" }];
  h.element.scrollHeight = 4800;
  h.render();
  h.effects();
  expect(h.element.scrollTop).toBe(500);
  h.snapshot.status = "loading";
  h.render();
  h.effects();
  h.snapshot.status = "ready";
  h.render();
  h.effects();
  expect(h.element.scrollTop).toBe(500);
  h.scroll(4200);
  h.snapshot.replies = [...h.snapshot.replies, { ...row, id: "next" }];
  h.element.scrollHeight = 5500;
  h.render();
  h.effects();
  expect(h.element.scrollTop).toBe(4900);
});
it("uses the resolved root with the shared composer and reveals an own send even while reading above", () => {
  const h = messagesHarness();
  h.snapshot.root = { ...row, id: "resolved-root" };
  h.render();
  h.effects();
  const composer = elements(h.tree()).find((e) => e.type === MessageComposer);
  expect(composer?.props).toMatchObject({
    session: h.session,
    scope: "scope",
    channelId: "channel",
    channelName: "General",
    threadRootId: "resolved-root",
  });
  expect(elements(h.tree()).some((e) => e.type === "footer")).toBe(false);
  h.scroll(500);
  if (!composer) throw new Error("Missing composer");
  (composer.props.onSend as (id: string) => void)("own-reply");
  h.snapshot.replies = [{ ...row, id: "own-reply" }];
  h.element.scrollHeight = 4800;
  const section = h.render();
  h.effects();
  expect(h.element.scrollTop).toBe(4200);
  const reply = elements(section).find(
    (e) =>
      e.type === MessageRow &&
      (e.props.row as ChannelMessage).id === "own-reply",
  );
  expect(reply?.props.retry).toBe(h.session.messages.retry);
  h.snapshot.root = undefined;
  h.render();
  expect(elements(h.tree()).some((e) => e.type === MessageComposer)).toBe(
    false,
  );
});
it.each([
  { gap: 79, follows: true },
  { gap: 80, follows: false },
])(
  "uses the main timeline's near-bottom threshold: gap=$gap",
  ({ gap, follows }) => {
    const h = messagesHarness();
    h.render();
    h.effects();
    h.scroll(3400 - gap);
    h.snapshot.replies = [{ ...row, id: "new" }];
    h.element.scrollHeight = 4800;
    h.render();
    h.effects();
    expect(h.element.scrollTop).toBe(follows ? 4200 : 3400 - gap);
  },
);
it("finishes automatic pages before initial positioning and preserves a reader’s intervening scroll", () => {
  const h = messagesHarness();
  h.snapshot.canLoadMore = true;
  h.render();
  h.effects();
  expect(h.view.loadMore).toHaveBeenCalledTimes(1);
  expect(h.element.scrollTop).toBe(0);
  const section = h.render();
  (section.props.onWheel as () => void)();
  h.scroll(500);
  h.snapshot.status = "loading";
  h.render();
  h.effects();
  h.snapshot.status = "ready";
  h.snapshot.canLoadMore = false;
  h.snapshot.replies = [{ ...row, id: "history" }];
  h.element.scrollHeight = 4800;
  h.render();
  h.effects();
  expect(h.element.scrollTop).toBe(500);
  h.scroll(4200);
  h.snapshot.replies = [...h.snapshot.replies, { ...row, id: "live" }];
  h.element.scrollHeight = 5500;
  h.render();
  h.effects();
  expect(h.element.scrollTop).toBe(4900);
});
it.each([false, true])(
  "positions after automatic loading stops (limited=%s), without restarting pagination",
  (limited) => {
    const h = messagesHarness();
    h.snapshot.canLoadMore = true;
    h.render();
    h.effects();
    expect(h.element.scrollTop).toBe(0);
    expect(h.view.loadMore).toHaveBeenCalledTimes(1);
    h.snapshot.status = "loading";
    h.render();
    h.effects();
    expect(h.view.loadMore).toHaveBeenCalledTimes(1);
    h.snapshot.status = "ready";
    h.snapshot.canLoadMore = false;
    h.snapshot.limited = limited;
    h.snapshot.replies = [{ ...row, id: "history" }];
    h.element.scrollHeight = 4800;
    h.render();
    h.effects();
    expect(h.element.scrollTop).toBe(4200);
    expect(h.view.loadMore).toHaveBeenCalledTimes(1);
  },
);
it.each(["onWheel", "onTouchMove", "onPointerDown", "onKeyDown"])(
  "a user %s gesture before the page completes wins over initial positioning",
  (handler) => {
    const h = messagesHarness();
    h.snapshot.status = "loading";
    const section = h.render();
    h.effects();
    (section.props[handler] as (event: unknown) => void)({ key: "PageUp" });
    h.snapshot.status = "ready";
    h.render();
    h.effects();
    expect(h.element.scrollTop).toBe(0);
  },
);
it("shows bounded participant avatars on the real reply control, through the media boundary with fallback initials", () => {
  const participants = ["p1", "p2", "p3", "p4", "p5"];
  const media = vi.fn((url: string) =>
    url === "https://safe/avatar" ? "https://proxy/avatar" : undefined,
  );
  const tree = MessageRow({
    row: { ...row, participants },
    profile: undefined,
    participantProfiles: new Map([
      ["p1", { name: "Alice", picture: "https://safe/avatar" }],
      ["p2", { name: "Brain", picture: "http://unsafe" }],
    ]),
    media,
    onOpenLink: () => false,
    day: false,
    retry: undefined,
    onOpenThread: () => {},
  });
  const control = button(tree, "View thread: 2 replies");
  const images = elements(control).filter((e) => e.type === "img");
  expect(images).toHaveLength(1);
  expect(images[0]?.props).toMatchObject({
    src: "https://proxy/avatar",
    alt: "",
    loading: "lazy",
  });
  const image = { hidden: false };
  const avatar = images[0];
  if (!avatar) throw new Error("Missing avatar");
  (avatar.props.onError as (event: unknown) => void)({
    currentTarget: image,
  });
  expect(image.hidden).toBe(true);
  expect(
    elements(control)
      .filter((e) => e.props.title)
      .map((e) => e.props.title),
  ).toEqual(["Alice", "Brain", "p3"]);
  expect(
    elements(control).some(
      (e) =>
        Array.isArray(e.props.children) &&
        e.props.children[0] === "+" &&
        e.props.children[1] === 2,
    ),
  ).toBe(true);
});
