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
    child = "22222222-2222-4222-8222-222222222222",
    standalone = "33333333-3333-4333-8333-333333333333";
  let members = [viewer.pubkey];
  let childMembers = [viewer.pubkey];
  let denyChild = false;
  let clock = 1700000000;
  let denied = false;
  let foreignRoster = false;
  let libraryFailure = false;
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
      readAgentLibrary: async () => {
        if (libraryFailure) throw new Error("Fixture library unavailable");
        return {
          definitions: [],
          identities: [
            { pubkey: agent.pubkey, name: "Outside agent" },
            { pubkey: secondAgent, name: "Second agent" },
          ],
        };
      },
      writer: {
        kinds: [9, 9000, 9007],
        sign: async (template) => signed(viewer, template),
        publish,
      },
      query: async (filters) => {
        if (foreignRoster && filters.some((filter) => filter["#d"]))
          return [
            roster(agent, child, [viewer.pubkey, agent.pubkey], clock + 1),
          ];
        const events = [
          meta(parent, "stream"),
          meta(child, "stream", [
            ["private"],
            ["about", `Buzz session (buzz.sessions/v1)\nparent:${parent}`],
          ]),
          meta(standalone, "stream", [
            ["private"],
            ["about", "Buzz session (buzz.sessions/v1)"],
          ]),
          roster(relay, parent, members, clock),
          roster(relay, child, childMembers, clock),
          roster(relay, standalone, [viewer.pubkey], clock),
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
    standalone,
    agent: agent.pubkey,
    secondAgent,
    setMembership: (parentMembers: boolean, sessionMembers: boolean) => {
      clock++;
      members = [viewer.pubkey, ...(parentMembers ? [agent.pubkey] : [])];
      childMembers = [viewer.pubkey, ...(sessionMembers ? [agent.pubkey] : [])];
    },
    returnForeignRoster: () => {
      foreignRoster = true;
    },
    failLibraryRefresh: () => {
      libraryFailure = true;
    },
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

it("rejects a stale cached identity after the current library refresh fails", async () => {
  const test = setup();
  try {
    await test.ready();
    test.failLibraryRefresh();
    await test.owner.session.agentLibrary.refresh();
    const library = test.owner.session.agentLibrary.snapshot();
    expect(library.status).toBe("error");
    expect(library.identities.map((identity) => identity.pubkey)).toContain(
      test.agent,
    );
    await expect(
      test.owner.session.workSessions.addAgents(test.parent, [test.agent]),
    ).rejects.toThrow(/agent library/);
    expect(test.publish).not.toHaveBeenCalled();
  } finally {
    test.owner.dispose();
  }
});

it("rejects a stale cached identity from a standalone session picker", async () => {
  const test = setup();
  try {
    await test.ready();
    test.failLibraryRefresh();
    await test.owner.session.agentLibrary.refresh();
    expect(() =>
      test.owner.session.workSessions.invite(test.standalone, test.agent),
    ).toThrow(/agent library/);
    expect(test.publish).not.toHaveBeenCalled();
  } finally {
    test.owner.dispose();
  }
});

it("allows a freshly verified parent member when the local library is unavailable", async () => {
  const test = setup();
  try {
    await test.ready();
    test.setMembership(true, false);
    test.failLibraryRefresh();
    await test.owner.session.agentLibrary.refresh();
    await test.owner.session.workSessions.addAgents(test.child, [test.agent]);
    expect(test.publish).toHaveBeenCalledOnce();
    expect(test.publish.mock.calls[0]?.[0].tags).toContainEqual([
      "h",
      test.child,
    ]);
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

it("refreshes stale membership and preserves an existing child's independent access", async () => {
  const test = setup();
  try {
    await test.ready();
    test.setMembership(false, true);
    await test.owner.session.workSessions.addAgents(test.child, [test.agent]);
    expect(test.publish).not.toHaveBeenCalled();
    expect(
      test.owner.session.channels
        .list()
        .channels.find((item) => item.id === test.child)?.members,
    ).toContain(test.agent);
    test.setMembership(false, false);
    await test.owner.session.workSessions.addAgents(test.child, [test.agent]);
    expect(test.publish).toHaveBeenCalledTimes(2);
  } finally {
    test.owner.dispose();
  }
});
it("does not accept a foreign-signed roster as fresh membership", async () => {
  const test = setup();
  try {
    await test.ready();
    test.returnForeignRoster();
    await expect(
      test.owner.session.workSessions.addAgents(test.child, [test.agent]),
    ).rejects.toThrow(/refresh channel membership/);
    expect(test.publish).not.toHaveBeenCalled();
  } finally {
    test.owner.dispose();
  }
});
