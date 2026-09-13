import type { AgentLibrary } from "./library";
import type { Profile } from "../relay/contracts";

/** Exact identity keys from authenticated profile metadata plus the local Buzz library. */
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
