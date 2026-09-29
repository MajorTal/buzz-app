// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useReading } from "./use-reading";
import type { RelaySession } from "../relay/session";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function setup({
  supported = true,
  focused = true,
  settled = true,
  strict = false,
} = {}) {
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockReturnValue(focused);
  let visibility: DocumentVisibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility,
  );
  const element = document.createElement("div");
  element.tabIndex = 0;
  const outside = document.createElement("button");
  document.body.append(element, outside);
  element.focus();
  vi.spyOn(element, "getClientRects").mockReturnValue([
    new DOMRect(0, 0, 500, 500),
  ] as unknown as DOMRectList);
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 500, 500),
  );
  element.replaceChildren(
    row("visible", 100, 200),
    row("overscan", 600, 700),
    row("clipped", 450, 550),
  );
  const scroller = { current: element };
  const position = { current: settled };
  let mutation = () => {};
  const disconnected = vi.fn();
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(callback: () => void) {
        mutation = callback;
      }
      observe() {}
      disconnect = disconnected;
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect = disconnected;
    },
  );
  const leases: {
    view: ReturnType<typeof vi.fn>;
    observe: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }[] = [];
  let observe = async () => {};
  const reading = vi.fn(() => {
    const lease = {
      view: vi.fn(),
      observe: vi.fn(() => observe()),
      dispose: vi.fn(),
    };
    leases.push(lease);
    return lease;
  });
  const session = {
    unread: {
      sync: () => ({ capability: supported ? "frontier-sync" : "unsupported" }),
      reading,
    },
  } as unknown as RelaySession;
  const view = renderHook(useReading, {
    initialProps: { session, channelId: "room", scroller, settled: position },
    reactStrictMode: strict,
  });
  return {
    element,
    outside,
    session,
    reading,
    leases,
    position,
    disconnected,
    mutation: () => mutation(),
    setVisibility: (next: DocumentVisibilityState) => {
      visibility = next;
    },
    setObserve: (next: typeof observe) => {
      observe = next;
    },
    setRows: (next: HTMLElement[]) => element.replaceChildren(...next),
    retarget: (channelId: string, nextSession = session) =>
      view.rerender({
        session: nextSession,
        channelId,
        scroller,
        settled: position,
      }),
    unmount: view.unmount,
  };
}
function row(id: string, top: number, bottom: number) {
  const element = document.createElement("div");
  element.dataset.messageId = id;
  if (id === "membership") element.dataset.membershipRow = "";
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, top, 400, bottom - top),
  );
  return element;
}
it("reports only fully visible settled evidence after dwell, not mounted overscan", () => {
  const h = setup();
  expect(h.reading).toHaveBeenCalledExactlyOnceWith("room");
  vi.advanceTimersByTime(749);
  expect(h.leases[0]?.observe).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(h.leases[0]?.observe).toHaveBeenCalledExactlyOnceWith(["visible"]);
});
it.each([{ focused: false }, { settled: false }])(
  "does not allocate reading from background/unsettled views: %j",
  (options) => {
    const h = setup(options);
    vi.advanceTimersByTime(1000);
    expect(h.reading).not.toHaveBeenCalled();
  },
);
it("captures the cancellable lease before dwell and disposes it on hidden/unmount", () => {
  const h = setup();
  vi.advanceTimersByTime(300);
  h.setVisibility("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  vi.advanceTimersByTime(1000);
  expect(h.leases[0]?.observe).not.toHaveBeenCalled();
  expect(h.leases[0]?.dispose).toHaveBeenCalledTimes(1);
  h.setVisibility("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  h.unmount();
  vi.advanceTimersByTime(1000);
  expect(h.leases[1]?.observe).not.toHaveBeenCalled();
  expect(h.disconnected).toHaveBeenCalled();
});
it("scroll and content changes restart dwell; a row seen only at the end is not read", () => {
  const h = setup();
  vi.advanceTimersByTime(300);
  h.element.dispatchEvent(new Event("scroll"));
  expect(h.leases[0]?.dispose).toHaveBeenCalled();
  vi.advanceTimersByTime(300);
  h.setRows([row("replacement", 100, 200)]);
  h.mutation();
  vi.advanceTimersByTime(749);
  expect(h.leases[2]?.observe).not.toHaveBeenCalled();
  h.setRows([row("new-at-end", 100, 200)]);
  vi.advanceTimersByTime(1);
  expect(h.leases[2]?.observe).not.toHaveBeenCalled();
});
it("active content reflow cannot revoke dwell already queued for durability", async () => {
  const h = setup();
  let release: (() => void) | undefined;
  h.setObserve(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  try {
    vi.advanceTimersByTime(750);
    expect(h.leases[0]?.observe).toHaveBeenCalledExactlyOnceWith(["visible"]);

    h.mutation();
    expect(h.leases[0]?.dispose).not.toHaveBeenCalled();
    h.outside.focus();
    h.element.dispatchEvent(
      Object.assign(new Event("focusout"), { relatedTarget: null }),
    );
    expect(h.leases[0]?.dispose).toHaveBeenCalledTimes(1);
  } finally {
    release?.();
    await vi.runAllTimersAsync();
  }
  expect(h.leases[0]?.dispose).toHaveBeenCalledTimes(1);
});
it("focus leaving the reading surface cancels pending evidence", () => {
  const h = setup();
  h.outside.focus();
  h.element.dispatchEvent(
    Object.assign(new Event("focusout"), { relatedTarget: null }),
  );
  vi.advanceTimersByTime(1000);
  expect(h.leases[0]?.observe).not.toHaveBeenCalled();
});

it("reports qualified viewing even without read sync, but never publishes read intent", () => {
  const h = setup({ supported: false });
  expect(h.leases[0]?.view).toHaveBeenCalledExactlyOnceWith(
    ["visible"],
    expect.any(Function),
  );
  vi.advanceTimersByTime(1000);
  expect(h.leases[0]?.observe).not.toHaveBeenCalled();
});
it("the viewing validity callback rechecks focus and settled positioning synchronously", () => {
  const h = setup();
  const visible = h.leases[0]?.view.mock.calls[0]?.[1];
  expect(visible()).toBe(true);
  h.position.current = false;
  expect(visible()).toBe(false);
  h.position.current = true;
  h.outside.focus();
  expect(visible()).toBe(false);
  h.unmount();
  expect(visible()).toBe(false);
});

it("membership activity cannot abort acknowledgment of a visible message below it", () => {
  const h = setup();
  h.setRows([row("membership", 10, 50), row("conversation", 100, 200)]);
  h.mutation();
  vi.advanceTimersByTime(750);
  expect(h.leases.at(-1)?.observe).toHaveBeenCalledExactlyOnceWith([
    "conversation",
  ]);
});

it("releases the old channel and session on rerender and only observes the current lease", () => {
  const h = setup();
  vi.advanceTimersByTime(300);
  const oldValidity = h.leases[0]?.view.mock.calls[0]?.[1];
  h.retarget("next-room");
  expect(h.leases[0]?.dispose).toHaveBeenCalledOnce();
  expect(oldValidity()).toBe(false);
  expect(h.reading).toHaveBeenLastCalledWith("next-room");
  const nextReading = vi.fn((_channelId: string) => h.reading());
  h.retarget("next-room", {
    ...h.session,
    unread: { ...h.session.unread, reading: nextReading },
  });
  expect(h.leases[1]?.dispose).toHaveBeenCalledOnce();
  expect(nextReading).toHaveBeenCalledExactlyOnceWith("next-room");
  vi.advanceTimersByTime(749);
  for (const lease of h.leases) expect(lease.observe).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(h.leases[2]?.observe).toHaveBeenCalledExactlyOnceWith(["visible"]);
  h.unmount();
  expect(h.leases[2]?.dispose).toHaveBeenCalledOnce();
});

it("StrictMode releases its probe lease and disconnects observation on unmount", () => {
  const h = setup({ strict: true });
  expect(h.leases).toHaveLength(2);
  expect(h.leases[0]?.dispose).toHaveBeenCalledOnce();
  expect(h.leases[1]?.dispose).not.toHaveBeenCalled();
  const validity = h.leases[1]?.view.mock.calls[0]?.[1];
  h.unmount();
  expect(validity()).toBe(false);
  for (const lease of h.leases) expect(lease.dispose).toHaveBeenCalledOnce();
  expect(h.disconnected).toHaveBeenCalledTimes(4);
  act(() => {
    elementEvents(h.element);
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(1000);
  });
  expect(h.reading).toHaveBeenCalledTimes(2);
  for (const lease of h.leases) expect(lease.observe).not.toHaveBeenCalled();
});
function elementEvents(element: HTMLElement) {
  for (const name of ["scroll", "pointerdown", "keydown", "focusin"])
    element.dispatchEvent(new Event(name));
}
