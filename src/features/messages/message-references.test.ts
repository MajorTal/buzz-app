import { expect, it } from "vitest";
import { messageReferences } from "./message-references";
import { channelLinkLabel } from "./ReferenceText";

const person = "a".repeat(64);
const agent = "b".repeat(64);
const profiles = new Map([
  [person, { name: "Alex Chen" }],
  [agent, { name: "Build Bot" }],
]);
const channels = [{ id: "design", name: "design" }];
const agents = [{ pubkey: agent, name: "Build Bot" }];
it("styles channels and only explicitly mentioned people and agents, including names with spaces", () => {
  const refs = messageReferences(
    "Ask @Alex Chen and @Build Bot in #design.",
    [person, agent],
    profiles,
    channels,
    agents,
  );
  expect(refs.map(({ label, kind, id }) => ({ label, kind, id }))).toEqual([
    { label: "@Alex Chen", kind: "person", id: person },
    { label: "@Build Bot", kind: "agent", id: agent },
    { label: "#design", kind: "channel", id: "design" },
  ]);
  expect(
    messageReferences("@Alex Chen", [], profiles, channels, agents),
  ).toEqual([]);
});
it("leaves ambiguous names, partial matches and ordinary email text unchanged", () => {
  const duplicate = new Map(profiles).set(agent, { name: "Alex Chen" });
  expect(
    messageReferences(
      "@Alex Chen",
      [person, agent],
      duplicate,
      channels,
      agents,
    ),
  ).toEqual([]);
  expect(
    messageReferences(
      "x@Alex Chen #designer @Alex Chens",
      [person],
      profiles,
      channels,
      agents,
    ),
  ).toEqual([]);
});
it("keeps private channel visibility on inline references", () => {
  const refs = messageReferences(
    "Ask in #secret.",
    [],
    profiles,
    [{ id: "secret", name: "secret", private: true }],
    agents,
  );
  expect(refs).toMatchObject([
    { label: "#secret", kind: "channel", id: "secret", private: true },
  ]);
});
it("resolves channel labels from the receiving community's channel list", () => {
  expect(
    channelLinkLabel(`buzz://message?channel=design&id=${agent}`, channels),
  ).toBe("design");
  expect(channelLinkLabel("buzz://channel/design", channels)).toBe("#design");
  expect(channelLinkLabel("buzz://channel/unknown", channels)).toBeUndefined();
});
