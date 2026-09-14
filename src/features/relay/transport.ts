import type { ReadStateHost, ReadStateSigning } from "./read-state-host";
import {
  parseReadSnapshot,
  readSnapshotFilter,
  readSnapshotText,
} from "./read-state-snapshot";
import type { AgentLibraryReader } from "../agents/library";
import type { SidebarDecoder, SidebarPreferences } from "./sidebar-preferences";
import { createHostAdmission } from "./host-admission";
import { relayOrigin } from "../communities/destination";
import {
  admittedApiRequest,
  ApiPaused,
  ApiNotSent,
  readApiFailure,
} from "./http-admission";
import { yieldToHost } from "./yield";
import { createRelayProfiler, type RelayProfiler } from "./profiling";
import {
  subscribeRelayTraffic,
  type LiveCallbacks,
  type LiveSubscription,
} from "./live";
import { subscribeBrokerTraffic } from "./broker-live";
import { PublishRejected } from "./outbox";
import { httpReadError, ReadError } from "./errors";
import type { EventTemplate, VerifiedEvent } from "nostr-tools";
import { eventDto, type ReadFilter, type RelayEvent } from "./events";

/** Relay connection. Implementations verify signatures; callers never see raw JSON. */
export interface RelayWriter {
  readonly kinds?: readonly number[];
  sign(event: EventTemplate, signal: AbortSignal): Promise<RelayEvent>;
  publish(event: RelayEvent, signal: AbortSignal): Promise<void>;
}
export interface ReadTransport {
  /** Purpose-bound observer decoding on the shared host live stream. */
  readonly agentActivity?: boolean;
  /** Host-projected local library; display only, never relay authority. */
  readonly readAgentLibrary?: AgentLibraryReader;
  /** Host-only decoder of the viewer's two signed sidebar preference coordinates. */
  readonly decodeSidebarPreferences?: SidebarDecoder;
  readonly readState?: ReadStateHost;
  /** Strictly validated atomic writer snapshot; never an ordinary event-array query. */
  readStateSnapshot?(
    signal: AbortSignal,
    requestId: string,
    priority: "foreground" | "background",
  ): Promise<RelayEvent[]>;
  readonly profiling?: RelayProfiler;
  /** Verified incoming traffic. The session owns this subscription and fences late delivery. */
  subscribe?(callbacks: LiveCallbacks): LiveSubscription;
  /** Stable community endpoint identity for durable session partitioning. */
  readonly scope?: string;
  /** Optional host-owned write capability, exposed to plugins only through the outbox. */
  readonly writer?: RelayWriter;
  /** The signed-in viewer whose channel roster is authoritative. */
  readonly viewer: string;
  /** Relay authority that signs discovery and window-bounds events. */
  readonly relayAuthor: string;
  /** Explicit NIP-11 self from this community, never a contact-key fallback. */
  readonly archiveAuthority?: string;
  query(
    filters: readonly ReadFilter[],
    signal?: AbortSignal,
    requestId?: string,
    priority?: "foreground" | "background",
  ): Promise<RelayEvent[]>;
  /** Display URL for a media URL, or undefined when this transport cannot fetch it. */
  media(url: string): string | undefined;
}
/** Third-party https images load directly; relay-hosted media needs a signed read. */
export function mediaUrl(
  url: string,
  relayProxy: ((url: string) => string) | undefined,
  relayOrigin: string | undefined,
): string | undefined {
  if (url.startsWith(`${relayOrigin}/media/`)) return relayProxy?.(url);
  return /^https:\/\//.test(url) ? url : undefined;
}
export interface Signer {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<VerifiedEvent>;
}

async function parseEvents(
  raw: unknown,
  signal?: AbortSignal,
): Promise<RelayEvent[]> {
  if (!Array.isArray(raw))
    throw new ReadError(
      "invalid-response",
      "Relay response is not an event array",
    );
  const events: RelayEvent[] = [];
  // Signature checks are CPU work too. Yield between small batches so speculative
  // head/profile responses cannot monopolize input and foreground rendering.
  for (let index = 0; index < raw.length; index += 12) {
    if (signal?.aborted) throw new DOMException("Read cancelled", "AbortError");
    events.push(...raw.slice(index, index + 12).map(eventDto));
    if (index + 12 < raw.length) await yieldToHost();
  }
  return events;
}

