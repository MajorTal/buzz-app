import { useMemo, useSyncExternalStore } from "react";
import type { Profile } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { knownAgentPubkeys } from "./known";

/** One display-only projection per owning surface; exact keys, never display names.
 * Subscribes to existing evidence without initiating library reads. */
export function useKnownAgentPubkeys(
  session: RelaySession,
  profiles: ReadonlyMap<string, Profile>,
): ReadonlySet<string> {
  const library = useSyncExternalStore(
    session.agentLibrary.subscribe,
    session.agentLibrary.snapshot,
    session.agentLibrary.snapshot,
  );
  return useMemo(
    () => knownAgentPubkeys(profiles, library),
    [profiles, library],
  );
}
