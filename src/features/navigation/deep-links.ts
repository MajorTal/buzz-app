// OS-delivered deep links. The native shell holds raw strings; this module is the
// only place that turns them into typed targets, and the ordinary navigation
// admission path alone decides whether a target opens. Browsers have no OS scheme
// handler, so everything here is a no-op outside Tauri.
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { communityDestination } from "../communities/destination";
import type { ClientSnapshot } from "../communities/service";
import { parseBuzzLink } from "./buzz-links";
import { entityTarget } from "../projects/routes";
import type { Navigation, OpenFailure, OpenResult } from "./controller";
import { parseOpenTarget, type OpenTarget } from "./targets";

export type DeepLinkStep =
  | Readonly<{ open: OpenTarget }>
  | Readonly<{ fail: OpenFailure }>;
/** What the shell exposes: drain held URLs, and learn when more are held. */
export type DeepLinkShell = Readonly<{
  take(): Promise<readonly string[]>;
  watch(listener: () => void): () => void;
}>;
export type DeepLinkHost = Readonly<{
  navigation: Pick<Navigation, "open" | "snapshot" | "subscribe">;
  /** Host-only: record an ingress that produced no destination. */
  fail(reason: OpenFailure, retry?: () => Promise<OpenResult>): void;
}>;
type Client = Pick<ClientSnapshot, "status" | "viewer" | "selected">;

/** Decide what one OS URL means for the signed-in client. The OS ingress accepts
 * the Buzz link forms, `buzz://message?channel=&id=[&thread=]` and
 * `buzz://channel/<id>`, which carry no community and so bind to the selected one.
 * A bound target still passes the usual viewer, membership and channel checks;
 * nothing here grants access. */
export function deepLinkStep(
  url: string,
  client: Pick<Client, "viewer" | "selected">,
): DeepLinkStep {
  // Require the canonical scheme here. The native URL parser may already have
  // normalized its case before this bridge receives it.
  if (typeof url !== "string" || !url.startsWith("buzz:"))
    return { fail: "invalid-target" };
  const link = parseBuzzLink(url);
  // Every address outside the Buzz link grammar, unknown hosts included, parses
  // to null and fails here rather than being dropped; the app has no link form
  // of its own beyond the Buzz ones.
  if (!link) return { fail: "invalid-target" };
  try {
    if (!client.viewer || !client.selected) return { fail: "unavailable" };
    if (link.format === "entity")
      return {
        open: entityTarget(link.route, {
          viewer: client.viewer,
          communityOrigin: communityDestination(client.selected).url,
        }),
      };
    const { format: _format, ...destination } = link;
    return {
      open: parseOpenTarget({
        version: 1,
        kind: "conversation",
        scope: {
          viewer: client.viewer,
          communityOrigin: communityDestination(client.selected).url,
        },
        ...destination,
      }),
    };
  } catch {
    return { fail: "invalid-target" };
  }
}

/** Latest intent wins, as with a user's navigation. At most one unbound URL is
 * retained. Once bound, the ordinary controller owns presentation and retry. */
