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
  vi.stubGlobal("window", {});
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
