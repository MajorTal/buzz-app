import { useEffect, useSyncExternalStore } from "react";
import type { RelaySession } from "../../features/relay/session";
import type { AgentLibrarySnapshot } from "../../features/agents/library";
const empty: AgentLibrarySnapshot = {
  status: "unavailable",
  definitions: [],
  identities: [],
};
const snapshot = () => empty;
const subscribe = () => () => {};
/** Display candidates only; adding access is owned by session submission. */
export function useAgentChoices(session: RelaySession, enabled = false) {
  const library = enabled ? session.agentLibrary : undefined;
  const agents = useSyncExternalStore(
    library?.subscribe ?? subscribe,
    library?.snapshot ?? snapshot,
    library?.snapshot ?? snapshot,
  );
  useEffect(() => {
    if (agents.status === "idle") void library?.refresh();
  }, [library, agents.status]);
  return agents;
}
