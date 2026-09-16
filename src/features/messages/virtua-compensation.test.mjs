import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Exercise the installed React ESM's actual store, observer and element driver.
// Names are deliberately version-coupled: review this extraction on upgrade.
const source = readFileSync(
  fileURLToPath(import.meta.resolve("virtua")),
  "utf8",
);
const start = source.indexOf("var {min:");
const end = source.indexOf("}, W = (e, t) => {");
if (start < 0 || end < 0)
  throw new Error("Review Virtua driver extraction after version change");
const helperStart = source.indexOf("const isMacWebKit =");
const helper = helperStart >= 0 ? source.slice(helperStart, start) : "";
const core = source.slice(start, end + 1);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup({
  platform = "MacIntel",
  vendor = "Apple Computer, Inc.",
  touch = 0,
  agent = "Macintosh",
  horizontal = false,
  direction = "ltr",
  offset = 1300,
  attach = true,
} = {}) {
  const {
    store: createStore,
    layout,
    driver: createDriver,
  } = new Function(
    "navigator",
    "getComputedStyle",
    `${helper}${core};return {store:y,layout:R,driver:E};`,
  )({ platform, vendor, maxTouchPoints: touch, userAgent: agent }, () => ({
    direction,
  }));
  const store = createStore(layout(20, 100));
  const declarations = new Map();
  const style = {
    getPropertyValue: (name) => declarations.get(name)?.[0] ?? "",
    getPropertyPriority: (name) => declarations.get(name)?.[1] ?? "",
    setProperty: (name, value, priority = "") =>
      declarations.set(name, [value, priority]),
    removeProperty: (name) => declarations.delete(name),
  };
  let resize;
  const observed = new Set();
  let frameId = 0;
  const frames = new Map();
  const viewport = new EventTarget();
  const calls = [];
  const axis = horizontal ? "overflow-x" : "overflow-y";
  const key = horizontal ? "scrollLeft" : "scrollTop";
  const option = horizontal ? "left" : "top";
  Object.assign(viewport, {
    style,
    offsetParent: {},
    scrollTop: 0,
    scrollLeft: 0,
    ownerDocument: {
      defaultView: {
        requestAnimationFrame: (callback) => {
          frames.set(++frameId, callback);
          return frameId;
        },
        cancelAnimationFrame: (id) => frames.delete(id),
        ResizeObserver: class {
          constructor(callback) {
            resize = callback;
          }
          observe(row) {
            observed.add(row);
          }
          unobserve(row) {
            observed.delete(row);
          }
          disconnect() {
            observed.clear();
          }
        },
      },
    },
  });
  viewport[key] = direction === "rtl" ? -offset : offset;
  for (const method of ["scrollTo", "scrollBy"])
    viewport[method] = (options) => {
      calls.push({
        method,
        options,
        overflow: style.getPropertyValue(axis),
        priority: style.getPropertyPriority(axis),
      });
      viewport[key] =
        (method === "scrollBy" ? viewport[key] : 0) + options[option];
    };
  store.W(4, 500); // measured viewport
  store.W(1, offset); // observed native scrolling
  const driver = createDriver(store, horizontal);
  if (attach) driver.D({}, viewport);
  return {
    store,
    driver,
    viewport,
    style,
    axis,
    calls,
    frames,
    observed,
    resize: (entries) => resize(entries),
    frame() {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback();
    },
    prepend(length = 40) {
      store.W(5, [length, true]);
      driver.J();
    },
  };
}

it("interrupts the actual correction before its relative DOM write, even after inferred idle", () => {
  const c = setup();
  c.store.W(2); // observer idle is NOT native momentum completion
  c.prepend();
  expect(c.calls).toEqual([
    {
      method: "scrollBy",
      options: { top: 2000, behavior: "instant" },
      overflow: "hidden",
      priority: "important",
    },
  ]);
  expect(c.viewport.scrollTop).toBe(3300);
  expect(c.store.t()).toBe(4000); // no deferred extent/store policy
  expect(c.store.u(39)).toBe(3900);
  c.driver.J();
  expect(c.calls).toHaveLength(1);
  vi.runAllTimers();
  expect(c.style.getPropertyValue(c.axis)).toBe("");
  expect(vi.getTimerCount()).toBe(0);
});

it("does not defer while scrolling or interrupt without a correction", () => {
  const c = setup();
  c.driver.J();
  expect(c.calls).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
  c.prepend();
  expect(c.calls).toHaveLength(1);
  expect(c.store.t()).toBe(4000);
  expect(c.store.L()[0]).toBe(0);
});

it("preserves absolute edge correction and RTL axis normalization", () => {
  for (const config of [
    { offset: 1500 },
    { horizontal: true, direction: "rtl", offset: 1500 },
  ]) {
    const c = setup(config);
    c.prepend();
    expect(c.calls).toEqual([
      {
        method: "scrollTo",
        options: {
          [config.horizontal ? "left" : "top"]: config.horizontal
            ? -3500
            : 3500,
          behavior: "instant",
        },
        overflow: "hidden",
        priority: "important",
      },
    ]);
    c.driver._();
  }
});

it("restores exact value and priority after overlapping corrections without touching the other axis", () => {
  const c = setup();
  c.style.setProperty("overflow-y", "scroll", "important");
  c.style.setProperty("overflow-x", "clip", "");
  c.prepend();
  c.prepend(60);
  expect(c.calls.map((call) => call.overflow)).toEqual(["hidden", "hidden"]);
  expect(vi.getTimerCount()).toBe(1);
  expect(c.style.getPropertyValue("overflow-x")).toBe("clip");
  vi.runAllTimers();
  expect(c.style.getPropertyValue("overflow-y")).toBe("scroll");
  expect(c.style.getPropertyPriority("overflow-y")).toBe("important");
});

