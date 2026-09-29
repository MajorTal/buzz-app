import { afterEach, expect, it, vi } from "vitest";
import { createPresenceActivity } from "./activity";
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("input is local, derived transitions are sparse, visibility is independent and disposal removes listeners", async () => {
  vi.useFakeTimers();
  const document = Object.assign(new EventTarget(), {
    visibilityState: "visible",
  });
  vi.stubGlobal("document", document);
  const activity = createPresenceActivity();
  const changed = vi.fn();
  activity.subscribe(changed);
  expect(activity.status()).toBe("online");
  await vi.advanceTimersByTimeAsync(599999);
  expect(activity.status()).toBe("online");
  await vi.advanceTimersByTimeAsync(1);
  expect(activity.status()).toBe("away");
  document.dispatchEvent(new Event("keydown"));
  expect(activity.status()).toBe("online");
  for (let i = 0; i < 1000; i++)
    document.dispatchEvent(new Event("pointermove"));
  expect(changed).toHaveBeenCalledTimes(2);
  document.visibilityState = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  expect(activity.visible()).toBe(false);
  expect(activity.status()).toBe("online");
  activity.dispose();
  document.dispatchEvent(new Event("keydown"));
  await vi.advanceTimersByTimeAsync(600000);
  expect(changed).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});
it("same-origin input wakes an idle peer without rebroadcast or per-input notifications", async () => {
  vi.useFakeTimers();
  const channels: {
    onmessage?: (event: { data: number }) => void;
    postMessage: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }[] = [];
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), { visibilityState: "visible" }),
  );
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      onmessage?: (event: { data: number }) => void;
      close = vi.fn();
      postMessage = vi.fn((data: number) => {
        for (const peer of channels)
          if (peer !== this) peer.onmessage?.({ data });
      });
      constructor() {
        channels.push(this);
      }
    },
  );
  const activity = createPresenceActivity(),
    changed = vi.fn();
  activity.subscribe(changed);
  await vi.advanceTimersByTimeAsync(600000);
  expect(activity.status()).toBe("away");
  channels[0]?.onmessage?.({ data: Date.now() + 100000 });
  expect(activity.status()).toBe("away");
  channels[0]?.onmessage?.({ data: Date.now() });
  expect(activity.status()).toBe("online");
  expect(channels[0]?.postMessage).not.toHaveBeenCalled();
  expect(changed).toHaveBeenCalledTimes(2);
  activity.dispose();
  expect(channels[0]?.close).toHaveBeenCalledOnce();
});
it("Online resumes automatic detection and migrates saved Online", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("localStorage", { getItem: () => "online", setItem: vi.fn() });
  const activity = createPresenceActivity();
  activity.setViewer("viewer");
  expect(activity.snapshot().preference).toBe("auto");
  activity.setPreference("online");
  await vi.advanceTimersByTimeAsync(600000);
  expect(activity.status()).toBe("away");
  activity.setPreference("online");
  expect(activity.snapshot().preference).toBe("auto");
  await vi.advanceTimersByTimeAsync(600000);
  expect(activity.status()).toBe("away");
  activity.dispose();
});

it("uses machine idle outside Buzz and falls back after native failures, with no late disposal work", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), { visibilityState: "visible" }),
  );
  const readIdle = vi.fn<() => Promise<number | null>>(async () => 0);
  const activity = createPresenceActivity(readIdle);
  await vi.advanceTimersByTimeAsync(600000);
  expect(activity.status()).toBe("online");
  readIdle.mockResolvedValue(600);
  await vi.advanceTimersByTimeAsync(600000);
  expect(activity.status()).toBe("away");
  readIdle.mockResolvedValue(0);
  await vi.advanceTimersByTimeAsync(30000);
  expect(activity.status()).toBe("online");
  readIdle.mockRejectedValue(new Error("unavailable"));
  await vi.advanceTimersByTimeAsync(600000);
  expect(activity.status()).toBe("away");
  let release!: (seconds: number) => void;
  readIdle.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await vi.advanceTimersByTimeAsync(30000);
  activity.dispose();
  release(0);
  await vi.advanceTimersByTimeAsync(0);
  expect(activity.status()).toBe("away");
  expect(vi.getTimerCount()).toBe(0);
});

it("notifies same-value commands across matching windows without rebroadcast", () => {
  vi.useFakeTimers();
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("localStorage", { getItem: () => "away", setItem: vi.fn() });
  const channels: {
    onmessage?: (event: { data: unknown }) => void;
    postMessage: ReturnType<typeof vi.fn>;
  }[] = [];
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      onmessage?: (event: { data: unknown }) => void;
      close() {}
      postMessage = vi.fn((data: unknown) => {
        for (const peer of channels)
          if (peer !== this) peer.onmessage?.({ data });
      });
      constructor() {
        channels.push(this);
      }
    },
  );
  const first = createPresenceActivity(),
    second = createPresenceActivity(),
    other = createPresenceActivity();
  try {
    first.setViewer("viewer");
    second.setViewer("viewer");
    other.setViewer("other");
    const before = second.command(),
      otherBefore = other.command();
    first.setPreference("away");
    expect(second.command()).toBe(before + 1);
    expect(other.command()).toBe(otherBefore);
    expect(channels[0]?.postMessage).toHaveBeenCalledExactlyOnceWith({
      viewer: "viewer",
      preference: "away",
    });
    expect(channels[1]?.postMessage).not.toHaveBeenCalled();
    expect(channels[2]?.postMessage).not.toHaveBeenCalled();
    expect(second.status()).toBe("away");
  } finally {
    first.dispose();
    second.dispose();
    other.dispose();
  }
});
