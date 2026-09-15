import { assert, afterEach, expect, it, vi } from "vitest";
import type { EventTemplate } from "nostr-tools";
import type { RelayEvent } from "./events";
import { createRelaySession } from "./session";
import {
  flush,
  keypair,
  metadata,
  roster,
  scriptedTransport,
  signed,
} from "./testing";

const viewer = keypair(),
  relay = keypair(),
  honey = keypair(),
  namesake = keypair();
const owners: ReturnType<typeof createRelaySession>[] = [];
function setup(sessionMode = false) {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let release: (() => void) | undefined;
  let held = false;
  const publish = vi.fn(async (_event: RelayEvent) => {});
  const sign = vi.fn(async (template: EventTemplate) => {
    if (held)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return signed(viewer, template);
  });
  let currentRoster: RelayEvent | undefined;
  const profileEvents: RelayEvent[] = [];
  const owner = createRelaySession(
    {
      ...wire.transport,
      query: (filters, ...args) => {
        if (
          filters[0]?.authors?.[0] === relay.pubkey &&
          filters[0]?.kinds?.[0] === 39002 &&
          filters[0]?.limit === 1
        )
          return Promise.resolve(currentRoster ? [currentRoster] : []);
        if (
          sessionMode &&
          filters.every((filter) => filter.kinds?.every((kind) => kind === 0))
        )
          return Promise.resolve(profileEvents);
        if (sessionMode && filters.every((filter) => !!filter.ids))
          return Promise.resolve(publish.mock.calls.map(([event]) => event));
        return wire.transport.query(filters, ...args);
      },
      writer: { sign, publish },
    },
    {
      outboxStorage: { load: () => [], save: () => {} },
    },
  );
  owners.push(owner);
  async function members(
    keys = [viewer.pubkey, honey.pubkey, namesake.pubkey],
    time = 1700000000,
    author = relay,
  ) {
    const read = owner.session.read([
      { kinds: [39002, 39000], "#d": ["c"], limit: 10 },
    ]);
    let pending = wire.next();
    while (!pending.filters.some((filter) => filter.kinds?.includes(39002))) {
      expect(
        pending.filters.every((filter) =>
          filter.kinds?.every((kind) => kind === 0),
        ),
      ).toBe(true);
      pending.respond([]);
      await flush();
      pending = wire.next();
    }
    currentRoster = roster(author, "c", keys, time);
    pending.respond([
      currentRoster,
      sessionMode
        ? signed(relay, {
            kind: 39000,
            content: JSON.stringify({ name: "Work" }),
            tags: [
              ["d", "c"],
              ["t", "stream"],
              ["private"],
              ["about", "Buzz session (buzz.sessions/v1)"],
            ],
          })
        : metadata(relay, "c", "General"),
    ]);
    await read;
  }
  return {
    ...wire,
    ...owner,
    members,
    async agentProfile(key: typeof honey) {
      profileEvents.push(
        signed(key, {
          kind: 0,
          content: JSON.stringify({ name: "Honey" }),
          tags: [["auth", viewer.pubkey, "", "a".repeat(128)]],
        }),
      );
      await owner.session.profiles.ensure([key.pubkey]);
    },
    sign,
    publish,
    hold: () => {
      held = true;
    },
    release: () => release?.(),
  };
}
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

