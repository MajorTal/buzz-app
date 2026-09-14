import { expect, it, vi } from "vitest";
import { Children, isValidElement, type ReactElement } from "react";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import { AgentsPage } from "./AgentsPage";
vi.mock("../../features/relay/react", async (original) => ({
  ...(await original<typeof import("../../features/relay/react")>()),
  useRelayConnection: (relay: RelayData) => relay.snapshot(),
}));
function records(scope: string, generation: number) {
  const snapshot = { status: "ready", scope, generation } as RelaySnapshot;
  const page = AgentsPage({ relay: { snapshot: () => snapshot } as RelayData });
  const surface = Children.only(page.props.children);
  if (!isValidElement<{ children: ReactElement }>(surface))
    throw new Error("Missing Agents surface");
  const content = Children.only(surface.props.children);
  if (!isValidElement<{ children: ReactElement[] }>(content))
    throw new Error("Missing Agents content");
  const records = Children.toArray(content.props.children)[1];
  if (!isValidElement(records)) throw new Error("Missing Agents records");
  return records;
}
it("the actual records subtree distinguishes equal-generation communities and replacement sessions", () => {
  expect(records("A", 1).key).not.toBe(records("B", 1).key);
  expect(records("A", 1).key).not.toBe(records("A", 2).key);
  expect(records("A", 1).key).toBe(records("A", 1).key);
});
