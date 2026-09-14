import { expect, it } from "vitest";
import { isTaskRoute, taskViewTarget } from "./view-route";

it("routes a task using only scoped coordinates and rejects malformed routes", () => {
  const viewer = "a".repeat(64);
  const root = "b".repeat(64);
  const target = taskViewTarget(
    `https://example.com:${viewer}`,
    viewer,
    "channel-id",
    root,
  );
  expect(target).toMatchObject({
    kind: "page",
    pluginId: "buzz.projects",
    scope: { viewer, communityOrigin: "https://example.com" },
    route: { version: 1, params: { channel: "channel-id", root } },
  });
  expect(isTaskRoute({ channel: "channel-id", root })).toBe(true);
  for (const value of [
    null,
    [],
    {},
    { channel: "", root },
    { channel: "channel-id", root: "bad" },
    { channel: "channel-id", root, title: "untrusted" },
  ])
    expect(isTaskRoute(value)).toBe(false);
});
