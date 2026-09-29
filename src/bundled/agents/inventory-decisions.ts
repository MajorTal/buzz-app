import { relayOrigin } from "../../features/communities/destination";
import type { AgentInventoryIdentity } from "./inventory-model";

export const localHereGroup = "Local agents in this community";
export const localOtherGroup = "Local agents in other communities";
export const importGroup = "Available to import";
export const relayGroup = "Relay-only agents";
export const inventoryGroups = [
  localHereGroup,
  localOtherGroup,
  importGroup,
  relayGroup,
];

/** One identity, first matching section. Association alone is not local custody. */
export function inventoryDecision(
  row: AgentInventoryIdentity,
  destination: string,
) {
  const configuredHere = row.localSetups.has(destination);
  const localHere =
    configuredHere ||
    row.unconfiguredSetups.some(
      (agent) => agent.relayUrl && relayOrigin(agent.relayUrl) === destination,
    );
  const group = row.localIdentity
    ? destination && localHere
      ? localHereGroup
      : localOtherGroup
    : row.oldBuzzSources.length
      ? importGroup
      : relayGroup;
  return { group };
}
