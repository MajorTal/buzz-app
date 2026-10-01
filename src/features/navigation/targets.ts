import { relayOrigin } from "../communities/destination";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type NavigationScope = Readonly<{
  viewer: string;
  communityOrigin: string;
}>;
export type OpenTarget =
  | Readonly<{ version: 1; kind: "home" }>
  | Readonly<{
      version: 1;
      kind: "settings";
      section?: string;
      scope?: NavigationScope | null;
    }>
  | Readonly<{
      version: 1;
      kind: "page";
      pluginId: string;
      pageId: string;
      /** null explicitly restores Personal space; omission leaves community selection alone. */
      scope?: NavigationScope | null;
      route?: Readonly<{ version: number; params: JsonValue }>;
    }>
  | Readonly<{
      version: 1;
      kind: "conversation";
      scope: NavigationScope;
      channelId: string;
      messageId?: string;
      /** Hint only. Resolve the actual root from verified message evidence. */
      threadRootId?: string;
      /** Presentation within this conversation; never mutation or confirmation state. */
      panel?: "members";
    }>;

const MAX_BYTES = 8192;
const token = /^[a-z0-9][a-z0-9._-]{0,127}$/;
// Built-in section, or a grouped plugin card's contribution key (`plugin/card`).
const section = /^[a-z0-9][a-z0-9._-]{0,127}(?:\/[a-z0-9][a-z0-9._-]{0,127})?$/;
const hex = /^[a-f0-9]{64}$/i;
const invalid = () => new Error("Invalid or unsupported navigation target");
function record(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw invalid();
  if (Object.getOwnPropertySymbols(value).length) throw invalid();
  for (const descriptor of Object.values(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!("value" in descriptor) || !descriptor.enumerable) throw invalid();
  }
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw invalid();
}
function text(value: unknown, pattern = token): string {
  if (typeof value !== "string" || !pattern.test(value)) throw invalid();
  return value;
}
function boundScope(input: unknown): NavigationScope {
  const value = record(input);
  fields(value, ["viewer", "communityOrigin"]);
  if (typeof value.communityOrigin !== "string") throw invalid();
  return Object.freeze({
    viewer: text(value.viewer, hex).toLowerCase(),
    communityOrigin: relayOrigin(value.communityOrigin),
  });
}

/** Copy, bound and sort JSON before retaining plugin-supplied state. No references survive. */
function json(input: unknown, depth = 0, budget = { nodes: 1024 }): JsonValue {
  if (depth > 8 || --budget.nodes < 0) throw invalid();
  if (input === null || typeof input === "boolean") return input;
  if (typeof input === "string") {
    if (input.length > MAX_BYTES) throw invalid();
    return input;
  }
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (Array.isArray(input)) {
    if (input.length > 256) throw invalid();
    const result: JsonValue[] = [];
    for (let index = 0; index < input.length; index++) {
      // JSON arrays are dense. Reject holes instead of changing them to null in links.
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (!descriptor || !("value" in descriptor)) throw invalid();
      result.push(json(descriptor.value, depth + 1, budget));
    }
    return Object.freeze(result);
  }
  const value = record(input);
  const keys = Object.keys(value);
  if (keys.length > 128) throw invalid();
  keys.sort();
  const result: Record<string, JsonValue> = Object.create(null);
  for (const key of keys) {
    if (key.length > 128) throw invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) throw invalid();
    result[key] = json(descriptor.value, depth + 1, budget);
  }
  return Object.freeze(result);
}

/** All bound ingresses use this parser. A valid address is not authorization. */
export function parseOpenTarget(input: unknown): OpenTarget {
  try {
    const value = record(input);
    if (value.version !== 1) throw invalid();
    let target: OpenTarget;
    switch (value.kind) {
      case "home":
        fields(value, ["version", "kind"]);
        target = { version: 1, kind: "home" };
        break;
      case "settings":
        fields(value, ["version", "kind", "section", "scope"]);
        target = {
          version: 1,
          kind: "settings",
          ...(value.section !== undefined
            ? { section: text(value.section, section) }
            : {}),
          ...(value.scope !== undefined
            ? { scope: value.scope === null ? null : boundScope(value.scope) }
            : {}),
        };
        break;
      case "page": {
        fields(value, [
          "version",
          "kind",
          "pluginId",
          "pageId",
          "scope",
          "route",
        ]);
        let route: { version: number; params: JsonValue } | undefined;
        if (value.route !== undefined) {
          const raw = record(value.route);
          fields(raw, ["version", "params"]);
          if (!Number.isSafeInteger(raw.version) || (raw.version as number) < 1)
            throw invalid();
          route = Object.freeze({
            version: raw.version as number,
            params: json(raw.params),
          });
        }
        target = {
          version: 1,
          kind: "page",
          pluginId: text(value.pluginId),
          pageId: text(value.pageId),
          ...(value.scope !== undefined
            ? { scope: value.scope === null ? null : boundScope(value.scope) }
            : {}),
          ...(route ? { route } : {}),
        };
        break;
      }
      case "conversation":
        fields(value, [
          "version",
          "kind",
          "scope",
          "channelId",
          "messageId",
          "threadRootId",
          "panel",
        ]);
        if (value.threadRootId !== undefined && value.messageId === undefined)
          throw invalid();
        if (value.panel !== undefined && value.panel !== "members")
          throw invalid();
        target = {
          version: 1,
          kind: "conversation",
          scope: boundScope(value.scope),
          channelId: text(
            value.channelId,
            /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/,
          ),
          ...(value.messageId !== undefined
            ? { messageId: text(value.messageId, hex).toLowerCase() }
            : {}),
          ...(value.threadRootId !== undefined
            ? { threadRootId: text(value.threadRootId, hex).toLowerCase() }
            : {}),
          ...(value.panel === "members" ? { panel: "members" } : {}),
        };
        break;
      default:
        throw invalid();
    }
    if (new TextEncoder().encode(JSON.stringify(target)).length > MAX_BYTES)
      throw invalid();
    return Object.freeze(target);
  } catch {
    // Never echo arbitrary input, URL credentials, plugin route data or accessor errors.
    throw invalid();
  }
}

export function targetKey(target: OpenTarget): string {
  return JSON.stringify(parseOpenTarget(target));
}
