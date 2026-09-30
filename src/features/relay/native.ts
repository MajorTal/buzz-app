import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { EventTemplate } from "nostr-tools";
import { communityDestination, relayOrigin } from "../communities/destination";
import { eventDto, type RelayEvent } from "./events";
import {
  coordinate,
  KIT_TAG,
  parseKitRecord,
  type KitRecord,
} from "../channel-templates/model";
import type { RelayWriter } from "./transport";
import { validateLifecycleTemplate } from "./channel-lifecycle-protocol";
import { validateDetailsTemplate } from "./channel-details-protocol";
import { validateArchiveRequestTemplate } from "./identity-archive-protocol";
import { workflowHost, workflowRunsPath } from "../workflows/http";
import { WORKFLOW_KINDS } from "../workflows/protocol";

import { PublishRejected } from "./outbox";

import { readCoordinate, parseReadBlob } from "./read-state-model";
import type { ReadStateSigning } from "./read-state-host";
import {
  readSnapshotCommunity,
  readSnapshotFilter,
  parseReadSnapshot,
  readSnapshotText,
} from "./read-state-snapshot";
import {
  memoryAgent,
  memoryListing,
  type MemoryListing,
} from "../agents/memory";
import type { AgentLibrary } from "../agents/library";
import { observerFrame } from "../agents/observer";
import {
  acceptPublish,
  admitSignedRequest,
  connectSignedTransport,
  admittedSignedWorkflowRead,
  type ReadTransport,
  type Signer,
} from "./transport";
import { nativeSidebar } from "./native-sidebar";
import { readApiFailure } from "./http-admission";

async function nativeReadInvoke<T>(
  command: string,
  args: Record<string, unknown>,
) {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    // Tauri commands reject with a string; domain health expects an Error.
    throw typeof error === "string" ? new Error(error) : error;
  }
}

export const nativeWriteKinds = [
  30078,
  7,
  9,
  1984,
  9000,
  9001,
  30030,
  30315,
  40003,
  40100,
  42000,
  ...WORKFLOW_KINDS,
] as const;

/** Cancellation fences JS results; a dispatched native write may still complete. */
export async function nativeRelayRequest(
  community: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const bounded = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(30_000),
  ]);
  bounded.throwIfAborted();
  const result = await invoke<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }>("relay_http", {
    community: communityDestination(community).url,
    path,
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? null : JSON.stringify(body),
  });
  // IPC cannot abort reqwest. Retain the shared admission slot until native work
  // settles (bounded by its timeout), then reject any obsolete result.
  bounded.throwIfAborted();
  return nativeResponse(result);
}

function nativeResponse(result: {
  status: number;
  headers: Record<string, string>;
  body: string;
}): Response {
  return new Response(
    [204, 205, 304].includes(result.status) ? null : result.body,
    { status: result.status, headers: result.headers },
  );
}

/** Relay media through the native `buzz-media` scheme (`src-tauri/src/relay.rs`),
 * which signs each Blossom `get`, including every `Range` request. */
export function nativeMediaUrl(url: string): string {
  return convertFileSrc(url, "buzz-media");
}

/** Raw IPC bytes; native code hashes, signs and sends them to `PUT /upload`.
 * Aborting settles at once and tells native code to drop the request. */
async function nativeUpload(origin: string, file: File, signal: AbortSignal) {
  const bytes = await file.arrayBuffer();
  signal.throwIfAborted();
  const id = crypto.randomUUID();
  let abort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    abort = () => {
      invoke("relay_upload_cancel", { id }).catch(() => {});
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    const result = await Promise.race([
      invoke<{
        status: number;
        headers: Record<string, string>;
        body: string;
      }>("relay_upload", bytes, {
        headers: {
          "x-buzz-upload-id": id,
          "x-buzz-community": origin,
          "x-buzz-content-type": file.type || "application/octet-stream",
        },
      }),
      aborted,
    ]);
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    });
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export function nativeRelaySigner(community: string): Signer {
  const origin = communityDestination(community).url;
  return {
    async getPublicKey() {
      const viewer = await invoke<string | null>("identity_restore");
      if (!viewer || !/^[a-f0-9]{64}$/.test(viewer))
        throw new Error("Set up your identity first");
      return viewer;
    },
    async signEvent(event: EventTemplate) {
      const { kind, created_at, tags, content } = event;
      return eventDto(
        await invoke(kind === 30078 ? "relay_kit_sign" : "relay_sign", {
          community: origin,
          event: { kind, created_at, tags, content },
        }),
      );
    },
    request(url, body, signal) {
      const target = new URL(url);
      if (target.origin !== origin || target.search || target.hash)
        throw new Error("Relay request changed community");
      return nativeRelayRequest(
        origin,
        target.pathname,
        JSON.parse(body),
        signal,
      );
    },
    upload: (file, signal) => nativeUpload(origin, file, signal),
    media: nativeMediaUrl,
  };
}

