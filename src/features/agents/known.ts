import type { AgentLibrary } from "./library";
import type { Profile } from "../relay/contracts";

/** Exact keys from self-declared profile hints plus the local Buzz library.
 * Display-only evidence, not proof of ownership, membership or authority. */
export function knownAgentPubkeys(
  profiles: ReadonlyMap<string, Profile>,
  library?: AgentLibrary,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const [pubkey, profile] of profiles) {
    if (profile.isAgent) keys.add(pubkey);
  }
  for (const identity of library?.identities ?? []) keys.add(identity.pubkey);
  return keys;
}
