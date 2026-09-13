import { invoke } from "@tauri-apps/api/core";
import { getEventHash } from "nostr-tools";
import type { IdentityStatus } from "../identity/contracts";
import { parseStatus } from "../identity/contracts";
import type { IdentitySnapshot } from "../identity/service";
import { eventDto, type RelayEvent } from "../relay/events";
import { ReadError } from "../relay/errors";
import { createHostAdmission } from "../relay/host-admission";
import { PublishRejected } from "../relay/outbox";
import { byteSize } from "../relay/budget";
import { yieldToHost } from "../relay/yield";
import { mediaUrl, type ReadTransport } from "../relay/transport";
import type { CommunityInfo } from "./api";
import type { CommunityIdentitySource } from "./service";
import { relayOrigin } from "./destination";
import { createSetupProfile } from "./setup-profile";

type Scope = Readonly<{
  origin: string;
  expectedPubkey: string;
  generation: string;
  revocation: string;
}>;
type Command =
  | "community_discover"
  | "community_query"
  | "community_sign_message"
  | "community_sign_profile"
  | "community_publish"
  | "community_accept_policy"
  | "community_claim";
type Invoke = (
  command: Command,
  args: { request: Record<string, unknown> },
) => Promise<unknown>;
const codes = [
  "invalidInput",
  "cancelled",
  "busy",
  "denied",
  "unavailable",
  "invalidResponse",
  "rejected",
  "rateLimited",
  "policyRequired",
  "policyChanged",
  "inviteInvalid",
  "inviteExpired",
  "inviteExhausted",
] as const;
type Code = (typeof codes)[number];
type Outcome = "notSent" | "rejected" | "unknown";
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const messages: Record<Code, string> = {
  invalidInput: "Community request is invalid.",
  cancelled: "Account changed; reopen community setup.",
  busy: "Native community requests are busy; retry later.",
  denied: "Community access was denied.",
  unavailable: "Community response could not be confirmed.",
  invalidResponse: "Community returned an invalid response.",
  rejected: "Community rejected this request.",
  rateLimited: "Community requests are paused by the relay quota; retry later.",
  policyRequired: "This community requires policy acceptance.",
  policyChanged: "Community policy changed; reopen setup to review it.",
  inviteInvalid: "The invite could not be accepted.",
  inviteExpired: "The invite or policy receipt expired.",
  inviteExhausted: "The invite has no uses remaining.",
};
export class CommunityError extends ReadError {
  constructor(
    readonly code: Code,
    readonly outcome?: Outcome,
    status?: number,
    retry?: number,
  ) {
    super(
      code === "cancelled"
        ? "cancelled"
        : code === "denied"
          ? "denied"
          : code === "invalidResponse"
            ? "invalid-response"
            : "unavailable",
      `${messages[code]}${outcome === "unknown" ? " The earlier write may have completed; do not create a replacement automatically." : ""}`,
      status,
      retry,
    );
  }
}
function failure(raw: unknown, write: boolean): CommunityError {
  const value = record(raw);
  const code = codes.includes(value.code as Code)
    ? (value.code as Code)
    : "unavailable";
  const outcome = ["notSent", "rejected", "unknown"].includes(
    value.outcome as string,
  )
    ? (value.outcome as Outcome)
    : write
      ? "unknown"
      : undefined;
  const status =
    typeof value.httpStatus === "number" &&
    Number.isInteger(value.httpStatus) &&
    value.httpStatus >= 100 &&
    value.httpStatus <= 599
      ? value.httpStatus
      : undefined;
  const retry =
    code === "rateLimited" &&
    status === 429 &&
    typeof value.retryAfterMs === "number" &&
    Number.isInteger(value.retryAfterMs) &&
    value.retryAfterMs >= 0 &&
    value.retryAfterMs <= 86401000
      ? value.retryAfterMs
      : undefined;
  return new CommunityError(code, outcome, status, retry);
}
function discovery(raw: unknown, viewer: string) {
  const value = record(raw);
  const key = (input: unknown) =>
    typeof input === "string" && /^[0-9a-f]{64}$/.test(input);
  if (
    value.viewer !== viewer ||
    !key(value.relayAuthor) ||
    (value.archiveAuthority !== undefined &&
      (!key(value.archiveAuthority) ||
        value.archiveAuthority !== value.relayAuthor)) ||
    (value.name !== undefined &&
      (typeof value.name !== "string" || value.name.length > 4096)) ||
    (value.icon !== undefined &&
      (typeof value.icon !== "string" || value.icon.length > 2048)) ||
    byteSize(raw) > 1024 * 1024
  )
    throw new CommunityError("invalidResponse");
  const policy = record(value.policy);
  if (
    value.policy !== null &&
    (typeof policy.version !== "string" ||
      !policy.version ||
      policy.version.length > 1024 ||
      typeof policy.age_attestation_required !== "boolean" ||
      [policy.terms_markdown, policy.privacy_markdown].some(
        (text) => text !== undefined && typeof text !== "string",
      ))
  )
    throw new CommunityError("invalidResponse");
  return {
    viewer,
    relayAuthor: value.relayAuthor as string,
    ...(value.archiveAuthority
      ? { archiveAuthority: value.archiveAuthority as string }
      : {}),
    ...(value.name ? { name: value.name as string } : {}),
    ...(value.icon ? { icon: value.icon as string } : {}),
    policy:
      value.policy === null
        ? null
        : {
            version: policy.version as string,
            age_attestation_required:
              policy.age_attestation_required as boolean,
            ...(policy.terms_markdown !== undefined
              ? { terms_markdown: policy.terms_markdown as string }
              : {}),
            ...(policy.privacy_markdown !== undefined
              ? { privacy_markdown: policy.privacy_markdown as string }
              : {}),
          },
  };
}

