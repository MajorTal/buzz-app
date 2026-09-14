import {
  OBSERVER_KIND,
  observerGeneration,
  type ObserverFrame,
} from "../agents/observer.ts";
import type { EventTemplate, VerifiedEvent } from "nostr-tools";
import { eventDto } from "./events.ts";
import { EMOJI_SET } from "./emoji.ts";

export const LIVE_CHANNEL_CAPACITY = 1022; // Reserve two of the relay's 1024 slots.
export const LIVE_REPLAY_LIMIT = 500;
const SETUP_CONCURRENCY = 4;
const REQUEST_INTERVAL_MS = 250; // 4 starts/s leaves room below the reference 10/s quota.
const MAX_QUOTA_RETRIES = 3;
/** Host-owned pacing survives socket/POST replacement. The server quota is shared
 * across clients, so local pacing cannot replace honoring an explicit cooldown. */
export function createLiveAdmission() {
  let next = 0;
  let cooldown = 0;
  return {
    delay: () =>
      Math.max(0, next - performance.now(), cooldown - performance.now()),
    take() {
      next = performance.now() + REQUEST_INTERVAL_MS;
    },
    pause(seconds: number) {
      // Redis reports whole seconds; include a second rather than retry before expiry.
      cooldown = Math.max(cooldown, performance.now() + (seconds + 1) * 1000);
    },
  };
}
export type LiveAdmission = ReturnType<typeof createLiveAdmission>;
export type LiveRoute = Readonly<{
  id: string;
  channelId?: string;
  status: "pending" | "live" | "error" | "limited";
  /** EOSE establishes a stream, never proves historical completeness. */
  replay: "unknown" | "limited";
  error?: string;
}>;
export type LiveSnapshot = Readonly<{
  status: "unavailable" | "connecting" | "connected" | "retrying" | "error";
  routes: readonly LiveRoute[];
  error?: string;
}>;
/** Transport provenance, not a history-completeness claim or permission to alert. */
export type LiveProvenance = Readonly<{
  phase: "replay" | "live";
  channelId?: string;
}>;
export function liveProvenance(value: unknown): LiveProvenance {
  if (!value || typeof value !== "object")
    throw new Error("Invalid live provenance");
  const input = value as Record<string, unknown>;
  if (input.phase !== "replay" && input.phase !== "live")
    throw new Error("Invalid live provenance");
  if (
    input.channelId !== undefined &&
    (typeof input.channelId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(input.channelId))
  )
    throw new Error("Invalid live provenance channel");
  return Object.freeze({
    phase: input.phase,
    ...(typeof input.channelId === "string"
      ? { channelId: input.channelId }
      : {}),
  });
}
export type LiveCallbacks = {
  /** Legacy/missing provenance reconciles quietly; it is never implicitly fresh. */
  receive(events: readonly VerifiedEvent[], provenance?: LiveProvenance): void;
  /** Host-only encrypted telemetry route; never ordinary history reconciliation. */
  telemetry?(event: VerifiedEvent, generation: number): void;
  /** Decoded host DTO on the browser transport. */
  observer?(frame: ObserverFrame, generation: number): void;
  state(snapshot: LiveSnapshot): void;
  established(channelId?: string): void;
  denied(channelId: string, reason: string): void;
};
export type LiveSubscription = {
  update(channels: readonly string[]): void;
  /** Host demand only: reorder existing pending routes, never grant new interests. */
  prioritize?(channels: readonly string[]): void;
  observe?(generation: number | null): void;
  retry(): void;
  dispose(): void;
};
/** IDs, not names/previews, define interest identity. Never silently truncate. */
export function liveChannels(input: unknown): string[] {
  if (
    !Array.isArray(input) ||
    input.length > 1024 ||
    input.some(
      (id) => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id),
    )
  )
    throw new Error(
      "Invalid live channel interests (maximum 1024 bounded IDs)",
    );
  return [...new Set(input as string[])].sort();
}

