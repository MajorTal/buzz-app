import { expect, it } from "vitest";
import { knownAgentPubkeys } from "./known";

it("combines exact local-library identities with self-authored agent profiles", () => {
  const profiles = new Map([
    ["relay-agent", { name: "Relay", isAgent: true as const }],
    ["person", { name: "Person" }],
  ]);
  const keys = knownAgentPubkeys(profiles, {
    definitions: [],
    identities: [{ pubkey: "local-agent", name: "Local" }],
  });
  expect([...keys]).toEqual(["relay-agent", "local-agent"]);
});
