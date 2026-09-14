import { expect, it, vi } from "vitest";
import type { RegisteredPage } from "../pages/service";
import type { RegisteredPanel } from "../panels/service";
import {
  createTabDrag,
  createWindowHost,
  panelTabKey,
  parseLayout,
  windowPages,
  windowPanels,
  windowTitle,
  type WindowTransport,
} from "./service";

const page = (key: string): RegisteredPage => {
  const [pluginId = "", id = ""] = key.split("/");
  return { key, pluginId, id, title: id, revision: "r", component: () => null };
};
const messages = page("buzz.channels/channels");
const projects = page("buzz.projects/projects");
const agents = page("buzz.agents/agents");
const pages = [messages, projects, agents];
const panel = (key: string, launcher = true): RegisteredPanel => {
  const [pluginId = "", id = ""] = key.split("/");
  return {
    key,
    pluginId,
    id,
    title: id,
    revision: "r",
    matches: () => false,
    component: () => null,
    ...(launcher ? { launcher: { icon: "/x.png", target: "" } } : {}),
  };
};
const bestie = panel("buzz.bestie/companion");
const activity = panel("buzz.agent-activity/activity");
const github = panel("buzz.github/object", false);
const layout = {
  windows: [
    {
      label: "tabs-1",
      tabs: [
        "buzz.channels/channels",
        "buzz.agents/agents",
        "panel:buzz.bestie/companion",
      ],
    },
    { label: "tabs-3", tabs: ["missing.plugin/page"] },
  ],
};

function transport(initial: unknown | (() => Promise<unknown>) = layout) {
  let deliver: ((layout: unknown) => void) | undefined;
  let activate: ((key: unknown) => void) | undefined;
  let hover: ((hovering: unknown) => void) | undefined;
  const unlisten = vi.fn();
  const api: WindowTransport & {
    emit(layout: unknown): void;
    activate(key: unknown): void;
    hover(hovering: unknown): void;
  } = {
    label: "tabs-1",
    layout: vi.fn(() =>
      typeof initial === "function"
        ? (initial as () => Promise<unknown>)()
        : Promise.resolve(initial),
    ),
    listen: vi.fn(async (listener: (layout: unknown) => void) => {
      deliver = listener;
      return unlisten;
    }),
    activation: vi.fn(async (listener: (key: unknown) => void) => {
      activate = listener;
      return unlisten;
    }),
    dropTarget: vi.fn(async (listener: (hovering: unknown) => void) => {
      hover = listener;
      return unlisten;
    }),
    moveTab: vi.fn(async () => ({ windows: [] })),
    dropTab: vi.fn(async () => layout),
    dragBegin: vi.fn(async () => {}),
    dragMove: vi.fn(async () => {}),
    dragEnd: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    emit: (layout) => deliver?.(layout),
    activate: (key) => activate?.(key),
    hover: (hovering) => hover?.(hovering),
  };
  return { api, unlisten };
}
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

it("main shows every page not assigned elsewhere; detached windows show only their tabs", () => {
  expect(windowPages(layout, "main", pages)).toEqual([projects]);
  expect(windowPages(layout, "tabs-1", pages)).toEqual([messages, agents]);
  expect(windowPages(layout, "tabs-3", pages)).toEqual([]);
  expect(windowPages(layout, "tabs-9", pages)).toEqual([]);
  expect(windowPages({ windows: [] }, "main", pages)).toEqual(pages);
  expect(windowTitle(layout, "main")).toBe("Main window");
});

it("launcher panels move like tabs; target-only panels never leave their pages", () => {
  const panels = [bestie, github, activity];
  expect(panelTabKey(bestie)).toBe("panel:buzz.bestie/companion");
  expect(windowPanels(layout, "main", panels)).toEqual([activity]);
  expect(windowPanels(layout, "tabs-1", panels)).toEqual([bestie]);
  expect(windowPanels({ windows: [] }, "main", panels)).toEqual([
    bestie,
    activity,
  ]);
  // A page and a panel with the same contribution key never collide.
  expect(
    windowPages(layout, "main", [page("buzz.bestie/companion")]),
  ).toHaveLength(1);
  expect(windowTitle(layout, "tabs-3")).toBe("Window 3");
  expect(windowTitle(layout, "tabs-9")).toBe("Window");
});

it("rejects malformed layouts instead of silently reassigning pages", () => {
  for (const bad of [null, {}, { windows: {} }, { windows: [{ label: 1 }] }])
    expect(() => parseLayout(bad)).toThrow("Invalid window layout");
  expect(parseLayout({ windows: [] })).toEqual({ windows: [] });
});

it("web is the single main window without move or close", () => {
  const host = createWindowHost(undefined);
  expect(host.label).toBe("main");
  expect(host.isMain).toBe(true);
  expect(host.snapshot()).toEqual({
    status: "ready",
    layout: { windows: [] },
    dropTarget: false,
  });
  expect(host.moveTab).toBeUndefined();
  expect(host.dropTab).toBeUndefined();
  expect(host.close).toBeUndefined();
  host.dispose();
});