/** Native host only. No broker fallback, generic fetch or renderer-owned key. */
export function createNativeCommunities(
  identity: {
    snapshot(): IdentitySnapshot;
    subscribe(listener: () => void): () => void;
  },
  call: Invoke = invoke,
): CommunityIdentitySource {
  const admission = createHostAdmission();
  // A timed-out invoke may retain callbacks. Bound unresolved invocations, without
  // pretending JS abort cancelled native IO or that a later timer reclaimed it.
  let outstanding = 0;
  function bind(
    status: IdentityStatus,
    destination: string,
    lifetime: AbortSignal,
  ) {
    const authority = parseStatus(status);
    if (authority.state !== "ready" || !authority.pubkey)
      throw new CommunityError("cancelled", "notSent");
    const scope: Scope = Object.freeze({
      origin: relayOrigin(destination),
      expectedPubkey: authority.pubkey,
      generation: authority.generation,
      revocation: authority.revocation,
    });
    const check = () => {
      const current = identity.snapshot().identity;
      if (
        lifetime.aborted ||
        current?.state !== "ready" ||
        current.pubkey !== scope.expectedPubkey ||
        current.generation !== scope.generation ||
        current.revocation !== scope.revocation
      )
        throw new CommunityError("cancelled", "notSent");
    };
    async function request(
      command: Command,
      fields: Record<string, unknown> = {},
      signal?: AbortSignal,
      priority: "foreground" | "background" = "foreground",
    ) {
      const write = [
        "community_publish",
        "community_accept_policy",
        "community_claim",
      ].includes(command);
      const network = !command.startsWith("community_sign_");
      let entered = false;
      const combined = AbortSignal.any([
        lifetime,
        AbortSignal.timeout(25000),
        ...(signal ? [signal] : []),
      ]);
      const lane = admission(scope.origin, scope.expectedPubkey).api;
      // Own serialized purpose bytes before admission; caller mutation cannot alter a queued request.
      const request = JSON.parse(
        JSON.stringify({ ...fields, scope }),
      ) as Record<string, unknown>;
      const dispatch = async () => {
        check();
        combined.throwIfAborted();
        if (outstanding >= 6) throw new CommunityError("busy", "notSent");
        outstanding++;
        entered = true;
        try {
          let raw: unknown;
          try {
            raw = await call(command, { request });
          } catch (error) {
            const parsed = failure(error, write);
            if (
              parsed.code === "rateLimited" &&
              parsed.retryAfterMs !== undefined
            )
              lane.pause(parsed.retryAfterMs);
            throw parsed;
          }
          try {
            check();
          } catch {
            throw new CommunityError(
              "cancelled",
              write ? "unknown" : undefined,
            );
          }
          const reply = record(raw),
            returned = record(reply.scope);
          if (
            Object.keys(reply).length !== 2 ||
            Object.keys(returned).length !== 4 ||
            Object.entries(scope).some(
              ([key, value]) => returned[key] !== value,
            )
          )
            throw new CommunityError(
              "invalidResponse",
              write ? "unknown" : undefined,
            );
          return reply.value;
        } finally {
          outstanding--;
        }
      };
      return new Promise<unknown>((resolve, reject) => {
        const abort = () =>
          reject(
            new CommunityError(
              lifetime.aborted ? "cancelled" : "unavailable",
              write ? (entered ? "unknown" : "notSent") : undefined,
            ),
          );
        combined.addEventListener("abort", abort, { once: true });
        if (combined.aborted) {
          abort();
          combined.removeEventListener("abort", abort);
          return;
        }
        const work = network
          ? lane.run(dispatch, combined, priority)
          : dispatch();
        void work
          .then(resolve, (error: unknown) =>
            reject(
              error instanceof CommunityError
                ? error
                : new CommunityError(
                    "unavailable",
                    write ? (entered ? "unknown" : "notSent") : undefined,
                  ),
            ),
          )
          .finally(() => combined.removeEventListener("abort", abort));
      });
    }
    return { scope, check, request };
  }
  return {
    snapshot: () => identity.snapshot().identity,
    subscribe: (listener) => identity.subscribe(listener),
    async connect(status, destination, lifetime): Promise<ReadTransport> {
      const { scope, request } = bind(status, destination, lifetime);
      const info = discovery(
        await request("community_discover"),
        scope.expectedPubkey,
      );
      return {
        viewer: scope.expectedPubkey,
        scope: scope.origin,
        relayAuthor: info.relayAuthor,
        ...(info.archiveAuthority
          ? { archiveAuthority: info.archiveAuthority }
          : {}),
        media: (url) => mediaUrl(url, undefined, scope.origin),
        async query(filters, signal, _id, priority) {
          const raw = await request(
            "community_query",
            { filters },
            signal,
            priority,
          );
          if (!Array.isArray(raw) || byteSize(raw) > 8 * 1024 * 1024)
            throw new CommunityError("invalidResponse");
          const events: RelayEvent[] = [];
          try {
            for (let offset = 0; offset < raw.length; offset += 12) {
              signal?.throwIfAborted();
              lifetime.throwIfAborted();
              events.push(...raw.slice(offset, offset + 12).map(eventDto));
              if (offset + 12 < raw.length) await yieldToHost();
            }
          } catch {
            throw new CommunityError("invalidResponse");
          }
          signal?.throwIfAborted();
          lifetime.throwIfAborted();
          return events;
        },
        writer: {
          kinds: [0, 9],
          async sign(input, signal) {
            if (![0, 9].includes(input.kind))
              throw new CommunityError("invalidInput", "notSent");
            const template = {
              kind: input.kind,
              created_at: input.created_at,
              content: input.content,
              tags: input.tags.map((tag) => [...tag]),
            };
            const expected = getEventHash({
              ...template,
              pubkey: scope.expectedPubkey,
            });
            let event: RelayEvent;
            try {
              event = eventDto(
                await request(
                  input.kind === 0
                    ? "community_sign_profile"
                    : "community_sign_message",
                  { template },
                  signal,
                ),
              );
            } catch (error) {
              throw error instanceof CommunityError
                ? error
                : new CommunityError("invalidResponse", "notSent");
            }
            if (event.id !== expected || event.pubkey !== scope.expectedPubkey)
              throw new CommunityError("invalidResponse", "notSent");
            return event;
          },
          async publish(input, signal) {
            let event: RelayEvent;
            try {
              event = eventDto(input);
            } catch {
              throw new PublishRejected("Invalid outgoing event");
            }
            if (
              event.pubkey !== scope.expectedPubkey ||
              ![0, 9].includes(event.kind)
            )
              throw new PublishRejected(
                "Outgoing event is outside this account's purpose",
              );
            try {
              const receipt = record(
                await request("community_publish", { event }, signal),
              );
              if (
                receipt.event_id !== event.id ||
                typeof receipt.accepted !== "boolean" ||
                typeof receipt.duplicate !== "boolean"
              )
                throw new CommunityError("invalidResponse", "unknown");
              if (!receipt.accepted)
                throw new PublishRejected("Community rejected this event");
            } catch (error) {
              if (
                error instanceof CommunityError &&
                error.outcome !== "unknown" &&
                error.outcome !== undefined
              )
                throw new PublishRejected(error.message);
              throw error;
            }
          },
        },
      };
    },
    setup(status, destination, account, session) {
      const { request, scope } = bind(status, destination, account.signal);
      const profiles = createSetupProfile(session, account);
      return {
        ...profiles,
        async info(): Promise<CommunityInfo> {
          return discovery(
            await request("community_discover"),
            scope.expectedPubkey,
          );
        },
        async acceptPolicy(input) {
          const value = record(await request("community_accept_policy", input));
          if (
            typeof value.receipt !== "string" ||
            !value.receipt ||
            value.receipt.length > 2048
          )
            throw new CommunityError("invalidResponse", "unknown");
          return { receipt: value.receipt };
        },
        async claim(input) {
          const value = record(await request("community_claim", input));
          if (
            !["joined", "already_member"].includes(value.status as string) ||
            value.host !== new URL(scope.origin).host ||
            typeof value.community_id !== "string" ||
            !value.community_id ||
            value.community_id.length > 256 ||
            typeof value.role !== "string" ||
            value.role.length > 128
          )
            throw new CommunityError("invalidResponse", "unknown");
          return { status: value.status as string };
        },
      };
    },
  };
}