/** Register trusted-app-origin intent before contacting a new destination. No remote join. */
export async function registerBrokerCommunity(
  community: string,
  signal?: AbortSignal,
  base = "",
) {
  const response = await fetch(`${base}/api/relay/register`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: community }),
    signal: signal ?? null,
  });
  if (!response.ok) {
    const result = await response.json();
    throw new Error(
      result.error ?? `Community registration failed (${response.status})`,
    );
  }
}

/** Dev-only: a same-origin broker (see dev/relay-broker.mjs) holds the key and signs reads. */
export async function connectBrokerTransport(
  base = "",
  signal?: AbortSignal,
  community?: string,
): Promise<ReadTransport> {
  if (community) await registerBrokerCommunity(community, signal, base);
  const endpoint = `${base}/api/relay${community ? `/${encodeURIComponent(community)}` : ""}`;
  const profiling = createRelayProfiler();
  const response = await fetch(`${endpoint}/session`, {
    credentials: "same-origin",
    signal: signal ?? null,
  });
  if (!response.ok) throw httpReadError(response.status);
  const session = (await response.json()) as {
    viewer?: unknown;
    relayAuthor?: unknown;
    archiveAuthority?: unknown;
    writeKinds?: number[];
    relayUrl?: string;
    live?: boolean;
    sidebarPreferences?: boolean;
    agentLibrary?: boolean;
    agentActivity?: boolean;
    readState?: boolean;
    readStateCommunity?: string;
  };
  if (
    typeof session.viewer !== "string" ||
    typeof session.relayAuthor !== "string" ||
    (session.archiveAuthority !== undefined &&
      (typeof session.archiveAuthority !== "string" ||
        !/^[0-9a-f]{64}$/.test(session.archiveAuthority) ||
        session.archiveAuthority !== session.relayAuthor))
  )
    throw new ReadError(
      "invalid-response",
      "Relay broker session is malformed",
    );
  return {
    profiling,
    agentActivity: session.agentActivity === true && session.live === true,
    ...(session.live
      ? {
          subscribe: (callbacks: LiveCallbacks) =>
            subscribeBrokerTraffic(endpoint, callbacks),
        }
      : {}),
    ...(session.relayUrl ? { scope: session.relayUrl } : {}),
    viewer: session.viewer,
    relayAuthor: session.relayAuthor,
    ...(typeof session.archiveAuthority === "string"
      ? { archiveAuthority: session.archiveAuthority }
      : {}),
    ...(session.agentLibrary
      ? {
          readAgentLibrary: async (signal: AbortSignal) => {
            const result = await fetch(`${endpoint}/agent-library`, {
              credentials: "same-origin",
              signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
            });
            if (!result.ok) throw new Error("Current Buzz library unavailable");
            return result.json();
          },
        }
      : {}),
    ...(session.sidebarPreferences
      ? {
          async decodeSidebarPreferences(
            events: readonly RelayEvent[],
            signal: AbortSignal,
          ): Promise<SidebarPreferences> {
            const result = await fetch(`${endpoint}/sidebar-preferences`, {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(events),
              signal,
            });
            if (!result.ok)
              throw new Error(`Local decoder failed (HTTP ${result.status})`);
            return result.json();
          },
        }
      : {}),
    ...(session.readState
      ? {
          readState: {
            ...(session.readStateCommunity
              ? { communityId: session.readStateCommunity }
              : {}),
            async decode(events: readonly RelayEvent[], signal: AbortSignal) {
              const response = await fetch(`${endpoint}/read-state-decode`, {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(events),
                signal,
              });
              if (!response.ok)
                throw new Error(
                  `Read-state decode failed (${response.status})`,
                );
              return response.json();
            },
            async sign(intent: ReadStateSigning, signal: AbortSignal) {
              const response = await fetch(`${endpoint}/read-state-sign`, {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(intent),
                signal,
              });
              if (!response.ok)
                throw new Error(
                  `Read-state signing failed (${response.status})`,
                );
              return eventDto(await response.json());
            },
            async publish(event: RelayEvent, signal: AbortSignal) {
              const response = await fetch(`${endpoint}/read-state-publish`, {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(event),
                signal,
              });
              await acceptPublish(response, event.id);
            },
          },
        }
      : {}),
    ...(session.readStateCommunity
      ? {
          async readStateSnapshot(
            signal: AbortSignal,
            requestId: string,
            priority: "foreground" | "background",
          ) {
            const response = await fetch(`${endpoint}/query`, {
              method: "POST",
              credentials: "same-origin",
              headers: {
                "Content-Type": "application/json",
                "X-Buzz-Read-Priority": priority,
              },
              body: JSON.stringify(
                readSnapshotFilter(session.viewer as string),
              ),
              signal,
            });
            if (!response.ok)
              throw new Error(
                `Read-state snapshot failed (${response.status})`,
              );
            recordServerTiming(response, profiling, requestId);
            return parseReadSnapshot(
              JSON.parse(await readSnapshotText(response)),
              session.viewer as string,
              session.readStateCommunity as string,
              signal,
            );
          },
        }
      : {}),
    ...(session.writeKinds
      ? {
          writer: {
            kinds: session.writeKinds,
            async sign(template: EventTemplate, signal: AbortSignal) {
              const result = await fetch(`${endpoint}/sign`, {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(template),
                signal,
              });
              if (!result.ok)
                throw new Error(`Signing failed (${result.status})`);
              const event = eventDto(await result.json());
              recordServerTiming(result, profiling, event.id);
              return event;
            },
            async publish(event: RelayEvent, signal: AbortSignal) {
              const result = await fetch(`${endpoint}/publish`, {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(event),
                signal,
              });
              recordServerTiming(result, profiling, event.id);
              await acceptPublish(result, event.id);
            },
          },
        }
      : {}),
    media: (url) =>
      mediaUrl(
        url,
        (target) => `${endpoint}/media?url=${encodeURIComponent(target)}`,
        session.relayUrl,
      ),
    async query(filters, signal, requestId = "read", priority = "foreground") {
      const result = await fetch(`${endpoint}/query`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-Buzz-Read-Priority": priority,
        },
        body: JSON.stringify(filters),
        signal: signal ?? null,
      });
      if (!result.ok) {
        const failure = await readApiFailure(result);
        throw new ReadError(
          result.status === 401 || result.status === 403
            ? "denied"
            : "unavailable",
          failure.error,
          result.status,
          failure.retryAfterMs,
        );
      }
      recordServerTiming(result, profiling, requestId);
      return profiling.measureAsync("read.verify", requestId, async () =>
        parseEvents(await result.json(), signal),
      );
    },
  };
}