it("loads the desktop layout, follows broadcasts, and stops listening on dispose", async () => {
  const { api, unlisten } = transport();
  const host = createWindowHost(api);
  const listener = vi.fn();
  host.subscribe(listener);
  expect(host.isMain).toBe(false);
  expect(host.snapshot().status).toBe("loading");
  await settled();
  expect(host.snapshot()).toEqual({
    status: "ready",
    layout,
    dropTarget: false,
  });
  expect(listener).toHaveBeenCalledTimes(1);
  api.emit({ windows: [] });
  expect(host.snapshot().layout).toEqual({ windows: [] });
  api.emit("garbage");
  expect(host.snapshot().layout).toEqual({ windows: [] });
  expect(listener).toHaveBeenCalledTimes(2);
  await host.moveTab?.("buzz.agents/agents", "new");
  expect(api.moveTab).toHaveBeenCalledWith("buzz.agents/agents", "new");
  expect(listener).toHaveBeenCalledTimes(3);
  await host.dropTab?.("buzz.agents/agents", 120.5, 40);
  expect(api.dropTab).toHaveBeenCalledWith("buzz.agents/agents", 120.5, 40);
  expect(host.snapshot().layout).toEqual(layout);
  expect(listener).toHaveBeenCalledTimes(4);
  await host.close?.();
  expect(api.close).toHaveBeenCalledOnce();
  // Activations ride the same snapshot and survive layout updates; repeats get a new seq.
  api.activate("buzz.agents/agents");
  expect(host.snapshot().activate).toEqual({
    key: "buzz.agents/agents",
    seq: 1,
  });
  api.emit(layout);
  expect(host.snapshot().activate).toEqual({
    key: "buzz.agents/agents",
    seq: 1,
  });
  api.activate("buzz.agents/agents");
  expect(host.snapshot().activate?.seq).toBe(2);
  api.activate(42);
  expect(host.snapshot().activate?.seq).toBe(2);
  expect(listener).toHaveBeenCalledTimes(7);
  // Drop-target hover is a flag on the snapshot; repeats and junk are ignored.
  expect(host.snapshot().dropTarget).toBe(false);
  api.hover(true);
  api.hover(true);
  api.hover("yes");
  expect(host.snapshot().dropTarget).toBe(true);
  expect(listener).toHaveBeenCalledTimes(8);
  api.emit(layout);
  expect(host.snapshot().dropTarget).toBe(true);
  api.hover(false);
  expect(host.snapshot().dropTarget).toBe(false);
  expect(listener).toHaveBeenCalledTimes(10);
  host.dispose();
  expect(unlisten).toHaveBeenCalledTimes(3);
  api.emit(layout);
  api.activate("buzz.projects/projects");
  api.hover(true);
  expect(listener).toHaveBeenCalledTimes(10);
});

it("drag moves wait for begin, keep only the latest point, and never outlive end", async () => {
  const gates: (() => void)[] = [];
  const gated = () =>
    new Promise<void>((resolve) => {
      gates.push(resolve);
    });
  const transport = {
    dragBegin: vi.fn(gated),
    dragMove: vi.fn(gated),
    dragEnd: vi.fn(async () => {}),
  };
  const drag = createTabDrag(transport);
  drag.begin("Messages", 10, 10);
  drag.move(20, 20);
  drag.move(30, 30);
  expect(transport.dragBegin).toHaveBeenCalledWith("Messages", 10, 10);
  expect(transport.dragMove).not.toHaveBeenCalled();
  gates.shift()?.(); // begin settles
  await settled();
  expect(transport.dragMove).toHaveBeenCalledExactlyOnceWith(30, 30);
  drag.move(40, 40);
  drag.move(50, 50);
  gates.shift()?.(); // first move settles
  await settled();
  expect(transport.dragMove).toHaveBeenLastCalledWith(50, 50);
  expect(transport.dragMove).toHaveBeenCalledTimes(2);
  drag.move(60, 60);
  drag.end();
  gates.shift?.()?.();
  await settled();
  expect(transport.dragMove).toHaveBeenCalledTimes(2);
  expect(transport.dragEnd).toHaveBeenCalledOnce();
  // A stale begin settling after end must not revive a move.
  drag.begin("Agents", 1, 1);
  drag.move(2, 2);
  drag.end();
  gates.shift()?.();
  await settled();
  expect(transport.dragMove).toHaveBeenCalledTimes(2);
  expect(transport.dragEnd).toHaveBeenCalledTimes(2);
});

it("fails open as a single window when the layout cannot be read", async () => {
  const { api } = transport(() => Promise.reject(new Error("ipc down")));
  const host = createWindowHost(api);
  await settled();
  expect(host.snapshot()).toEqual({
    status: "ready",
    layout: { windows: [] },
    dropTarget: false,
  });
  host.dispose();
});

it("a broadcast that lands before the initial read wins", async () => {
  let resolveInitial: ((layout: unknown) => void) | undefined;
  const { api } = transport(
    () =>
      new Promise((resolve) => {
        resolveInitial = resolve;
      }),
  );
  const host = createWindowHost(api);
  await settled();
  api.emit({ windows: [] });
  resolveInitial?.(layout);
  await settled();
  expect(host.snapshot().layout).toEqual({ windows: [] });
  host.dispose();
});
