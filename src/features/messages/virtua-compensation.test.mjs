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
        ResizeObserver: class {
          observe() {}
          unobserve() {}
          disconnect() {}
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
  driver.D({}, viewport);
  return {
    store,
    driver,
    viewport,
    style,
    axis,
    calls,
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

it("buffers both sides while a shift freezes the scroll direction", () => {
  const c = setup({ offset: 500 }); // native downward scrolling
  c.prepend();
  c.store.W(1, 2500); // compensated offset
  c.store.W(1, 2400); // upward movement cannot update the frozen direction
  expect(c.store.i(200)).toEqual([22, 31]);
  c.store.W(2); // inferred idle restores native direction tracking
  c.store.W(1, 2300);
  expect(c.store.i(200)).toEqual([21, 28]);
});

it("buffers below a shift frozen upward without letting those rows move the reading position", () => {
  for (const [row, size, top] of [
    [32, 150, null], // wholly below the 2500–3000 viewport
    [32, 60, null],
    [23, 150, 50], // above it, as prepended rows are
    [29, 150, 50], // visible rows are still corrected
    [30, 150, null], // starts exactly at the viewport end
  ]) {
    const c = setup({ offset: 500 });
    c.store.W(1, 400); // native upward scrolling
    c.prepend();
    c.store.W(1, 2400); // compensated offset
    c.store.W(1, 2500); // downward movement cannot update the frozen direction
    expect(c.store.i(200)).toEqual([23, 32]);
    c.calls.length = 0;
    c.store.W(3, [[row, size]]);
    c.driver.J();
    expect(c.calls.map((call) => call.options.top ?? null)).toEqual(
      top === null ? [] : [top],
    );
    c.driver._();
  }
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

it.each(["MacIntel", "Linux x86_64"])(
  "rounds fractional end corrections outward on %s, including RTL",
  (platform) => {
    for (const horizontal of [false, true]) {
      const c = setup({
        platform,
        horizontal,
        direction: horizontal ? "rtl" : "ltr",
        offset: 1500,
      });
      c.store.W(3, [[0, 100.75]]);
      c.driver.J();
      expect(c.calls.at(-1)).toMatchObject({
        method: "scrollTo",
        options: {
          [horizontal ? "left" : "top"]: horizontal ? -1501 : 1501,
          behavior: "instant",
        },
      });
      c.driver._();
    }
  },
);

it("rounds imperative end targets without rounding interior reading positions", async () => {
  const c = setup({ platform: "Linux x86_64", offset: 0 });
  c.store.W(
    3,
    Array.from({ length: 20 }, (_, index) => [index, index ? 100 : 100.75]),
  );
  for (const [target, expected] of [
    [900.25, 900.25],
    [1500.75, 1501],
  ]) {
    await c.driver.V(() => target, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.calls.at(-1).options).toEqual({
      top: expected,
      behavior: "instant",
    });
  }
  c.driver._();
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

function resizeHarness() {
  let notify;
  let nextFrame = 0;
  const frames = new Map();
  const view = {
    ResizeObserver: class {
      constructor(callback) {
        notify = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    requestAnimationFrame(callback) {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
  };
  const received = [];
  const observer = new Function(`${core};return C;`)()((entries) =>
    received.push(entries),
  );
  const node = () => ({ ownerDocument: { defaultView: view } });
  return {
    observer,
    received,
    frames,
    node,
    notify(entries) {
      notify(entries);
    },
    flush() {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback();
    },
  };
}

it("delivers the latest resize per target outside native observer delivery", () => {
  const h = resizeHarness();
  const first = h.node(),
    second = h.node();
  h.observer.A(first);
  h.observer.A(second);
  h.notify([{ target: first, contentRect: { height: 40 } }]);
  const latest = { target: first, contentRect: { height: 60 } };
  const other = { target: second, contentRect: { height: 80 } };
  h.notify([latest, other]);
  expect(h.received).toEqual([]);
  expect(h.frames.size).toBe(1);
  h.flush();
  expect(h.received).toEqual([[latest, other]]);
  expect(h.frames.size).toBe(0);
});

it("drops retired targets, cancels pending delivery on disposal, and can remount", () => {
  const h = resizeHarness();
  const first = h.node(),
    second = h.node();
  h.observer.A(first);
  h.observer.A(second);
  const retained = { target: second, contentRect: { height: 80 } };
  h.notify([{ target: first }, retained]);
  h.observer.B(first);
  h.flush();
  expect(h.received).toEqual([[retained]]);
  h.notify([retained]);
  h.observer.X();
  expect(h.frames.size).toBe(0);
  h.notify([retained]); // A native callback already queued at disposal is stale.
  h.flush();
  expect(h.received).toEqual([[retained]]);
  h.observer.A(first);
  const remounted = { target: first, contentRect: { height: 100 } };
  h.notify([remounted]);
  h.flush();
  expect(h.received).toEqual([[retained], [remounted]]);
});

// The timer stays at zero: measurement delivery is explicitly inside the
// retained command's 150ms lifetime, not after an input-settle helper expires it.
it.each(["wheel", "touchmove", "keydown", "pointerdown"])(
  "%s retires a pending imperative target before late measurement",
  async (type) => {
    const c = setup({ platform: "Linux x86_64", offset: 0 });
    c.store.W(
      3,
      Array.from({ length: 20 }, (_, index) => [index, 100]),
    );
    await c.driver.V(() => c.store.u(19) + c.store.h(19) - c.store.o(), false);
    expect(c.viewport.scrollTop).toBe(1500);
    c.viewport.dispatchEvent(Object.assign(new Event(type), { deltaY: -500 }));
    c.viewport.scrollTop = 1000;
    c.viewport.dispatchEvent(new Event("scroll"));
    c.calls.length = 0;
    c.store.W(5, [21, false]);
    c.store.W(3, [[20, 120]]);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.viewport.scrollTop).toBe(1000);
    expect(c.calls).toEqual([]);
    // A fresh navigation still owns its target and corrects later measurements.
    await c.driver.V(() => c.store.t() - c.store.o(), false);
    c.store.W(3, [[20, 140]]);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.viewport.scrollTop).toBe(1640);
    c.driver._();
  },
);

it.each(["input", "dispose"])(
  "%s invalidates an already queued imperative measurement replay",
  async (cancel) => {
    const c = setup({ platform: "Linux x86_64", offset: 0 });
    await c.driver.V(() => 1500, false);
    c.calls.length = 0;
    c.store.W(3, [[19, 120]]); // queue the replay, but do not run it yet
    if (cancel === "input") c.viewport.dispatchEvent(new Event("wheel"));
    else c.driver._();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.calls).toEqual([]);
    if (cancel === "input") c.driver._();
  },
);

it("removes cancellation listeners on disposal and reattaches on remount", async () => {
  const c = setup({ platform: "Linux x86_64", offset: 0 });
  const remove = vi.spyOn(c.viewport, "removeEventListener");
  c.driver._();
  for (const type of ["wheel", "touchmove", "keydown", "pointerdown"])
    expect(remove).toHaveBeenCalledWith(type, expect.any(Function), true);
  c.driver.D({}, c.viewport);
  await c.driver.V(() => 1500, false);
  c.viewport.dispatchEvent(new Event("wheel"));
  c.calls.length = 0;
  c.store.W(3, [[19, 120]]);
  await vi.advanceTimersByTimeAsync(0);
  expect(c.calls).toEqual([]);
  c.driver._();
});
