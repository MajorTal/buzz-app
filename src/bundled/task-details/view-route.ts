import type { JsonValue, OpenTarget } from "../../features/navigation/targets";

export function isTaskRoute(
  value: JsonValue,
): value is { channel: string; root: string } {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    "channel" in value &&
    "root" in value &&
    typeof value.channel === "string" &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(value.channel) &&
    typeof value.root === "string" &&
    /^[a-f0-9]{64}$/.test(value.root)
  );
}

export function taskViewTarget(
  scope: string,
  viewer: string,
  channel: string,
  root: string,
): OpenTarget {
  return {
    version: 1,
    kind: "page",
    pluginId: "buzz.projects",
    pageId: "projects",
    scope: { viewer, communityOrigin: scope.slice(0, -(viewer.length + 1)) },
    route: { version: 1, params: { channel, root } },
  };
}
