import { expect, test } from "vitest";
import { moveTargets, releasedInStrip } from "./PageTab";

const layout = {
  windows: [
    { label: "tabs-1", tabs: ["buzz.channels/channels"] },
    { label: "tabs-2", tabs: ["buzz.agents/agents", "buzz.projects/projects"] },
  ],
};

test("main tabs can leave to a new or existing window, never to main", () => {
  expect(moveTargets(layout, "main", 3)).toEqual([
    { destination: "new", title: "Move to new window" },
    { destination: "tabs-1", title: "Move to Window 2" },
    { destination: "tabs-2", title: "Move to Window 3" },
  ]);
});

test("a drag released in the window's own header cancels; anywhere else drops", () => {
  const header = { left: 0, top: 0, right: 1200, bottom: 56 };
  const viewport = { width: 1200, height: 800 };
  expect(releasedInStrip({ x: 300, y: 30 }, header, viewport)).toBe(true);
  expect(releasedInStrip({ x: 300, y: 56 }, header, viewport)).toBe(false);
  expect(releasedInStrip({ x: 300, y: 400 }, header, viewport)).toBe(false);
  // Outside the window the client point is negative or past the viewport.
  expect(releasedInStrip({ x: -40, y: 30 }, header, viewport)).toBe(false);
  expect(releasedInStrip({ x: 300, y: -10 }, header, viewport)).toBe(false);
  expect(releasedInStrip({ x: 1300, y: 30 }, header, viewport)).toBe(false);
  expect(releasedInStrip({ x: 300, y: 30 }, undefined, viewport)).toBe(false);
});

test("a tab alone in a detached window is not offered another new window", () => {
  expect(moveTargets(layout, "tabs-1", 1)).toEqual([
    { destination: "main", title: "Move to main window" },
    { destination: "tabs-2", title: "Move to Window 3" },
  ]);
  expect(moveTargets(layout, "tabs-2", 2)[0]).toEqual({
    destination: "new",
    title: "Move to new window",
  });
});
