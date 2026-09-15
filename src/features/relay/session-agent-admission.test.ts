import { expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { PublishRejected } from "./outbox";
import { keypair, roster, signed } from "./testing";
import { matchesEvent } from "./projection";
import type { RelayEvent } from "./events";

function setup() {
  const viewer = keypair(),
    relay = keypair(),
    agent = keypair();
  const parent = "11111111-1111-4111-8111-111111111111",
    child = "22222222-2222-4222-8222-222222222222";
  let members = [viewer.pubkey];
  let childMembers = [viewer.pubkey];
  let denyChild = false;
  let clock = 1700000000;
  let denied = false;
  let afterPublish = () => {};
  const secondAgent = keypair().pubkey;
  const meta = (id: string, type: string, extra: string[][] = []) =>
    signed(relay, {
      kind: 39000,
      content: "",
      tags: [["d", id], ["t", type], ["name", id], ...extra],
    });
  const publish = vi.fn(async (_event: RelayEvent) => {
    const target = _event.tags.find(([name]) => name === "h")?.[1];
    if (denied || (denyChild && target === child))
      throw new PublishRejected("Only channel admins can add agents");
    if (target === parent) members = [viewer.pubkey, agent.pubkey];
    if (target === child) childMembers = [viewer.pubkey, agent.pubkey];
    clock++;
    afterPublish();
  });
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      readAgentLibrary: async () => ({
        definitions: [],
        identities: [
          { pubkey: agent.pubkey, name: "Outside agent" },
          { pubkey: secondAgent, name: "Second agent" },
        ],
      }),
      writer: {
        kinds: [9, 9000, 9007],
        sign: async (template) => signed(viewer, template),
        publish,
      },
      query: async (filters) => {
        const events = [
          meta(parent, "stream"),
          meta(child, "stream", [
            ["private"],
            ["about", `Buzz session (buzz.sessions/v1)\nparent:${parent}`],
          ]),
          roster(relay, parent, members, clock),
          roster(relay, child, childMembers, clock),
        ];
        return events.filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        );
      },
    },
    { outboxStorage: { load: () => [], save: () => {} } },
  );
  return {
    owner,
    parent,
    child,
    agent: agent.pubkey,
    secondAgent,
    afterPublish: (callback: () => void) => {
      afterPublish = callback;
    },
    publish,
    denyChild: (value: boolean) => {
      denyChild = value;
    },
    setDenied: (value: boolean) => {
      denied = value;
    },
    async ready() {
      owner.session.channels.ensureList();
      await vi.waitFor(() =>
        expect(
          owner.session.channels
            .list()
            .channels.find((item) => item.id === child)?.parentChannelId,
        ).toBe(parent),
      );
      await owner.session.agentLibrary.refresh();
    },
  };
}

it("adds an outside agent once to each channel and confirms both memberships", async () => {
  const test = setup();
  try {
    await test.ready();
    await test.owner.session.workSessions.addAgents(test.child, [
      test.agent,
      test.agent,
    ]);
    expect(test.publish).toHaveBeenCalledTimes(2);
    expect(test.publish.mock.calls[0]?.[0]).toMatchObject({
      kind: 9000,
      tags: expect.arrayContaining([
        ["h", test.parent],
        ["p", test.agent],
      ]),
    });
    expect(
      test.publish.mock.calls[0]?.[0].tags.some(([name]) => name === "role"),
    ).toBe(false);
    expect(
      test.owner.session.channels
        .list()
        .channels.find((item) => item.id === test.child)?.members,
    ).toContain(test.agent);
    await test.owner.session.workSessions.addAgents(test.parent, [test.agent]);
    expect(test.publish).toHaveBeenCalledTimes(2);
  } finally {
    test.owner.dispose();
  }
});
it("keeps channel permission failures and retries the same saved invitation", async () => {
  const test = setup();
  try {
    await test.ready();
    test.setDenied(true);
    await expect(
      test.owner.session.workSessions.addAgents(test.child, [test.agent]),
    ).rejects.toThrow(/Only channel admins/);
    expect(
      test.owner.session.channels
        .list()
        .channels.find((item) => item.id === test.child)?.members,
    ).not.toContain(test.agent);
    const first = test.publish.mock.calls[0]?.[0].id;
    test.setDenied(false);
    await test.owner.session.workSessions.addAgents(test.child, [test.agent]);
    expect(test.publish.mock.calls[1]?.[0].id).toBe(first);
    expect(test.publish).toHaveBeenCalledTimes(3);
  } finally {
    test.owner.dispose();
  }
});
it("rejects nonmember identities outside the agent library before adding anyone", async () => {
  const test = setup();
  try {
    await test.ready();
    await expect(
      test.owner.session.workSessions.addAgents(test.parent, [
        test.agent,
        "f".repeat(64),
      ]),
    ).rejects.toThrow(/agent library/);
    expect(test.publish).not.toHaveBeenCalled();
  } finally {
    test.owner.dispose();
  }
});

it("stops additional invitations when the composing view closes during admission", async () => {
  const test = setup();
  let active = true;
  try {
    await test.ready();
    test.afterPublish(() => {
      active = false;
    });
    await expect(
      test.owner.session.workSessions.addAgents(
        test.child,
        [test.agent, test.secondAgent],
        () => active,
      ),
    ).rejects.toThrow(/cancelled/);
    expect(test.publish).toHaveBeenCalledOnce();
    expect(test.publish.mock.calls[0]?.[0].tags).toContainEqual([
      "p",
      test.agent,
    ]);
  } finally {
    test.owner.dispose();
  }
});

it.each([false, true])(
  "ordinary child admission uses real separate rosters and recovers denial: %s",
  async (rejectChild) => {
    const test = setup();
    try {
      await test.ready();
      test.denyChild(rejectChild);
      if (rejectChild) {
        await expect(
          test.owner.session.workSessions.addAgents(test.child, [test.agent]),
        ).rejects.toThrow(/Only channel admins/);
        expect(
          test.owner.session.channels
            .list()
            .channels.find((item) => item.id === test.child)?.members,
        ).not.toContain(test.agent);
        test.denyChild(false);
      }
      await test.owner.session.workSessions.addAgents(test.child, [test.agent]);
      expect(
        test.publish.mock.calls.map(
          ([event]) => event.tags.find(([name]) => name === "h")?.[1],
        ),
      ).toEqual(
        rejectChild
          ? [test.parent, test.child, test.child]
          : [test.parent, test.child],
      );
      if (rejectChild)
        expect(test.publish.mock.calls[1]?.[0].id).toBe(
          test.publish.mock.calls[2]?.[0].id,
        );
      expect(
        test.owner.session.channels
          .list()
          .channels.find((item) => item.id === test.child)?.members,
      ).toContain(test.agent);
      await test.owner.session.workSessions.addAgents(test.child, [test.agent]);
      expect(test.publish).toHaveBeenCalledTimes(rejectChild ? 3 : 2);
    } finally {
      test.owner.dispose();
    }
  },
);