export function bindDeepLinks(
  host: DeepLinkHost,
  communities: Readonly<{
    snapshot(): Client;
    subscribe(listener: () => void): () => void;
  }>,
  shell = createDeepLinkShell(),
): () => void {
  if (!shell) return () => {};
  let closed = false;
  let held:
    | {
        url: string;
        viewer: string | undefined;
        selected: string | null;
        reported: boolean;
      }
    | undefined;
  let attempt = host.navigation.snapshot().attempt;
  let client = communities.snapshot();
  let clientEpoch = 0;
  const openHeld = (): Promise<OpenResult> => {
    if (closed || !held) return Promise.resolve({ status: "cancelled" });
    const client = communities.snapshot();
    const incoming = held;
    if (
      (incoming.viewer && incoming.viewer !== client.viewer) ||
      (incoming.selected && incoming.selected !== client.selected)
    ) {
      held = undefined;
      host.fail("denied");
      return Promise.resolve({ status: "failed", reason: "denied" });
    }
    if (client.status === "loading")
      return Promise.resolve({ status: "failed", reason: "unavailable" });
    const step = deepLinkStep(incoming.url, client);
    if ("open" in step) {
      held = undefined;
      return host.navigation.open(step.open);
    }
    if (step.fail !== "unavailable") held = undefined;
    else incoming.reported = true;
    host.fail(step.fail, held ? openHeld : undefined);
    attempt = host.navigation.snapshot().attempt;
    return Promise.resolve({ status: "failed", reason: step.fail });
  };
  const flush = () => {
    if (closed || !held) return;
    const client = communities.snapshot();
    held.viewer ??= client.viewer;
    held.selected ??= client.selected;
    if (
      (held.viewer && held.viewer !== client.viewer) ||
      (held.selected && held.selected !== client.selected)
    ) {
      held = undefined;
      host.fail("denied");
    } else if (client.status !== "loading" && !held.reported && !draining) {
      void openHeld();
    }
  };
  // Pings coalesce while a read is in flight; neither URLs nor waiting drains grow.
  let draining = false;
  let requested = false;
  const drain = async () => {
    requested = true;
    if (draining || closed) return;
    draining = true;
    try {
      while (requested && !closed) {
        requested = false;
        const started = host.navigation.snapshot().attempt;
        const epoch = clientEpoch;
        let urls: readonly string[];
        try {
          urls = await shell.take();
        } catch (error) {
          if (!closed)
            console.error("Could not read pending deep links", error);
          continue;
        }
        if (
          closed ||
          epoch !== clientEpoch ||
          started.id !== host.navigation.snapshot().attempt.id
        )
          continue;
        let url: string | undefined;
        for (let index = urls.length - 1; index >= 0; index--) {
          const candidate = urls[index];
          if (typeof candidate === "string") {
            url = candidate;
            break;
          }
        }
        if (url === undefined) continue;
        const client = communities.snapshot();
        held = {
          url,
          viewer: client.viewer,
          selected: client.selected,
          reported: false,
        };
        if (client.status !== "loading") void openHeld();
        else flush();
      }
    } finally {
      draining = false;
      flush();
    }
  };
  const stopClient = communities.subscribe(() => {
    const next = communities.snapshot();
    if (
      (client.viewer && client.viewer !== next.viewer) ||
      (client.selected && client.selected !== next.selected)
    )
      clientEpoch++;
    client = next;
    flush();
  });
  const stopNavigation = host.navigation.subscribe(() => {
    const next = host.navigation.snapshot();
    // fail() emits synchronously; its ingress marker distinguishes our failure
    // from a newer user visit, including Back/Forward and Go Home.
    if (next.attempt.id !== attempt.id && !next.ingress) held = undefined;
    attempt = next.attempt;
  });
  // A broken shell bridge must never keep the app from opening.
  let stopShell = () => {};
  try {
    stopShell = shell.watch(drain);
  } catch (error) {
    console.error("Deep link updates are unavailable", error);
  }
  drain();
  return () => {
    if (closed) return;
    closed = true;
    stopClient();
    stopNavigation();
    stopShell();
    held = undefined;
  };
}

/** The Tauri bridge. It carries raw URL strings from the main window's shell and
 * a queue-depth ping; no destination or account data crosses in either direction. */
export function createDeepLinkShell(): DeepLinkShell | undefined {
  if (!isTauri()) return undefined;
  return {
    async take() {
      const urls = await invoke<unknown>("deep_link_take");
      return Array.isArray(urls)
        ? urls.filter((url): url is string => typeof url === "string")
        : [];
    },
    watch(listener) {
      let active = true;
      const channel = new Channel<unknown>(() => {
        if (active) listener();
      });
      void invoke("deep_link_watch", { onEvent: channel }).then(
        () => {
          // A URL can arrive after the startup take but before registration.
          // Drain again once the watcher is installed so that gap cannot strand it.
          if (active) listener();
        },
        (error) => {
          if (active) console.error("Deep link updates are unavailable", error);
        },
      );
      return () => {
        active = false;
        channel.onmessage = () => {};
      };
    },
  };
}