export async function nativeRelayInfo(community: string, signal?: AbortSignal) {
  const response = await nativeRelayRequest(community, "/", undefined, signal);
  if (!response.ok) throw new Error("Community discovery failed");
  const info: unknown = await response.json();
  if (!info || typeof info !== "object" || Array.isArray(info))
    throw new Error("Invalid community information");
  return info as Record<string, unknown>;
}

export async function connectNativeTransport(
  community: string,
  signal?: AbortSignal,
): Promise<ReadTransport> {
  const origin = communityDestination(community).url;
  const info = await nativeRelayInfo(origin, signal);
  const author = info.self;
  if (typeof author !== "string" || !/^[a-f0-9]{64}$/.test(author))
    throw new Error("Relay did not advertise its identity");
  const creation =
    Array.isArray(info.supported_nips) && info.supported_nips.includes(29);
  const transport = await connectSignedTransport(
    nativeRelaySigner(origin),
    origin,
    author,
  );
  signal?.throwIfAborted();
  const writer = transport.writer;
  const readCommunity = readSnapshotCommunity(info.read_state_snapshot);
  if (!writer) throw new Error("Native relay writer is unavailable");
  const commandWriter = (
    route: "channel-details" | "channel-lifecycle" | "identity-archive",
    validate: (event: EventTemplate) => void,
  ): RelayWriter => ({
    async sign(event, signal) {
      signal.throwIfAborted();
      validate(event);
      const result = eventDto(
        await invoke("relay_channel_sign", {
          community: origin,
          route,
          event,
        }),
      );
      signal.throwIfAborted();
      validate(result);
      if (result.pubkey !== transport.viewer)
        throw new Error("Invalid channel lifecycle command");
      return result;
    },
    async publish(event, signal) {
      signal.throwIfAborted();
      validate(event);
      if (event.pubkey !== transport.viewer)
        throw new Error("Invalid channel lifecycle command");
      const result = await invoke<{
        status: number;
        headers: Record<string, string>;
        body: string;
      }>("relay_channel_publish", { community: origin, route, event });
      signal.throwIfAborted();
      return acceptPublish(
        new Response(result.body, {
          status: result.status,
          headers: result.headers,
        }),
        event.id,
      );
    },
  });
  // Capabilities describe implemented host operations, not everything this key can sign.
  return {
    ...transport,
    workflows: workflowHost(async (route, body, signal) => {
      if (route !== "workflow-runs") throw new Error("Invalid workflow read");
      workflowRunsPath(body);
      signal.throwIfAborted();
      const response = await admittedSignedWorkflowRead(
        origin,
        transport.viewer,
        async () => {
          const result = await invoke<{
            status: number;
            headers: Record<string, string>;
            body: string;
          }>("relay_workflow_runs", {
            community: origin,
            id: (body as { id: string }).id,
            cursor:
              (body as { cursor?: { before: string; beforeId: string } })
                .cursor ?? null,
          });
          return nativeResponse(result);
        },
        signal,
      );
      signal.throwIfAborted();
      return response;
    }),
    archiveAuthority: author,
    channelLifecycle: commandWriter(
      "channel-lifecycle",
      validateLifecycleTemplate,
    ),
    channelDetails: commandWriter("channel-details", validateDetailsTemplate),
    identityArchive: commandWriter(
      "identity-archive",
      validateArchiveRequestTemplate,
    ),
    async openDirectMessage(pubkeys, signal) {
      signal.throwIfAborted();
      const id = await invoke<string>("relay_direct_message", {
        community: origin,
        pubkeys,
      });
      signal.throwIfAborted();
      if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id))
        throw new Error("The relay returned an invalid direct message.");
      return id;
    },
    channelKit: {
      async prepare(record: KitRecord, signal) {
        signal.throwIfAborted();
        const valid = parseKitRecord(record, origin);
        const content = await invoke<string>("relay_kit_prepare", {
          community: origin,
          record: valid,
        });
        signal.throwIfAborted();
        if (typeof content !== "string" || content.length > 24 * 1024)
          throw new Error("Invalid encrypted recipe");
        return content;
      },
      async decode(events: readonly RelayEvent[], signal) {
        signal.throwIfAborted();
        if (events.length > 16)
          throw new Error("Recipe decode capacity exceeded");
        const owned = events.map(eventDto);
        const decoded = await invoke<{ eventId: string; record: KitRecord }[]>(
          "relay_kit_decode",
          {
            community: origin,
            events: owned,
          },
        );
        signal.throwIfAborted();
        if (!Array.isArray(decoded) || decoded.length !== owned.length)
          throw new Error("Incomplete private recipe decode");
        return decoded.map((row, index) => {
          const event = owned[index];
          if (
            !event ||
            row.eventId !== event.id ||
            event.pubkey !== transport.viewer ||
            event.kind !== 30078 ||
            event.tags.filter(([key]) => key === "d").length !== 1 ||
            event.tags.filter(([key]) => key === "t").length !== 1 ||
            event.tags.some(
              ([key]) => !["d", "t", "client-id"].includes(key ?? ""),
            )
          )
            throw new Error("Recipe decode mismatch");
          const record = parseKitRecord(row.record, origin);
          if (
            !event.tags.some(
              ([key, value]) => key === "d" && value === coordinate(record),
            ) ||
            !event.tags.some(([key, value]) => key === "t" && value === KIT_TAG)
          )
            throw new Error("Recipe decode mismatch");
          return { eventId: row.eventId, record };
        });
      },
    },

    agentActivity: true,
    subscribe(callbacks) {
      let active = true;
      let observerGeneration: number | null = null;
      let observerEpoch = 0;
      let listening = false;
      const traffic = transport.subscribe?.({
        ...callbacks,
        state(snapshot) {
          const route = snapshot.routes.find((item) => item.id === "observer");
          const next =
            snapshot.status === "connected" && route?.status === "live";
          if (listening && !next) observerEpoch++;
          listening = next;
          callbacks.state(snapshot);
        },
        telemetry(event, generation) {
          if (generation !== observerGeneration || !listening) return;
          const epoch = observerEpoch;
          void invoke("relay_agent_observer", { community: origin, event })
            .then((value) => {
              if (
                active &&
                listening &&
                observerEpoch === epoch &&
                observerGeneration === generation
              )
                callbacks.observer?.(observerFrame(value), generation);
            })
            .catch(() => {
              /* Invalid encrypted telemetry is not chat traffic. */
            });
        },
      });
      if (!traffic) throw new Error("Native relay stream is unavailable");
      return {
        ...traffic,
        observe(generation) {
          observerEpoch++;
          observerGeneration = generation;
          traffic.observe?.(generation);
        },
        dispose() {
          active = false;
          observerEpoch++;
          traffic.dispose();
        },
      };
    },
    async readAgentLibrary(signal) {
      signal.throwIfAborted();
      const result = await invoke<AgentLibrary>("relay_agent_library");
      signal.throwIfAborted();
      return result;
    },
    async readAgentMemories(
      agent: string,
      signal: AbortSignal,
    ): Promise<MemoryListing> {
      if (!memoryAgent(agent, transport.viewer))
        throw new Error("Invalid memory target");
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
      bounded.throwIfAborted();
      let result: unknown;
      try {
        result = await invoke<unknown>("relay_agent_memories_read", {
          community: origin,
          agent,
        });
      } catch (reason) {
        if (reason === "MemoryDenied") {
          const denied = new Error("Memory read failed");
          denied.name = "MemoryDenied";
          throw denied;
        }
        throw reason;
      }
      bounded.throwIfAborted();
      return memoryListing(result);
    },
    async authorizeAgentLog(target, nonce) {
      if (relayOrigin(target.relayUrl) !== origin)
        throw new Error("Log authorization unavailable");
      const signature = await invoke<string>("relay_agent_log_proof", {
        community: origin,
        target: { ...target, nonce },
      });
      if (!/^[0-9a-f]{128}$/.test(signature))
        throw new Error("Log authorization unavailable");
      return signature;
    },
    ...nativeSidebar(transport),
    readState: {
      ...(readCommunity ? { communityId: readCommunity } : {}),
      async decode(events: readonly RelayEvent[], signal: AbortSignal) {
        signal.throwIfAborted();
        const decoded = await nativeReadInvoke<
          { eventId: string; blob: unknown }[]
        >("relay_decode_read_state", {
          community: origin,
          events,
        });
        signal.throwIfAborted();
        for (const item of decoded) parseReadBlob(item.blob);
        return decoded;
      },
      async sign(intent: ReadStateSigning, signal: AbortSignal) {
        signal.throwIfAborted();
        parseReadBlob(intent.blob);
        const event = eventDto(
          await nativeReadInvoke("relay_sign_read_state", {
            community: origin,
            intent,
          }),
        );
        signal.throwIfAborted();
        if (event.pubkey !== transport.viewer || !readCoordinate(event))
          throw new Error("Invalid read-state event");
        return event;
      },
      async publish(event: RelayEvent, signal: AbortSignal) {
        signal.throwIfAborted();
        if (event.pubkey !== transport.viewer || !readCoordinate(event))
          throw new Error("Invalid read-state event");
        const response = await admitSignedRequest(
          origin,
          transport.viewer,
          async () => {
            // Tauri IPC cannot abort the underlying request. Keep admission until
            // it settles even if the caller no longer needs the receipt.
            const result = await nativeReadInvoke<{
              status: number;
              headers: Record<string, string>;
              body: string;
            }>("relay_publish_read_state", { community: origin, event });
            return nativeResponse(result);
          },
          signal,
        );
        signal.throwIfAborted();
        await acceptPublish(response, event.id);
      },
    },
    ...(readCommunity
      ? {
          async readStateSnapshot(signal: AbortSignal, _requestId, priority) {
            const response = await admitSignedRequest(
              origin,
              transport.viewer,
              () =>
                nativeRelayRequest(
                  origin,
                  "/query",
                  readSnapshotFilter(transport.viewer),
                ),
              signal,
              priority,
            );
            signal.throwIfAborted();
            if (!response.ok)
              throw new Error((await readApiFailure(response)).error);
            return parseReadSnapshot(
              JSON.parse(await readSnapshotText(response)),
              transport.viewer,
              readCommunity,
              signal,
            );
          },
        }
      : {}),
    async channelActivity(channelIds, signal) {
      if (
        channelIds.length < 1 ||
        channelIds.length > 128 ||
        channelIds.some((id) => !/^[a-zA-Z0-9_-]{1,128}$/.test(id))
      )
        throw new Error("Activity filter rejected");
      return transport.query(
        channelIds.map((channelId) => ({
          kinds: [9, 40002, 40008, 45001, 45003],
          "#h": [channelId],
          limit: 1,
        })),
        signal,
        "channel-activity",
        "background",
      );
    },
    writer: {
      ...writer,
      kinds: creation ? [...nativeWriteKinds, 9007] : nativeWriteKinds,
      async publish(event, signal) {
        // The relay rejects old events before deduplication. An explicit retry
        // can confirm the original ID, but must never silently re-date it.
        if (event.created_at < Math.floor(Date.now() / 1000) - 15 * 60) {
          const found = await transport.query(
            [
              {
                kinds: [event.kind],
                ids: [event.id],
                authors: [event.pubkey],
                limit: 1,
                consistency: "strong",
              },
            ],
            signal,
          );
          if (found.some((value) => value.id === event.id)) return "";
          throw new PublishRejected(
            "This event is too old to retry and was not found on the relay. Check the conversation before sending it again.",
          );
        }
        return (await writer.publish(event, signal)) ?? "";
      },
    },
  };
}