type Route = {
  id: string;
  channelId?: string;
  status: LiveRoute["status"];
  replay: LiveRoute["replay"];
  error?: string;
  wire?: string;
  count: number;
  since: number;
  quotaRetries: number;
  deadline?: ReturnType<typeof setTimeout>;
};
const CHANNEL_KINDS = [9, 40002, 40099, 40003, 5, 9005, 7, 39000, 39002, 39005];
/** One authenticated socket, independently established channel routes and two explicit globals.
 * Recent replay is opportunistic: finite reads own catch-up and history bounds. */
export function subscribeRelayTraffic(
  url: string,
  sign: (event: EventTemplate) => Promise<VerifiedEvent>,
  viewer: string,
  callbacks: LiveCallbacks,
  socketFactory: (url: string) => WebSocket = (url) => new WebSocket(url),
  admission: LiveAdmission = createLiveAdmission(),
): LiveSubscription {
  let closed = false;
  let socket: WebSocket | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let dispatchTimer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0,
    generation = 0,
    serial = 0;
  let authenticated = false;
  let connection: LiveSnapshot["status"] = "connecting";
  let connectionError: string | undefined;
  let interests: string[] = [];
  let priority: string[] = [];
  let observer: number | null = null;
  const routes = new Map<string, Route>();
  const wires = new Map<string, Route>();
  const notify = () => {
    if (closed) return;
    callbacks.state(
      Object.freeze({
        status: connection,
        routes: Object.freeze(
          [...routes.values()].map(({ id, channelId, status, replay, error }) =>
            Object.freeze({
              id,
              ...(channelId ? { channelId } : {}),
              status,
              replay,
              ...(error ? { error } : {}),
            }),
          ),
        ),
        ...(connectionError ? { error: connectionError } : {}),
      }),
    );
  };
  const send = (value: unknown) => {
    if (!closed && socket?.readyState === 1) socket.send(JSON.stringify(value));
  };
  function remove(route: Route) {
    clearTimeout(route.deadline);
    if (route.wire) {
      wires.delete(route.wire); // Fence before CLOSE, including reentrant callbacks.
      send(["CLOSE", route.wire]);
    }
    routes.delete(route.id);
  }
  function sync() {
    const wanted = new Set([
      "profiles",
      "membership",
      ...(observer !== null ? ["observer"] : []),
      ...interests.map((id) => `channel:${id}`),
    ]);
    for (const route of routes.values())
      if (!wanted.has(route.id)) remove(route);
    for (const id of wanted)
      if (!routes.has(id)) {
        const channelId = id.startsWith("channel:") ? id.slice(8) : undefined;
        routes.set(id, {
          id,
          ...(channelId ? { channelId } : {}),
          status: "pending",
          replay: "unknown",
          count: 0,
          quotaRetries: 0,
          since: Math.floor(Date.now() / 1000) - 300,
        });
      }
    const ranked = [
      ...new Set([
        ...priority.filter((id) => interests.includes(id)),
        ...interests,
      ]),
    ];
    const admitted = new Set(
      ranked.slice(0, LIVE_CHANNEL_CAPACITY - (observer !== null ? 1 : 0)),
    );
    for (const route of routes.values())
      if (route.channelId) {
        if (!admitted.has(route.channelId)) {
          if (route.wire) {
            remove(route);
            routes.set(route.id, route);
            delete route.wire;
          }
          route.status = "limited";
          route.error =
            "Live channel capacity reached; finite reads remain available";
        } else if (route.status === "limited") {
          route.status = "pending";
          delete route.error;
        }
      }
    pump();
    notify();
  }
  function fail(route: Route, reason: string) {
    clearTimeout(route.deadline);
    if (route.wire) {
      wires.delete(route.wire);
      send(["CLOSE", route.wire]);
    }
    delete route.wire;
    route.status = "error";
    route.error = reason;
    if (reason.startsWith("rate-limited:")) {
      const hint = /^rate-limited: quota exceeded; retry in (\d+)s$/.exec(
        reason,
      );
      const seconds = hint ? Number(hint[1]) : 5;
      if (!Number.isSafeInteger(seconds) || seconds > 60) {
        for (const queued of routes.values())
          if (queued.status === "pending" && !queued.wire) {
            queued.status = "error";
            queued.error = "Unsupported live cooldown; automatic setup stopped";
          }
        // Conservative shared pause survives replacement; never overflow a timer.
        admission.pause(
          Number.isSafeInteger(seconds) && seconds <= 86400 ? seconds : 86400,
        );
      } else {
        admission.pause(seconds);
        if (++route.quotaRetries <= MAX_QUOTA_RETRIES) route.status = "pending";
        else {
          // Stop the unsent queue too: rejection must never drain it into an exhausted budget.
          for (const queued of routes.values())
            if (queued.status === "pending" && !queued.wire) {
              queued.status = "error";
              queued.error =
                "Live request cooldown retries exhausted; retry available";
            }
        }
      }
    }
    notify();
    if (route.channelId && reason === "restricted: not a channel member")
      callbacks.denied(route.channelId, reason);
    pump();
  }
  function pump() {
    clearTimeout(dispatchTimer);
    if (closed || !authenticated) return;
    let active = [...routes.values()].filter(
      (route) => route.wire && route.status === "pending",
    ).length;
    const rank = (route: Route) =>
      !route.channelId
        ? -2
        : priority.includes(route.channelId)
          ? priority.indexOf(route.channelId)
          : priority.length;
    for (const route of [...routes.values()].sort(
      (a, b) => rank(a) - rank(b),
    )) {
      if (active >= SETUP_CONCURRENCY) break;
      if (route.status !== "pending" || route.wire) continue;
      const delay = admission.delay();
      if (delay > 0) {
        dispatchTimer = setTimeout(pump, delay);
        break;
      }
      admission.take();
      // A retry being sent is not recovery. Retain its last failure until EOSE.
      const wire = `live-${++serial}`;
      route.wire = wire;
      wires.set(wire, route);
      route.deadline = setTimeout(() => {
        if (wires.get(wire) === route)
          fail(route, "Live subscription setup timed out; retry available");
      }, 10000);
      active++;
      if (route.id === "observer") route.since = Math.floor(Date.now() / 1000);
      const scope = route.channelId
        ? { kinds: CHANNEL_KINDS, "#h": [route.channelId] }
        : route.id === "profiles"
          ? { kinds: [0] }
          : route.id === "observer"
            ? { kinds: [OBSERVER_KIND], "#p": [viewer] }
            : { kinds: [44100, 44101], "#p": [viewer] };
      send([
        "REQ",
        wire,
        {
          ...scope,
          // Live-only on every actual dispatch, including paced retries.
          since: route.since,
          ...(route.id === "observer" ? {} : { limit: LIVE_REPLAY_LIMIT }),
        },
        ...(route.id === "membership"
          ? [
              {
                kinds: [30078],
                authors: [viewer],
                "#t": ["read-state"],
                since: route.since,
                limit: LIVE_REPLAY_LIMIT,
              },
            ]
          : []),
        ...(route.id === "profiles"
          ? [
              {
                kinds: [30030],
                "#d": [EMOJI_SET],
                since: route.since,
                limit: LIVE_REPLAY_LIMIT,
              },
            ]
          : []),
      ]);
    }
  }
  function clearSocket() {
    generation++;
    authenticated = false;
    clearTimeout(dispatchTimer);
    clearTimeout(deadline);
    for (const route of routes.values()) clearTimeout(route.deadline);
    wires.clear();
    socket?.close();
    socket = undefined;
  }
  function connect() {
    if (closed) return;
    clearSocket();
    routes.clear();
    connection = "connecting";
    connectionError = undefined;
    sync();
    const current = generation;
    const valid = () => !closed && current === generation;
    const reconnect = (reason: string) => {
      if (!valid()) return;
      clearSocket();
      connection = "retrying";
      connectionError = reason;
      for (const route of routes.values())
        if (route.status !== "limited") route.status = "pending";
      notify();
      if (attempts >= 5) {
        connection = "error";
        connectionError = "Live reconnect attempts exhausted; retry available";
        notify();
        return;
      }
      retryTimer = setTimeout(connect, 500 * 2 ** attempts++);
    };
    const terminal = (reason: string) => {
      if (!valid()) return;
      clearSocket();
      connection = "error";
      connectionError = reason;
      notify();
    };
    let ws: WebSocket;
    try {
      ws = socketFactory(url);
      socket = ws;
    } catch {
      reconnect("Live connection unavailable");
      return;
    }
    let authId: string | undefined;
    let authenticating = false;
    deadline = setTimeout(
      () => reconnect("Live authentication timed out"),
      10000,
    );
    ws.onmessage = async (event) => {
      if (
        !valid() ||
        typeof event.data !== "string" ||
        event.data.length > 1024 * 1024
      )
        return;
      let data: unknown;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!Array.isArray(data)) return;
      if (
        data[0] === "AUTH" &&
        typeof data[1] === "string" &&
        !authenticating
      ) {
        authenticating = true;
        try {
          const auth = await sign({
            kind: 22242,
            content: "",
            created_at: Math.floor(Date.now() / 1000),
            tags: [
              ["relay", url],
              ["challenge", data[1]],
            ],
          });
          if (!valid()) return;
          if (auth.pubkey !== viewer) {
            terminal("Live signer does not match viewer");
            return;
          }
          authId = auth.id;
          send(["AUTH", auth]);
        } catch {
          terminal("Live authentication signing failed");
        }
        return;
      }
      if (data[0] === "OK" && authId && data[1] === authId && !authenticated) {
        if (data[2] !== true) {
          terminal("Relay rejected live authentication");
          return;
        }
        clearTimeout(deadline);
        authenticated = true;
        connection = "connected";
        pump();
        notify();
        return;
      }
      const route =
        typeof data[1] === "string" ? wires.get(data[1]) : undefined;
      if (!authenticated || !route) return;
      if (data[0] === "EVENT") {
        let incoming: VerifiedEvent;
        try {
          incoming = eventDto(data[2]);
        } catch {
          fail(route, "Relay supplied invalid live traffic");
          return;
        }
        if (route.status === "pending") route.count++;
        if (route.id === "observer") {
          if (
            observer !== null &&
            incoming.kind === OBSERVER_KIND &&
            incoming.created_at >= route.since
          )
            callbacks.telemetry?.(incoming, observer);
        } else if (incoming.kind !== OBSERVER_KIND)
          callbacks.receive(
            [incoming],
            Object.freeze({
              phase: route.status === "live" ? "live" : "replay",
              ...(route.channelId ? { channelId: route.channelId } : {}),
            }),
          );
      } else if (data[0] === "EOSE" && route.status === "pending") {
        clearTimeout(route.deadline);
        route.status = "live";
        delete route.error;
        route.replay = route.count >= LIVE_REPLAY_LIMIT ? "limited" : "unknown";
        notify();
        if (!valid() || wires.get(route.wire ?? "") !== route) return;
        if (route.id !== "observer") callbacks.established(route.channelId);
        if (valid()) pump();
      } else if (data[0] === "CLOSED") {
        fail(
          route,
          typeof data[2] === "string"
            ? data[2].slice(0, 512)
            : "Relay closed live subscription",
        );
      }
    };
    ws.onerror = () => reconnect("Live connection interrupted");
    ws.onclose = () => reconnect("Live connection closed");
  }
  connect();
  return {
    observe(value) {
      const next = observerGeneration(value);
      if (closed || observer === next) return;
      observer = next;
      const route = routes.get("observer");
      if (route) remove(route); // Fence the old wire before enabling a new generation.
      sync();
    },
    prioritize(input) {
      liveChannels(input); // Same bounded ID validation, but preserve demand order.
      priority = [...new Set(input)].slice(0, 64);
      if (!closed) sync();
    },
    update(input) {
      const next = liveChannels(input);
      if (closed || JSON.stringify(next) === JSON.stringify(interests)) return;
      interests = next;
      sync();
    },
    retry() {
      if (closed) return;
      clearTimeout(retryTimer);
      attempts = 0;
      if (authenticated) {
        for (const route of routes.values()) {
          if (route.status !== "error") continue;
          route.status = "pending";
          route.count = 0;
          route.quotaRetries = 0;
        }
        pump();
        notify();
      } else connect();
    },
    dispose() {
      if (closed) return;
      closed = true;
      clearTimeout(retryTimer);
      clearSocket();
      routes.clear();
    },
  };
}
