import {
  connectBrokerTransport,
  registerBrokerCommunity,
} from "../relay/transport";
import type { CommunityAccount, PersonalProfile } from "./service";
export type CommunityInfo = {
  name?: string;
  icon?: string;
  policy: {
    version: string;
    terms_markdown?: string;
    privacy_markdown?: string;
    age_attestation_required: boolean;
  } | null;
};
export async function communityRequest<T>(
  id: string,
  route: string,
  body: unknown,
  account: CommunityAccount,
): Promise<T> {
  const signal = AbortSignal.any([account.signal, AbortSignal.timeout(25000)]);
  signal.throwIfAborted();
  const response = await fetch(
    `/api/relay/${encodeURIComponent(id)}/${route}`,
    {
      ...(body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
      signal,
    },
  );
  const result = await response.json();
  signal.throwIfAborted();
  if (!response.ok)
    throw new Error(
      result.error ?? `Community request failed (${response.status})`,
    );
  return result as T;
}
export async function inspectProfile(id: string, account: CommunityAccount) {
  const signal = AbortSignal.any([account.signal, AbortSignal.timeout(12000)]);
  signal.throwIfAborted();
  const transport = await connectBrokerTransport("", signal, id);
  signal.throwIfAborted();
  if (transport.viewer !== account.viewer)
    throw new Error("Relay identity did not match the captured account");
  const events = await transport.query(
    [{ kinds: [0], authors: [transport.viewer], limit: 5 }],
    signal,
  );
  signal.throwIfAborted();
  const event = events
    .filter((e) => e.kind === 0 && e.pubkey === transport.viewer)
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
  const parsed: unknown = event ? JSON.parse(event.content) : {};
  const existing: Record<string, unknown> =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const profile: PersonalProfile = {
    name: String(existing.display_name ?? existing.name ?? ""),
    picture: typeof existing.picture === "string" ? existing.picture : "",
  };
  return { existing, profile, exists: !!event };
}
export async function publishProfile(
  id: string,
  profile: PersonalProfile,
  existing: Record<string, unknown>,
  account: CommunityAccount,
) {
  const receipt = await communityRequest<{
    accepted: boolean;
    event_id: string;
    message?: string;
  }>(id, "profile", { ...profile, existing }, account);
  if (!receipt.accepted || !receipt.event_id)
    throw new Error(receipt.message ?? "Profile publication was not confirmed");
}

/** Captured host operations: no arbitrary route, destination change or signer. */
export interface CommunitySetup {
  info(): Promise<CommunityInfo>;
  inspectProfile(): Promise<
    Awaited<ReturnType<typeof inspectProfile>> & {
      notice?: string;
      pending?: boolean;
    }
  >;
  acceptPolicy(input: {
    code: string;
    policy_version: string;
    age_confirmed: boolean;
  }): Promise<{ receipt: string }>;
  claim(input: {
    code: string;
    policy_receipt?: string | undefined;
  }): Promise<{ status: string }>;
  publishProfile(
    profile: PersonalProfile,
    existing: Record<string, unknown>,
  ): Promise<void>;
}

export function createBrokerCommunitySetup(
  id: string,
  account: CommunityAccount,
): CommunitySetup {
  return {
    async info() {
      const signal = AbortSignal.any([
        account.signal,
        AbortSignal.timeout(12000),
      ]);
      signal.throwIfAborted();
      await registerBrokerCommunity(id, signal);
      signal.throwIfAborted();
      return communityRequest<CommunityInfo>(id, "info", undefined, account);
    },
    inspectProfile: () => inspectProfile(id, account),
    acceptPolicy: (input) =>
      communityRequest(id, "accept-policy", input, account),
    claim: (input) => communityRequest(id, "claim", input, account),
    publishProfile: (profile, existing) =>
      publishProfile(id, profile, existing, account),
  };
}