it.each([false, true])(
  "publishes exact selected keys through real session/outbox for reply=%s, deduplicating keys not names",
  async (reply) => {
    const h = setup();
    await h.members();
    const keys = [honey.pubkey, honey.pubkey, namesake.pubkey];
    const root = "a".repeat(64);
    const id = reply
      ? h.session.messages.reply("c", root, "@Honey @Honey help", keys)
      : h.session.messages.send("c", "@Honey @Honey help", keys);
    await flush();
    const event = h.publish.mock.calls[0]?.[0];
    expect(event?.id).toBe(id);
    expect(event?.tags.filter(([tag]) => tag !== "client-id")).toEqual([
      ["h", "c"],
      ...(reply ? [["e", root, "", "reply"]] : []),
      ["p", honey.pubkey],
      ["p", namesake.pubkey],
    ]);
    expect(h.sign).toHaveBeenCalledTimes(1);
    // Actual publication acknowledgement is not execution completion.
    expect(h.session.outbox?.snapshot()[0]?.delivery).toBe("accepted");
  },
);
it("typed names create no recipient tags; unconfirmed or forged membership cannot grant mention permission", async () => {
  const h = setup();
  expect(() => h.session.messages.send("c", "@Honey", [honey.pubkey])).toThrow(
    /membership/,
  );
  await h.members(undefined, 1700000000, namesake);
  expect(() => h.session.messages.send("c", "@Honey", [honey.pubkey])).toThrow(
    /membership/,
  );
  await h.members();
  expect(() => h.session.messages.send("c", "@Honey", ["not-a-key"])).toThrow(
    /valid/,
  );
  h.session.messages.send("c", "@Honey");
  await flush();
  expect(
    h.publish.mock.calls[0]?.[0].tags.filter(([tag]) => tag !== "client-id"),
  ).toEqual([["h", "c"]]);
});
it("publishes roster changes even when channel names/previews are unchanged and rejects a removed recipient", async () => {
  const h = setup();
  await h.members();
  const before = h.session.channels.list();
  await h.members([viewer.pubkey, namesake.pubkey], 1700000001);
  expect(h.session.channels.list()).not.toBe(before);
  expect(h.session.channels.list().channels[0]?.members).toEqual(
    [viewer.pubkey, namesake.pubkey].sort(),
  );
  expect(() => h.session.messages.send("c", "@Honey", [honey.pubkey])).toThrow(
    /no longer/,
  );
  expect(() =>
    h.session.messages.reply("c", "a".repeat(64), "@Honey", [honey.pubkey]),
  ).toThrow(/no longer/);
  expect(h.sign).not.toHaveBeenCalled();
});
it("membership loss while signing blocks publication; retry checks again without silently replacing the recipient", async () => {
  const h = setup();
  await h.members();
  h.hold();
  const id = h.session.messages.send("c", "@Honey", [honey.pubkey]);
  await flush();
  expect(h.sign).toHaveBeenCalledTimes(1);
  await h.members([viewer.pubkey, namesake.pubkey], 1700000001);
  h.release();
  await flush();
  expect(h.publish).not.toHaveBeenCalled();
  expect(h.session.outbox?.snapshot()[0]).toMatchObject({ delivery: "failed" });
  h.session.messages.retry(id);
  await flush();
  expect(h.publish).not.toHaveBeenCalled();
  await h.members(undefined, 1700000002);
  h.session.messages.retry(id);
  await flush();
  expect(h.publish.mock.calls[0]?.[0].tags).toContainEqual(["p", honey.pubkey]);
});
it("raw outbox writes cannot bypass the pre-sign membership check", async () => {
  const h = setup();
  await h.members([viewer.pubkey]);
  assert.exists(h.session.outbox);
  h.session.outbox.send({
    kind: 9,
    content: "@Honey",
    tags: [
      ["h", "c"],
      ["p", honey.pubkey],
    ],
  });
  await flush();
  expect(h.sign).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
  expect(h.session.outbox?.snapshot()[0]?.delivery).toBe("failed");
});
it("disposal during signing fences publication to a retired session", async () => {
  const h = setup();
  await h.members();
  h.hold();
  h.session.messages.send("c", "@Honey", [honey.pubkey]);
  await flush();
  h.dispose();
  h.release();
  await flush();
  expect(h.publish).not.toHaveBeenCalled();
});

it.each([false, true])(
  "routes a sole session agent automatically and requires explicit choice after another joins, reply=%s",
  async (reply) => {
    const h = setup(true);
    await h.members([viewer.pubkey, honey.pubkey]);
    await h.agentProfile(honey);
    const send = (mentions: readonly string[] = []) =>
      reply
        ? h.session.messages.reply("c", "a".repeat(64), "Keep going", mentions)
        : h.session.messages.send("c", "Keep going", mentions);
    send();
    await flush();
    expect(
      h.publish.mock.calls[0]?.[0].tags.filter(([name]) => name === "p"),
    ).toEqual([["p", honey.pubkey]]);

    await h.members([viewer.pubkey, honey.pubkey, namesake.pubkey], 1700000001);
    expect(() => send()).toThrow(/participants are still loading/);
    await h.agentProfile(namesake);
    expect(() => send()).toThrow(/multiple agents/);
    send([namesake.pubkey]);
    await flush();
    expect(
      h.publish.mock.calls.at(-1)?.[0].tags.filter(([name]) => name === "p"),
    ).toEqual([["p", namesake.pubkey]]);
    expect(h.publish).toHaveBeenCalledTimes(2);

    await h.members([viewer.pubkey, namesake.pubkey], 1700000002);
    send();
    await flush();
    expect(
      h.publish.mock.calls.at(-1)?.[0].tags.filter(([name]) => name === "p"),
    ).toEqual([["p", namesake.pubkey]]);
  },
);