it("restores immediately on dispose and permits a fresh lifecycle", () => {
  const c = setup();
  c.style.setProperty(c.axis, "auto");
  c.prepend();
  c.driver._();
  expect(c.style.getPropertyValue(c.axis)).toBe("auto");
  expect(c.style.getPropertyPriority(c.axis)).toBe("");
  expect(vi.getTimerCount()).toBe(0);
  c.driver.D({}, c.viewport);
  c.prepend(60);
  expect(c.calls.at(-1).overflow).toBe("hidden");
  c.driver._();
  expect(c.style.getPropertyValue(c.axis)).toBe("auto");
});

it("does not overwrite a later style owner", () => {
  const c = setup();
  c.prepend();
  c.style.setProperty(c.axis, "clip", "important");
  vi.runAllTimers();
  expect(c.style.getPropertyValue(c.axis)).toBe("clip");
  expect(c.style.getPropertyPriority(c.axis)).toBe("important");
});

it("interrupts positive and negative resize compensation at the same production driver", () => {
  for (const size of [50, 150]) {
    const c = setup();
    c.store.W(3, [[0, size]]);
    c.driver.J();
    expect(c.calls).toEqual([
      {
        method: "scrollBy",
        options: { top: size - 100, behavior: "instant" },
        overflow: "hidden",
        priority: "important",
      },
    ]);
    c.driver._();
  }
});

it("does not change the imperative scheduler's smooth or instant scrolling policy", async () => {
  for (const smooth of [false, true]) {
    const c = setup();
    c.store.W(
      3,
      Array.from({ length: 20 }, (_, index) => [index, 100]),
    );
    await c.driver.V(() => 900, smooth);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.calls.at(-1).overflow).toBe("");
    expect(c.calls.at(-1).options).toEqual({
      top: 900,
      behavior: smooth ? "smooth" : "instant",
    });
    c.driver._();
    vi.clearAllTimers();
  }
});

for (const [name, config, deferred] of [
  ["macOS Chrome", { vendor: "Google Inc." }, false],
  ["macOS Firefox", { vendor: "" }, false],
  ["Linux WebKit", { platform: "Linux x86_64" }, false],
  ["desktop-mode iPad", { touch: 5 }, true],
  ["iPhone", { platform: "iPhone", agent: "iPhone", touch: 5 }, true],
]) {
  it(`preserves existing ${name} policy`, () => {
    const c = setup(config);
    c.prepend();
    expect(c.calls).toHaveLength(deferred ? 0 : 1);
    if (deferred) {
      c.store.W(2);
      c.driver.J();
    }
    expect(c.calls.at(-1).overflow).toBe("");
    expect(c.store.t()).toBe(4000);
    c.driver._();
  });
}

it("defers new row registration but keeps measurement delivery synchronous", () => {
  const c = setup({ attach: false });
  const row = { offsetParent: c.viewport };
  c.driver.P(row, 0); // Child registration can precede driver attachment.
  expect(c.observed.size).toBe(0);
  c.driver.D({}, c.viewport);
  expect(c.observed.has(c.viewport)).toBe(true);
  expect(c.observed.has(row)).toBe(false);
  expect(c.frames.size).toBe(1);
  c.frame();
  expect(c.observed.has(row)).toBe(true);
  c.resize([
    { target: c.viewport, contentRect: { height: 600 } },
    { target: row, contentRect: { height: 50 } },
  ]);
  expect(c.store.o()).toBe(600);
  expect(c.store.u(1)).toBe(50);
  expect(c.frames.size).toBe(0);
  c.driver._();
});

it("cancels unmounted registration and observes hidden and reassigned rows", () => {
  const c = setup();
  const rows = Array.from({ length: 3 }, () => ({ offsetParent: c.viewport }));
  const release = rows.map((row, index) => c.driver.P(row, index));
  release[0]();
  rows[1].offsetParent = null;
  release[2]();
  c.driver.P(rows[2], 3);
  expect(c.frames.size).toBe(1);
  c.frame();
  expect(c.observed.has(rows[0])).toBe(false);
  expect(c.observed.has(rows[1])).toBe(true); // It must report becoming visible later.
  expect(c.observed.has(rows[2])).toBe(true);
  rows[1].offsetParent = c.viewport;
  c.resize(
    rows.slice(1).map((target) => ({ target, contentRect: { height: 50 } })),
  );
  expect(c.store.u(4)).toBe(300);
  c.driver._();
});

it("cancels registrations on disposal and accepts fresh registrations after remount", () => {
  const c = setup();
  const row = { offsetParent: c.viewport };
  const release = c.driver.P(row, 0);
  c.driver._();
  expect(c.frames.size).toBe(0);
  c.frame();
  expect(c.observed.size).toBe(0);
  c.resize([{ target: row, contentRect: { height: 50 } }]);
  expect(c.store.u(1)).toBe(100);
  release();
  c.driver.P(row, 0);
  c.driver.D({}, c.viewport);
  c.frame();
  expect(c.observed.has(row)).toBe(true);
  c.resize([{ target: row, contentRect: { height: 60 } }]);
  expect(c.store.u(1)).toBe(60);
  c.driver._();
});

it("releases rows before attachment without creating or reviving an observer", () => {
  const c = setup({ attach: false });
  const row = { offsetParent: c.viewport };
  const release = c.driver.P(row, 0);
  expect(() => release()).not.toThrow();
  c.driver._();
  c.driver.D({}, c.viewport);
  c.frame();
  expect(c.observed.has(row)).toBe(false);
  c.driver._();
});
