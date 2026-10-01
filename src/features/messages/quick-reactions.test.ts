// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import type { CustomEmoji } from "../relay/emoji";
import { afterEach, expect, it, vi } from "vitest";
import {
  quickReactions,
  recordReaction,
  useQuickReactions,
} from "./quick-reactions";
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});
it("ranks saved reactions per viewer/community and filters unavailable custom emoji", () => {
  recordReaction("one:viewer", "🎉");
  recordReaction("one:viewer", "🎉");
  recordReaction("one:viewer", ":party:");
  expect(quickReactions("one:viewer", [])).toEqual(["🎉", "👍", "❤️"]);
  expect(
    quickReactions("one:viewer", [
      { shortcode: "party", url: "https://a.test/p" },
    ]),
  ).toEqual(["🎉", ":party:", "👍"]);
  expect(quickReactions("one:other", [])).toEqual(["👍", "❤️", "😂"]);
});
it("falls back safely with corrupt data or unavailable storage", () => {
  localStorage.setItem("buzz.quick-reactions.v1:one", '{"bad":true}');
  expect(quickReactions("one", [])).toEqual(["👍", "❤️", "😂"]);
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("denied");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("denied");
  });
  expect(() => recordReaction("one", "🎉")).not.toThrow();
  expect(quickReactions("one", [])).toEqual(["👍", "❤️", "😂"]);
});

it("does not render unchanged shortcuts again on mount or storage refresh", () => {
  const renders = vi.fn();
  const catalog: CustomEmoji[] = [];
  const { result } = renderHook(() => {
    const entries = useQuickReactions("one", catalog);
    renders(entries);
    return entries;
  });
  const initial = result.current;
  expect(renders).toHaveBeenCalledTimes(1);
  act(() => {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "buzz.quick-reactions.v1:one",
      }),
    );
  });
  expect(result.current).toBe(initial);
  expect(renders).toHaveBeenCalledTimes(1);
});
it("refreshes changed storage, catalog availability and scope without reordering on use", () => {
  const party = { shortcode: "party", url: "https://a.test/p" };
  const { result, rerender } = renderHook(
    ({ scope, catalog }) => useQuickReactions(scope, catalog),
    { initialProps: { scope: "one", catalog: [] as CustomEmoji[] } },
  );
  act(() => recordReaction("one", ":party:"));
  expect(result.current).toEqual(["👍", "❤️", "😂"]);
  rerender({ scope: "one", catalog: [party] });
  expect(result.current).toEqual([":party:", "👍", "❤️"]);
  rerender({ scope: "one", catalog: [] });
  expect(result.current).toEqual(["👍", "❤️", "😂"]);
  act(() => {
    recordReaction("one", "🎉");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "buzz.quick-reactions.v1:one",
      }),
    );
  });
  expect(result.current).toEqual(["🎉", "👍", "❤️"]);
  rerender({ scope: "two", catalog: [] });
  expect(result.current).toEqual(["👍", "❤️", "😂"]);
});
