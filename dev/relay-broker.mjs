import { decodeAgentObserver } from "./agent-observer.mjs";
import { observerGeneration } from "../src/features/agents/observer.ts";
import {
  decodeReadState,
  signReadState,
  READ_STATE_DECODE_BYTES,
} from "./read-state.mjs";
import { READ_STATE_EVENT_BYTES } from "../src/features/relay/read-state-model.ts";
import {
  isReadSnapshotFilter,
  readSnapshotText,
  readSnapshotCommunity,
} from "../src/features/relay/read-state-snapshot.ts";
import { readAgentLibrary } from "./agent-library.mjs";
import {
  decodeSidebarPreferences,
  SIDEBAR_REQUEST_BYTES,
  SIDEBAR_UPLOAD_MS,
  SIDEBAR_UPLOAD_SLOTS,
} from "./sidebar-preferences.mjs";
import { createHostAdmission } from "../src/features/relay/host-admission.ts";
import { relayKlipySearchPath } from "../src/features/relay/gifs.ts";
// Dev-only relay broker. Holds the local Buzz identity in this Node process and signs NIP-98 reads
// for the browser, so no key ever reaches page JavaScript. The dev server loads it whenever
// BUZZ_DEV_VIEWER is configured; production builds and tests never load it.
// Scoped writes support basic messages, profile setup and invite admission; signing remains here.
import {
  liveChannels,
  subscribeRelayTraffic,
} from "../src/features/relay/live.ts";
import {
  communityDestination,
  parseCommunityAliases,
  relayOrigin,
} from "../src/features/communities/destination.ts";
import {
  admittedApiRequest,
  ApiPaused,
  ApiCapacity,
  apiFailure,
} from "../src/features/relay/http-admission.ts";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import dc from "node:diagnostics_channel";
import { finalizeEvent, getPublicKey, nip19, verifyEvent } from "nostr-tools";
import { Agent, fetch as upstreamHttp, interceptors } from "undici";

const MAX_FILTERS = 4,
  MAX_LIMIT = 500,
  MAX_INFLIGHT = 6,
  MAX_MEDIA_BYTES = 20 * 1024 * 1024,
  UPSTREAM_TIMEOUT_MS = 20000,
  KEEPALIVE_MS = 60000;

/** Warm, long-lived upstream connections. Node's default pool drops idle sockets after
 * four seconds, so every send after a short pause paid DNS + TCP + TLS again; a cold
 * connect is also the step most exposed to network stalls. DNS answers are cached too. */
export function createUpstream(base) {
  // A lost SYN costs 1 s, then 2 s, then 4 s before the OS retries, so a single unlucky
  // connect can hold a send for seven seconds. Fail the connect early and retry it
  // once. Only connection errors retry: relay responses, including 5xx, stay
  // authoritative for delivery status.
  const agent = new Agent({
    keepAliveTimeout: KEEPALIVE_MS,
    keepAliveMaxTimeout: KEEPALIVE_MS,
    connect: { timeout: 2500 },
  }).compose(
    interceptors.dns({ maxTTL: KEEPALIVE_MS }),
    interceptors.retry({
      maxRetries: 1,
      minTimeout: 50,
      maxTimeout: 250,
      methods: ["GET", "POST"],
      statusCodes: [],
      // Connect-phase failures only: the request was never sent, so a retry cannot duplicate it.
      errorCodes: [...CONNECT_FAILURES],
    }),
  );
  let connects = 0;
  let lastConnectMs = 0;
  let connectStart = 0;
  const subscriptions = {
    "undici:client:beforeConnect": () => {
      connectStart = performance.now();
    },
    "undici:client:connected": () => {
      connects++;
      lastConnectMs = performance.now() - connectStart;
    },
  };
  for (const [name, handler] of Object.entries(subscriptions))
    dc.subscribe(name, handler);
  const fetch = (url, init) =>
    upstreamHttp(url, { ...init, dispatcher: agent });
  return {
    fetch,
    /** Server-Timing `connect` when a request had to open a new upstream connection. */
    connectTiming(before) {
      return connects === before
        ? []
        : [`connect;dur=${lastConnectMs.toFixed(2)}`];
    },
    connects: () => connects,
    /** Establish the connection before the first user-visible request needs it. */
    warm: () =>
      base
        ? fetch(base, {
            headers: { Accept: "application/nostr+json" },
            signal: AbortSignal.timeout(10000),
          })
            .then((response) => response.arrayBuffer())
            .catch(() => {})
        : Promise.resolve(),
    close() {
      for (const [name, handler] of Object.entries(subscriptions))
        dc.unsubscribe(name, handler);
      return agent.close();
    },
  };
}