const hex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
const signedAdmissions = createHostAdmission();
/** NIP-98 signed reads for a host that owns a signer (Tauri, NIP-07). Reads and writes use the same identity and relay scope. */
export async function connectSignedTransport(
  signer: Signer,
  httpOrigin: string,
  relayAuthor: string,
): Promise<ReadTransport> {
  const viewer = await signer.getPublicKey();
  httpOrigin = relayOrigin(httpOrigin);
  const principal = () => signedAdmissions(httpOrigin, viewer);
  const profiling = createRelayProfiler();
  return {
    profiling,
    subscribe: (callbacks) => {
      const owner = principal();
      owner.streams++;
      let traffic: LiveSubscription;
      try {
        traffic = subscribeRelayTraffic(
          httpOrigin.replace(/^http/, "ws"),
          (event) => signer.signEvent(event),
          viewer,
          callbacks,
          undefined,
          owner.live,
        );
      } catch (error) {
        owner.streams--;
        throw error;
      }
      let closed = false;
      return {
        ...traffic,
        dispose() {
          if (closed) return;
          closed = true;
          owner.streams--;
          traffic.dispose();
        },
      };
    },
    scope: httpOrigin,
    viewer,
    relayAuthor,
    media: (url) => mediaUrl(url, undefined, httpOrigin),
    writer: {
      sign: (event) => signer.signEvent(event),
      async publish(event, signal) {
        await acceptPublish(
          await signedPost(
            signer,
            `${httpOrigin}/events`,
            event,
            signal,
            profiling,
            event.id,
            principal().api,
          ).catch((error) => {
            if (error instanceof ApiPaused || error instanceof ApiNotSent)
              throw new PublishRejected(error.message);
            throw error;
          }),
          event.id,
        );
      },
    },
    async query(filters, signal, requestId = "read", priority = "foreground") {
      const result = await signedPost(
        signer,
        `${httpOrigin}/query`,
        filters,
        signal,
        profiling,
        requestId,
        principal().api,
        priority,
      );
      if (!result.ok) {
        const failure = await readApiFailure(result);
        throw new ReadError(
          result.status === 401 || result.status === 403
            ? "denied"
            : "unavailable",
          failure.error,
          result.status,
          failure.retryAfterMs,
        );
      }
      recordServerTiming(result, profiling, requestId);
      return profiling.measureAsync("read.verify", requestId, async () =>
        parseEvents(await result.json(), signal),
      );
    },
  };
}

