// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import { useChannelTabState } from "./useChannelTabState";

afterEach(cleanup);

test("page remount restores each channel's tabs, selection and closed pane", () => {
  const session = {} as RelaySession;
  const mounted = renderHook(
    ({ channel }) => useChannelTabState(session, channel),
    { initialProps: { channel: "alpha" } },
  );
  act(() => {
    mounted.result.current.setTabs(() => [
      { id: "beta-tab", kind: "conversation", channelId: "beta" },
    ]);
    mounted.result.current.select("beta-tab");
    mounted.result.current.setPaneOpen(false);
  });
  mounted.rerender({ channel: "beta" });
  expect(mounted.result.current.tabs).toEqual([]);
  act(() =>
    mounted.result.current.setSettings({
      channelId: "beta",
    }),
  );
  mounted.unmount();
  const restored = renderHook(
    ({ channel }) => useChannelTabState(session, channel),
    { initialProps: { channel: "alpha" } },
  );
  expect(restored.result.current).toMatchObject({
    selected: "beta-tab",
    paneOpen: false,
    tabs: [{ id: "beta-tab", kind: "conversation", channelId: "beta" }],
  });
  restored.rerender({ channel: "beta" });
  expect(restored.result.current).toMatchObject({
    selected: "settings",
    paneOpen: true,
    settings: { channelId: "beta" },
  });
});

test("replacement sessions are isolated from retained state and old callbacks", () => {
  const first = {} as RelaySession;
  const second = {} as RelaySession;
  const mounted = renderHook(
    ({ session }) => useChannelTabState(session, "alpha"),
    { initialProps: { session: first } },
  );
  const oldSelect = mounted.result.current.select;
  act(() => oldSelect("old-tab"));
  mounted.rerender({ session: second });
  expect(mounted.result.current.selected).toBe("thread");
  act(() => oldSelect("late-old-tab"));
  expect(mounted.result.current.selected).toBe("thread");
  act(() => mounted.result.current.select("new-tab"));
  mounted.rerender({ session: first });
  expect(mounted.result.current.selected).toBe("late-old-tab");
});

test("closing and reopening settings starts a fresh view while hiding the pane retains it", () => {
  const session = {} as RelaySession;
  const mounted = renderHook(() => useChannelTabState(session, "alpha"));
  act(() => mounted.result.current.setSettings({ channelId: "alpha" }));
  const opening = mounted.result.current.settings;
  act(() => mounted.result.current.setPaneOpen(false));
  act(() => mounted.result.current.setPaneOpen(true));
  expect(mounted.result.current.settings).toBe(opening);
  act(() => mounted.result.current.setSettings({ channelId: "alpha" }));
  expect(mounted.result.current.settings).toBe(opening);
  act(() => mounted.result.current.setSettings(undefined));
  act(() => mounted.result.current.setSettings({ channelId: "alpha" }));
  expect(mounted.result.current.settings?.id).not.toBe(opening?.id);
});