function loadIdentity(authorizedViewer) {
  // Validate the explicit public pin before prompting for any credential access.
  const configured = authorizedViewer?.trim() ?? "";
  let expected;
  if (/^[0-9a-f]{64}$/i.test(configured)) expected = configured.toLowerCase();
  else if (configured.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(configured);
      if (decoded.type === "npub") expected = decoded.data;
    } catch {
      // Report configuration guidance, never echo arbitrary input (possibly a secret).
    }
  }
  if (!expected)
    throw new Error(
      "Set BUZZ_DEV_VIEWER in .env.local to your existing Buzz public key (hex or npub, never nsec). See README.md#relay-channels.",
    );
  let raw;
  try {
    raw = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", "buzz-desktop", "-a", "secrets", "-w"],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 120000 },
    )
      .toString()
      .trim();
  } catch {
    throw new Error(
      "Keychain read unavailable or declined; no credential fallback",
    );
  }
  let decoded;
  try {
    decoded = nip19.decode(JSON.parse(raw).identity);
  } catch {
    throw new Error("Keychain identity invalid; no credential fallback");
  }
  if (decoded.type !== "nsec")
    throw new Error("Keychain identity must be nsec; no credential fallback");
  if (getPublicKey(decoded.data) !== expected) {
    decoded.data.fill(0);
    throw new Error(
      "Keychain identity does not match BUZZ_DEV_VIEWER. Check the public key of your existing Buzz account; do not replace or delete its credential.",
    );
  }
  return decoded.data;
}
async function relayAuthority(fetch, relay) {
  const response = await fetch(relay, {
    headers: { Accept: "application/nostr+json" },
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("Relay identity discovery failed");
  const nip11 = await response.json();
  if (!nip11 || typeof nip11 !== "object" || Array.isArray(nip11))
    throw new Error("Relay did not advertise its identity");
  const author = nip11.self ?? nip11.pubkey;
  if (typeof author !== "string" || !/^[0-9a-f]{64}$/.test(author))
    throw new Error("Relay did not advertise its identity");
  return {
    relayAuthor: author,
    ...(readSnapshotCommunity(nip11.read_state_snapshot)
      ? { readStateCommunity: readSnapshotCommunity(nip11.read_state_snapshot) }
      : {}),
    // NIP-IA snapshots require the explicit relay signing identity. The NIP-11
    // contact-key fallback used by older channel reads cannot grant this authority.
    ...(nip11.self === author ? { archiveAuthority: author } : {}),
  };
}
export function validMessageTemplate(event) {
  return (
    event &&
    event.kind === 9 &&
    typeof event.content === "string" &&
    event.content.trim().length > 0 &&
    Buffer.byteLength(event.content) <= 32000 &&
    Number.isSafeInteger(event.created_at) &&
    Array.isArray(event.tags) &&
    event.tags.every(
      (tag) =>
        Array.isArray(tag) && tag.every((value) => typeof value === "string"),
    ) &&
    event.tags.filter(
      (tag) =>
        tag[0] === "h" && typeof tag[1] === "string" && tag[1].length > 0,
    ).length === 1 &&
    (() => {
      const references = event.tags.filter((tag) => tag[0] === "e");
      if (!references.length) return true;
      const [reply] = references;
      // This write surface supports direct-to-root replies, not arbitrary references.
      return (
        references.length === 1 &&
        reply.length === 4 &&
        /^[0-9a-f]{64}$/.test(reply[1]) &&
        reply[2] === "" &&
        reply[3] === "reply"
      );
    })()
  );
}
export function validFilters(filters) {
  return (
    Array.isArray(filters) &&
    filters.length >= 1 &&
    filters.length <= MAX_FILTERS &&
    filters.every(
      (filter) =>
        filter &&
        typeof filter === "object" &&
        ((Array.isArray(filter.kinds) &&
          filter.kinds.length > 0 &&
          filter.kinds.every(
            (kind) => Number.isInteger(kind) && kind >= 0 && kind <= 65535,
          )) ||
          (filter.kinds === undefined &&
            Array.isArray(filter.ids) &&
            filter.ids.length > 0)) &&
        Number.isInteger(filter.limit) &&
        filter.limit >= 1 &&
        filter.limit <= MAX_LIMIT,
    )
  );
}
const CONNECT_FAILURES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);
export const isConnectFailure = (error) =>
  CONNECT_FAILURES.has(error?.code) || CONNECT_FAILURES.has(error?.cause?.code);
const json = (res, code, body) => {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
};

/** @returns {import('vite').Plugin} */
export function relayBrokerPlugin({
  authorizedViewer,
  relayUrl,
  communityAliases,
  identity = () => loadIdentity(authorizedViewer),
  authority = relayAuthority,
  upstreamFetch,
  socketFactory,
  agentLibrary = readAgentLibrary,
} = {}) {
  const aliases = parseCommunityAliases(communityAliases);
  const defaultRelay = relayUrl?.trim() ? relayOrigin(relayUrl) : undefined;
  return {
    name: "buzz-relay-broker",
    async configureServer(server) {
      const key = identity();
      const viewer = getPublicKey(key);
      const upstream = createUpstream();
      // Injected fixtures bypass the pool; the live relay always uses the warm agent.
      const fetchUpstream = upstreamFetch ?? upstream.fetch;
      // Discovery is lazy and independent for each community; unavailable relays never block startup.
      const registered = new Map(Object.entries(aliases));
      const authorities = new Map();
      const gifSearchPaths = new Map();
      const getAuthority = (relay) => {
        if (!authorities.has(relay))
          authorities.set(
            relay,
            authority(fetchUpstream, relay).catch((error) => {
              authorities.delete(relay);
              throw error;
            }),
          );
        return authorities.get(relay);
      };
      const getGifSearchPath = (relay) => {
        if (!gifSearchPaths.has(relay))
          gifSearchPaths.set(
            relay,
            fetchUpstream(relay, {
              headers: { Accept: "application/nostr+json" },
              redirect: "error",
              signal: AbortSignal.timeout(10000),
            })
              .then(async (response) => {
                if (!response.ok) throw new Error("GIF discovery failed");
                return relayKlipySearchPath(await response.json());
              })
              .catch((error) => {
                gifSearchPaths.delete(relay);
                throw error;
              }),
          );
        return gifSearchPaths.get(relay);
      };
      const stats = { queries: 0, errors: 0, media: 0, connects: 0 };
      let inflight = 0;
      let sidebarUploads = 0;
      let libraryRead;
      const streams = new Map();
      const admissions = createHostAdmission();
      server.httpServer?.once("close", () => {
        for (const { close } of streams.values()) close();
        key.fill(0);

        void upstream.close();
      });
      server.config.logger.info(
        `[relay-broker] signing as ${viewer.slice(0, 8)}… for explicitly selected communities (lazy, scoped connections)`,
      );
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/relay/")) return next();
        const origin = `http://${req.headers.host ?? ""}`;
        // Same-origin browser access only; trusted plugins/local processes are not sandboxed.
        if (!/^(localhost|127\.0\.0\.1):\d+$/.test(req.headers.host ?? ""))
          return json(res, 403, { error: "Host rejected" });
        if (
          (req.method === "POST" && req.headers.origin !== origin) ||
          (req.headers.origin && req.headers.origin !== origin) ||
          (req.headers["sec-fetch-site"] &&
            req.headers["sec-fetch-site"] !== "same-origin")
        )
          return json(res, 403, { error: "Origin rejected" });
        const url = new URL(req.url, origin);
        try {
          if (url.pathname === "/api/relay/register" && req.method === "POST") {
            let raw = "";
            for await (const part of req) {
              raw += part;
              if (raw.length > 4096)
                return json(res, 413, { error: "Relay URL too large" });
            }
            try {
              const value = JSON.parse(raw).url;
              if (typeof value !== "string")
                throw new Error("Enter a relay URL");
              const destination = communityDestination(value, aliases);
              registered.set(destination.id, destination.url);
              return json(res, 200, destination);
            } catch (error) {
              return json(res, 400, {
                error:
                  error instanceof Error ? error.message : "Invalid relay URL",
              });
            }
          }
          if (url.pathname === "/api/relay/identity" && req.method === "GET")
            return json(res, 200, { viewer });
          const parts = url.pathname.split("/").filter(Boolean);
          const scoped = parts.length === 4;
          let id;
          try {
            id = scoped
              ? communityDestination(decodeURIComponent(parts[2]), aliases).id
              : undefined;
          } catch {
            return json(res, 400, { error: "Invalid community" });
          }
          const relay = scoped ? registered.get(id) : defaultRelay;
          if (!relay)
            return json(res, 400, {
              error: scoped
                ? "Register this community first"
                : "Select a community or configure BUZZ_RELAY_URL for unscoped requests",
            });
          const route = scoped ? `/api/relay/${parts[3]}` : url.pathname;
          if (route === "/api/relay/identity" && req.method === "GET")
            return json(res, 200, { viewer });
          if (route === "/api/relay/gif-info" && req.method === "GET") {
            const gifSearchPath = await getGifSearchPath(relay);
            return json(res, 200, {
              ...(gifSearchPath
                ? {
                    supported_extensions: ["buzz-gif"],
                    gif: { provider: "klipy", search: gifSearchPath },
                  }
                : {}),
            });
          }
          if (route === "/api/relay/info" && req.method === "GET") {
            const response = await fetchUpstream(relay, {
              headers: { Accept: "application/nostr+json" },
              redirect: "error",
              signal: AbortSignal.timeout(10000),
            });
            if (!response.ok)
              return json(res, response.status, {
                error: "Community discovery failed",
              });
            const info = await response.json();
            const gifSearchPath = relayKlipySearchPath(info);
            gifSearchPaths.set(relay, Promise.resolve(gifSearchPath));
            const policyResponse = await fetchUpstream(
              `${relay}/api/join-policy`,
              { redirect: "error", signal: AbortSignal.timeout(10000) },
            );
            if (!policyResponse.ok && policyResponse.status !== 404)
              return json(res, policyResponse.status, {
                error: "Could not load join policy",
              });
            const policy =
              policyResponse.status === 404
                ? null
                : (await policyResponse.json()).policy;
            return json(res, 200, {
              name: info.name,
              icon: info.icon,
              policy: policy ?? null,
              ...(gifSearchPath
                ? {
                    supported_extensions: ["buzz-gif"],
                    gif: { provider: "klipy", search: gifSearchPath },
                  }
                : {}),
            });
          }
          if (
            [
              "/api/relay/sidebar-preferences",
              "/api/relay/read-state-decode",
            ].includes(route) &&
            req.method === "POST"
          ) {
            const readStateDecode = route === "/api/relay/read-state-decode";
            if (sidebarUploads >= SIDEBAR_UPLOAD_SLOTS)
              return json(res, 429, { error: "Sidebar decoder is busy" });
            sidebarUploads++;
            // Whole-upload deadline, not an idle timeout that trickled bytes reset.
            const deadline = setTimeout(() => req.destroy(), SIDEBAR_UPLOAD_MS);
            deadline.unref();
            try {
              const chunks = [];
              let bytes = 0;
              for await (const part of req) {
                bytes += Buffer.byteLength(part);
                if (
                  bytes >
                  (readStateDecode
                    ? READ_STATE_DECODE_BYTES
                    : SIDEBAR_REQUEST_BYTES)
                )
                  return json(res, 413, {
                    error: "Sidebar records exceed the decode budget",
                  });
                chunks.push(part);
              }
              const events = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              return json(
                res,
                200,
                readStateDecode
                  ? decodeReadState(events, key)
                  : decodeSidebarPreferences(events, key),
              );
            } catch {
              if (!res.destroyed)
                return json(res, 400, {
                  error: readStateDecode
                    ? "Read state could not be decoded"
                    : "Sidebar preferences could not be decoded",
                });
            } finally {
              clearTimeout(deadline);
              sidebarUploads--;
            }
          }
          if (route === "/api/relay/agent-library" && req.method === "GET") {
            try {
              // Share concurrent reads, never retain the local snapshot after completion.
              libraryRead ??= Promise.resolve()
                .then(() => agentLibrary())
                .finally(() => {
                  libraryRead = undefined;
                });
              return json(res, 200, await libraryRead);
            } catch {
              return json(res, 503, {
                error:
                  "Current Buzz agent library unavailable; no files were changed",
              });
            }
          }
          if (route === "/api/relay/session" && req.method === "GET")
            return json(res, 200, {
              viewer,
              ...(await getAuthority(relay)),
              relayUrl: relay,
              writeKinds: [9],
              sidebarPreferences: true,
              readState: true,
              agentLibrary: true,
              live: true,
              agentActivity: true,
            });
          if (
            [
              "/api/relay/stream-retry",
              "/api/relay/stream-priority",
              "/api/relay/stream-observer",
            ].includes(route) &&
            req.method === "POST"
          ) {
            const prioritizing = route === "/api/relay/stream-priority";
            const observing = route === "/api/relay/stream-observer";
            let raw = "";
            for await (const part of req) {
              raw += part;
              if (Buffer.byteLength(raw) > (prioritizing ? 9000 : 256))
                return json(res, 413, { error: "Live control too large" });
            }
            let streamId, priority, observer;
            try {
              const body = JSON.parse(raw);
              streamId = body.streamId;
              if (observing) observer = observerGeneration(body.observer);
              if (prioritizing) {
                liveChannels(body.channels);
                if (body.channels.length > 64)
                  throw new Error("Priority capacity reached");
                priority = [...new Set(body.channels)];
              }
            } catch {
              return json(res, 400, { error: "Invalid live control" });
            }
            if (
              typeof streamId !== "string" ||
              !/^[0-9a-f]{32}$/.test(streamId)
            )
              return json(res, 400, { error: "Invalid live control" });
            const stream = streams.get(streamId);
            if (!stream || stream.relay !== relay)
              return json(res, 404, {
                error: "Live stream no longer available",
              });
            if (prioritizing) stream.traffic.prioritize(priority);
            else if (observing) stream.traffic.observe(observer);
            else stream.traffic.retry();
            return json(res, 200, { accepted: true });
          }
          if (route === "/api/relay/stream" && req.method === "POST") {
            let raw = "";
            for await (const part of req) {
              raw += part;
              if (Buffer.byteLength(raw) > 150000)
                return json(res, 413, { error: "Live interests too large" });
            }
            let channels, priority, observer;
            try {
              const body = JSON.parse(raw);
              channels = liveChannels(body.channels);
              observer = observerGeneration(body.observer ?? null);
              liveChannels(body.priority ?? []);
              if (body.priority?.length > 64)
                throw new Error("Priority capacity reached");
              priority = [...new Set(body.priority ?? [])];
            } catch {
              return json(res, 400, {
                error: "Invalid live channel interests",
              });
            }
            if (streams.size >= 8)
              return json(res, 429, { error: "Live stream capacity reached" });
            const principal = admissions(relay, viewer);
            const streamId = randomBytes(16).toString("hex");
            // An SSE response lasts until disconnect and cannot be reused. Close
            // delimiting avoids WebKit buffering trailing HTTP chunks until a later
            // write (which can otherwise delay establishment until the heartbeat).
            res.useChunkedEncodingByDefault = false;
            res.writeHead(200, {
              "X-Buzz-Live-ID": streamId,
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-store",
              Connection: "close",
            });
            res.flushHeaders();
            // Bound slow-client buffering rather than retaining unbounded traffic.
            const write = (kind, value) => {
              if (res.destroyed) return;
              if (res.writableLength > 2 * 1024 * 1024) {
                res.destroy();
                return;
              }
              res.write(
                `${kind ? `event: ${kind}\n` : ""}data: ${JSON.stringify(value)}\n\n`,
              );
            };
            const traffic = subscribeRelayTraffic(
              relay.replace(/^http/, "ws"),
              async (event) => finalizeEvent(event, key),
              viewer,
              {
                receive: (events, provenance) => {
                  for (const event of events)
                    write("traffic", { event, provenance });
                },
                telemetry: (event, generation) => {
                  if (res.destroyed) return;
                  try {
                    write("observer", {
                      frame: decodeAgentObserver(event, key, viewer),
                      generation,
                    });
                  } catch {
                    // Rejected telemetry cannot break chat or leak payloads in logs.
                  }
                },
                state: (state) => write("state", state),
                established: (channelId) => write("established", { channelId }),
                denied: (channelId, reason) =>
                  write("denied", { channelId, reason }),
              },
              socketFactory,
              principal.live,
            );
            principal.streams++;
            traffic.observe(observer);
            traffic.prioritize(priority);
            traffic.update(channels);
            const keepAlive = setInterval(
              () => res.write(": keepalive\n\n"),
              15000,
            );
            let closed = false;
            const close = () => {
              if (closed) return;
              closed = true;
              principal.streams--;
              traffic.dispose();
              clearInterval(keepAlive);
              streams.delete(streamId);
              res.destroy();
            };
            streams.set(streamId, { relay, traffic, close });
            res.once("close", close);
            if (res.destroyed) close();
            return;
          }
          if (route === "/api/relay/stats" && req.method === "GET")
            return json(res, 200, { ...stats, connects: upstream.connects() });
          if (route === "/api/relay/media" && req.method === "GET") {
            const target = new URL(url.searchParams.get("url") ?? "", relay);
            if (
              target.origin !== relay ||
              !target.pathname.startsWith("/media/")
            )
              return json(res, 403, { error: "Media target rejected" });
            const now = Math.floor(Date.now() / 1000);
            const auth = finalizeEvent(
              {
                kind: 24242,
                created_at: now,
                content: "Get buzz-media",
                tags: [
                  ["t", "get"],
                  ["expiration", String(now + 120)],
                  ["server", new URL(relay).host],
                ],
              },
              key,
            );
            const upstream = await fetchUpstream(target, {
              headers: {
                Authorization:
                  "Nostr " +
                  Buffer.from(JSON.stringify(auth)).toString("base64url"),
              },
              redirect: "error",
              signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
            });
            stats.media++;
            if (!upstream.ok)
              return json(res, upstream.status, { error: "Media read failed" });
            const type = upstream.headers.get("content-type") ?? "";
            if (!type.startsWith("image/"))
              return json(res, 415, {
                error: "Only image previews are proxied",
              });
            const bytes = Buffer.from(await upstream.arrayBuffer());
            if (bytes.length > MAX_MEDIA_BYTES)
              return json(res, 413, { error: "Media budget exceeded" });
            res.writeHead(200, {
              "Content-Type": type,
              "Cache-Control": "private, max-age=3600",
              "X-Content-Type-Options": "nosniff",
            });
            return res.end(bytes);
          }
          if (
            ![
              "/api/relay/query",
              "/api/relay/sign",
              "/api/relay/publish",
              "/api/relay/read-state-sign",
              "/api/relay/read-state-publish",
              "/api/relay/profile",
              "/api/relay/claim",
              "/api/relay/accept-policy",
              "/api/relay/gifs",
            ].includes(route) ||
            req.method !== "POST"
          )
            return json(res, 404, { error: "Unknown broker route" });
          let raw = "";
          for await (const part of req) {
            raw += part;
            if (raw.length > 65536)
              return json(res, 413, { error: "Filter body too large" });
          }
          let filters;
          try {
            filters = JSON.parse(raw);
          } catch {
            return json(res, 400, { error: "Filter body is not JSON" });
          }
          const profile = route === "/api/relay/profile";
          const claim = route === "/api/relay/claim";
          const policy = route === "/api/relay/accept-policy";
          const gifs = route === "/api/relay/gifs";
          if (gifs) {
            if (
              typeof filters?.query !== "string" ||
              filters.query.length > 100 ||
              typeof filters?.customer_id !== "string" ||
              !/^[a-zA-Z0-9:_-]{1,128}$/.test(filters.customer_id) ||
              typeof filters?.locale !== "string" ||
              !/^[a-zA-Z0-9-]{2,35}$/.test(filters.locale)
            )
              return json(res, 400, { error: "Invalid GIF search" });
          }
          if (profile) {
            if (
              typeof filters?.name !== "string" ||
              !filters.name.trim() ||
              filters.name.length > 100 ||
              typeof filters?.picture !== "string" ||
              filters.picture.length > 2048 ||
              (filters.picture && !/^https:\/\//.test(filters.picture))
            )
              return json(res, 400, {
                error: "Profile needs a name and an optional HTTPS picture URL",
              });
            // Preserve fields this small editor does not expose.
            const content = {
              ...(filters.existing ?? {}),
              name: filters.name.trim(),
              display_name: filters.name.trim(),
              picture: filters.picture,
            };
            if (Buffer.byteLength(JSON.stringify(content)) > 16000)
              return json(res, 400, { error: "Profile too large" });
            filters = finalizeEvent(
              {
                kind: 0,
                content: JSON.stringify(content),
                tags: [],
                created_at: Math.floor(Date.now() / 1000),
              },
              key,
            );
          }
          if (claim || policy) {
            if (
              typeof filters?.code !== "string" ||
              !/^[a-zA-Z0-9_-]{1,256}$/.test(filters.code)
            )
              return json(res, 400, { error: "Invalid invite code" });
            filters = policy
              ? {
                  code: filters.code,
                  policy_version: filters.policy_version,
                  age_confirmed: filters.age_confirmed === true,
                }
              : { code: filters.code, policy_receipt: filters.policy_receipt };
          }
          const readSigning = route === "/api/relay/read-state-sign";
          const readPublishing = route === "/api/relay/read-state-publish";
          if (readSigning || readPublishing) {
            try {
              if (readSigning)
                return json(res, 200, signReadState(filters, key));
              // A valid own signature alone is not permission to publish arbitrary kind-30078 data.
              // Receive-only compatibility must not widen publication admission.
              decodeReadState([filters], key, READ_STATE_EVENT_BYTES);
            } catch {
              return json(res, 400, {
                error: "Read-state operation rejected",
                sent: false,
              });
            }
          }
          const snapshot = isReadSnapshotFilter(filters, viewer);
          if (
            Array.isArray(filters) &&
            filters.some(
              (filter) =>
                filter && Object.hasOwn(filter, "read_state_snapshot"),
            ) &&
            !snapshot
          )
            return json(res, 400, {
              error: "Invalid read-state snapshot filter",
              sent: false,
            });
          if (snapshot && !(await getAuthority(relay)).readStateCommunity)
            return json(res, 400, {
              error: "Complete read-state snapshots unsupported",
              sent: false,
            });
          const timings = [];
          const signing = route === "/api/relay/sign";
          const publishing = route === "/api/relay/publish";
          if (signing || publishing) {
            if (!validMessageTemplate(filters))
              return json(res, 400, { error: "Message rejected" });
            if (signing) {
              const started = performance.now();
              const event = finalizeEvent(
                {
                  kind: 9,
                  content: filters.content,
                  created_at: filters.created_at,
                  tags: filters.tags,
                },
                key,
              );
              res.setHeader(
                "Server-Timing",
                `sign;dur=${(performance.now() - started).toFixed(2)}`,
              );
              return json(res, 200, event);
            }
            if (filters.pubkey !== viewer || !verifyEvent(filters))
              return json(res, 400, { error: "Invalid outgoing signature" });
          } else if (
            !profile &&
            !claim &&
            !policy &&
            !gifs &&
            !readPublishing &&
            !snapshot &&
            !validFilters(filters)
          )
            return json(res, 400, { error: "Read filter rejected" });
          const gifSearchPath = gifs ? await getGifSearchPath(relay) : null;
          if (gifs && !gifSearchPath)
            return json(res, 404, { error: "GIF search is unavailable" });
          const upstreamPath = gifs
            ? gifSearchPath
            : profile || publishing || readPublishing
              ? "/events"
              : claim
                ? "/api/invites/claim"
                : policy
                  ? "/api/invites/accept-policy"
                  : "/query";
          if (inflight >= MAX_INFLIGHT)
            return json(res, 429, {
              error: "Query concurrency limit",
              sent: false,
            });
          inflight++;
          try {
            const lane = admissions(relay, viewer).api;
            const body = JSON.stringify(filters);
            // A browser that gave up (the client's ten-second deadline) must also release
            // this upstream request, or hung requests exhaust the inflight budget.
            const cancel = new AbortController();
            const release = () => cancel.abort();
            res.once("close", release);
            const admissionStart = performance.now();
            let connectsBefore, upstreamStart;
            let response;
            try {
              const requestSignal = AbortSignal.any([
                cancel.signal,
                AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
              ]);
              response = await admittedApiRequest(
                lane,
                () => {
                  // Auth freshness and network timings begin at dispatch, not queue entry.
                  requestSignal.throwIfAborted();
                  timings.push(
                    `admission;dur=${(performance.now() - admissionStart).toFixed(2)}`,
                  );
                  const authStart = performance.now();
                  const auth = finalizeEvent(
                    {
                      kind: 27235,
                      created_at: Math.floor(Date.now() / 1000),
                      content: "",
                      tags: [
                        ["u", `${relay}${upstreamPath}`],
                        ["method", "POST"],
                        [
                          "payload",
                          createHash("sha256").update(body).digest("hex"),
                        ],
                        ["nonce", randomBytes(16).toString("hex")],
                      ],
                    },
                    key,
                  );
                  timings.push(
                    `auth;dur=${(performance.now() - authStart).toFixed(2)}`,
                  );
                  connectsBefore = upstream.connects();
                  upstreamStart = performance.now();
                  return fetchUpstream(`${relay}${upstreamPath}`, {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      Authorization:
                        "Nostr " +
                        Buffer.from(JSON.stringify(auth)).toString("base64"),
                    },
                    body,
                    redirect: "error",
                    signal: requestSignal,
                  }).then((response) => {
                    timings.push(
                      `ttfb;dur=${(performance.now() - upstreamStart).toFixed(2)}`,
                    );
                    return response;
                  });
                },
                requestSignal,
                route === "/api/relay/query" &&
                  req.headers["x-buzz-read-priority"] === "background"
                  ? "background"
                  : "foreground",
              );
              const text =
                snapshot && response.ok
                  ? await readSnapshotText(response)
                  : await response.text();
              // The relay's own service time separates server work from network time.
              const relayMs = Number(
                response.headers.get("x-envoy-upstream-service-time"),
              );
              timings.push(
                ...upstream.connectTiming(connectsBefore),
                ...(Number.isFinite(relayMs) &&
                response.headers.has("x-envoy-upstream-service-time")
                  ? [`relay;dur=${relayMs}`]
                  : []),
                `upstream;dur=${(performance.now() - upstreamStart).toFixed(2)}`,
              );
              res.setHeader("Server-Timing", timings.join(", "));
              stats.queries++;
              if (!response.ok) {
                stats.errors++;
                let failure;
                try {
                  failure = apiFailure(response.status, JSON.parse(text));
                } catch {
                  failure = apiFailure(response.status, undefined);
                }
                return json(res, response.status, failure);
              }
              if (profile) {
                const receipt = JSON.parse(text);
                if (
                  receipt.event_id !== filters.id ||
                  typeof receipt.accepted !== "boolean"
                )
                  return json(res, 502, {
                    error: "Profile publication could not be confirmed",
                  });
              }
              res.writeHead(200, {
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
              });
              res.end(text);
            } finally {
              res.off("close", release);
            }
          } finally {
            inflight--;
          }
        } catch (error) {
          if (res.destroyed) return; // The browser gave up first; nothing to answer.
          stats.errors++;
          if (error instanceof ApiPaused && !res.headersSent)
            return json(res, 429, {
              error: error.message,
              sent: false,
              paused: true,
              retryAfterMs: error.retryAfterMs,
            });
          if (error instanceof ApiCapacity && !res.headersSent)
            return json(res, 429, {
              error: "Query concurrency limit",
              sent: false,
            });
          server.config.logger.error(
            `[relay-broker] ${error instanceof Error ? error.message : String(error)}`,
          );
          if (res.headersSent) return;
          // The relay was never reached, so nothing was delivered: the client may
          // treat this as a definite failure rather than an unknown outcome.
          if (isConnectFailure(error))
            return json(res, 502, { error: "Relay unreachable", sent: false });
          json(res, 500, { error: "Local relay broker failed" });
        }
      });
    },
  };
}