async function signedPost(
  signer: Signer,
  url: string,
  value: unknown,
  signal: AbortSignal | undefined,
  profiling: RelayProfiler,
  id: string,
  admission: Parameters<typeof admittedApiRequest>[0],
  priority: "foreground" | "background" = "foreground",
) {
  signal?.throwIfAborted();
  return admission.prepare(async () => {
    const body = JSON.stringify(value);
    const payload = hex(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
    );
    if (signal?.aborted) throw signal.reason;
    const auth = await profiling.measureAsync("http.auth", id, () =>
      signer.signEvent({
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        content: "",
        tags: [
          ["u", url],
          ["method", "POST"],
          ["payload", payload],
          ["nonce", crypto.randomUUID()],
        ],
      }),
    );
    if (signal?.aborted) throw signal.reason;
    // Preparation retains this principal. Only actual fetch starts consume pacing
    // credit, and admission rechecks any pause learned during asynchronous signing.
    const queued = profiling.start("http.admission", id);
    try {
      return await admittedApiRequest(
        admission,
        () => {
          queued();
          signal?.throwIfAborted();
          if (Math.abs(Math.floor(Date.now() / 1000) - auth.created_at) > 45)
            throw new ApiNotSent(
              "Request authentication expired before dispatch; retry available",
            );
          return profiling.measureAsync("http.fetch", id, () =>
            fetch(url, {
              method: "POST",
              headers: {
                Authorization: `Nostr ${btoa(JSON.stringify(auth))}`,
                "Content-Type": "application/json",
              },
              body,
              signal: signal ?? null,
            }),
          );
        },
        signal,
        priority,
      );
    } finally {
      queued();
    }
  });
}
/** A transport failure is an unknown outcome; only a definitive rejection is a failed write. */
async function acceptPublish(response: Response, id: string) {
  if (!response.ok) {
    if ([400, 401, 403, 404, 413, 422].includes(response.status))
      throw new PublishRejected(
        `Relay rejected the message (${response.status})`,
      );
    // A broker that never reached the relay reports `sent: false`; that message
    // was not delivered and is safe to mark failed and retry.
    const body = await readApiFailure(response);
    if (body.sent === false || body.quota === "api")
      throw new PublishRejected(body.error);
    throw new Error(
      `Relay delivery could not be confirmed (${response.status})`,
    );
  }
  const result = (await response.json()) as {
    accepted?: unknown;
    event_id?: unknown;
    message?: unknown;
  };
  if (result.event_id !== id || typeof result.accepted !== "boolean")
    throw new Error("Relay returned an invalid delivery receipt");
  if (!result.accepted)
    throw new PublishRejected(
      typeof result.message === "string"
        ? result.message
        : "Relay rejected the message",
    );
}

function recordServerTiming(
  response: Response,
  profiling: RelayProfiler,
  id: string,
) {
  for (const entry of (response.headers.get("Server-Timing") ?? "").split(
    ",",
  )) {
    const match = /^\s*([a-z_]+);dur=([\d.]+)/.exec(entry);
    if (!match) continue;
    const duration = Number(match[2]);
    if (Number.isFinite(duration))
      profiling.record({
        stage: `broker.${match[1]}`,
        id,
        start: performance.now() - duration,
        duration,
        outcome: response.ok ? "ok" : "error",
      });
  }
}
