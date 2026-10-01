// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { correctScrollTop } from "./scroll-correction";

const stubNavigator = (platform: string, vendor: string, maxTouchPoints = 0) =>
  vi.stubGlobal("navigator", { platform, vendor, maxTouchPoints });

function scroller() {
  const element = document.createElement("section");
  let top = 100;
  Object.defineProperty(element, "scrollTop", {
    get: () => top,
    set: (value: number) => {
      top = value;
    },
  });
  return element;
}

const overflow = (element: HTMLElement) => [
  element.style.getPropertyValue("overflow-y"),
  element.style.getPropertyPriority("overflow-y"),
];

beforeEach(() => {
  vi.useFakeTimers();
  stubNavigator("MacIntel", "Apple Computer, Inc.");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("interrupts Mac WebKit momentum for one task around the correction", () => {
  const element = scroller();
  element.style.setProperty("overflow-y", "scroll", "important");

  correctScrollTop(element, 40);

  expect(element.scrollTop).toBe(140);
  expect(overflow(element)).toEqual(["hidden", "important"]);
  vi.runAllTimers();
  expect(overflow(element)).toEqual(["scroll", "important"]);
});

it("restores the original declaration across overlapping corrections", () => {
  const element = scroller();

  correctScrollTop(element, 40);
  correctScrollTop(element, -10);

  expect(element.scrollTop).toBe(130);
  expect(overflow(element)).toEqual(["hidden", "important"]);
  vi.runAllTimers();
  expect(element.getAttribute("style")).toBe("");
});

it("keeps a declaration written after the correction", () => {
  const element = scroller();

  correctScrollTop(element, 40);
  element.style.overflowY = "auto";
  vi.runAllTimers();

  expect(element.style.getPropertyValue("overflow-y")).toBe("auto");
});

it.each([
  ["Chromium", "MacIntel", "Google Inc.", 0],
  ["desktop-mode iPad", "MacIntel", "Apple Computer, Inc.", 5],
  ["non-Mac WebKit", "Linux x86_64", "Apple Computer, Inc.", 0],
])("leaves %s momentum alone", (_, platform, vendor, touchPoints) => {
  stubNavigator(platform, vendor, touchPoints);
  const element = scroller();

  correctScrollTop(element, 40);

  expect(element.scrollTop).toBe(140);
  expect(element.getAttribute("style")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it("ignores a zero correction", () => {
  const element = scroller();

  correctScrollTop(element, 0);

  expect(element.scrollTop).toBe(100);
  expect(element.getAttribute("style")).toBeNull();
});
