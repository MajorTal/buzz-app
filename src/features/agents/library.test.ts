import { expect, it, vi } from "vitest";
import {
  createAgentLibrary,
  groupAgentLibrary,
  type AgentLibrary,
} from "./library";
import { createRelaySession } from "../relay/session";
import { keypair } from "../relay/testing";
const library: AgentLibrary = {
  definitions: [
    { id: "brain", name: "Brain" },
    { id: "other", name: "Brain" },
  ],
  identities: [
    { pubkey: "a".repeat(64), name: "Brain", definitionId: "brain" },
    { pubkey: "b".repeat(64), name: "Brain", definitionId: "brain" },
    { pubkey: "c".repeat(64), name: "Custom" },
    { pubkey: "d".repeat(64), name: "Other setup", definitionId: "unselected" },
  ],
};
it("preserves legacy selected grouping, unlinked and unknown entries without merging namesakes", () => {
  const groups = groupAgentLibrary(library, (key) => key === "a".repeat(64));
  expect(groups.groups).toHaveLength(2);
  expect(groups.groups[0]?.identities.map((row) => row.pubkey)).toEqual([
    "b".repeat(64),
  ]);
  expect(groups.groups[1]?.identities).toEqual([]);
  expect(groups.custom[0]?.name).toBe("Custom");
  expect(groups.unknown[0]?.name).toBe("Other setup");
});
it("lazy fresh reads replace, fail visibly, retry, and fence late results", async () => {
  const read = vi.fn().mockResolvedValue(library);
  const owner = createAgentLibrary(read);
  expect(read).not.toHaveBeenCalled();
  await owner.queries.refresh();
  expect(owner.queries.snapshot().identities).toHaveLength(4);
  read.mockRejectedValueOnce(new Error("private error"));
  await owner.queries.refresh();
  expect(owner.queries.snapshot().status).toBe("error");
  expect(JSON.stringify(owner.queries.snapshot())).not.toContain(
    "private error",
  );
  await owner.queries.refresh();
  expect(owner.queries.snapshot().status).toBe("ready");
  let release!: (value: AgentLibrary) => void;
  read.mockImplementationOnce(
    () =>
      new Promise<AgentLibrary>((resolve) => {
        release = resolve;
      }),
  );
  const pending = owner.queries.refresh();
  expect(owner.queries.snapshot().identities).toEqual(library.identities);
  await Promise.resolve();
  owner.clear();
  release(library);
  await pending;
  expect(owner.queries.snapshot().status).toBe("idle");
  owner.dispose();
  expect(owner.queries.snapshot().identities).toEqual([]);
});
it("actual session wires the host library and clears/disposes it without relay directory reads", async () => {
  const read = vi.fn().mockResolvedValue(library);
  const query = vi.fn().mockResolvedValue([]);
  const owner = createRelaySession({
    viewer: keypair().pubkey,
    relayAuthor: keypair().pubkey,
    media: () => undefined,
    query,
    readAgentLibrary: read,
  });
  await owner.session.agentLibrary.refresh();
  expect(read).toHaveBeenCalledOnce();
  expect(query).not.toHaveBeenCalled();
  expect(owner.session.agentLibrary.snapshot().definitions).toHaveLength(2);
  await owner.clearCache();
  expect(owner.session.agentLibrary.snapshot().definitions).toEqual([]);
  await owner.session.agentLibrary.refresh();
  owner.dispose();
  expect(owner.session.agentLibrary.snapshot().status).toBe("unavailable");
});
