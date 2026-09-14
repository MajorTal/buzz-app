import { assert, expect, it, vi } from "vitest";
import { foldMessages } from "./fold";
import { createRelaySession } from "./session";
import {
  bounds,
  flush,
  keypair,
  message,
  metadata,
  profile,
  roster,
  scriptedTransport,
  signed,
} from "./testing";
import type { LiveCallbacks } from "./live";
import type { HeadPersistence, SavedHead } from "./persistence";
import { rowProfileIds } from "./membership";

const relay = keypair(),
  viewer = keypair(),
  pinky = keypair(),
  brain = keypair();
const activity = (body: unknown, time = 20, signer = relay, channel = "a") =>
  signed(signer, {
    kind: 40099,
    content: JSON.stringify(body),
    created_at: time,
    tags: [["h", channel]],
  });
const addition = (target = pinky.pubkey, time = 20) =>
  activity({ type: "member_joined", actor: viewer.pubkey, target }, time);
const end = () =>
  bounds(relay, "a", "head", { has_more: false, next_cursor: null });

it("admits only recognized, channel-scoped relay-authored membership payloads", () => {
  const joined = addition();
  const left = activity({ type: "member_left", actor: pinky.pubkey });
  const removed = activity({
    type: "member_removed",
    actor: viewer.pubkey,
    target: brain.pubkey,
  });
  const rows = foldMessages("a", relay.pubkey, [joined, left, removed]);
  expect(rows).toHaveLength(3);
  expect(rows.find((r) => r.id === left.id)?.membership?.target).toBe(
    pinky.pubkey,
  );
  expect(
    rows.every((r) => !r.content && !r.mentions.length && !r.replyCount),
  ).toBe(true);
  const joinedRow = rows.find((r) => r.id === joined.id);
  assert.exists(joinedRow);
  expect(rowProfileIds(joinedRow)).toEqual([viewer.pubkey, pinky.pubkey]);
  const invalid = [
    null,
    [],
    {},
    { type: "channel_created", actor: viewer.pubkey },
    { type: "member_joined", actor: viewer.pubkey },
    { type: "member_joined", actor: "fake", target: pinky.pubkey },
    { type: "member_removed", actor: viewer.pubkey, target: "fake" },
    { type: "member_left", actor: pinky.pubkey, target: brain.pubkey },
  ];
  expect(
    foldMessages("a", relay.pubkey, [
      ...invalid.map((body) => activity(body)),
      activity(
        { type: "member_joined", actor: viewer.pubkey, target: pinky.pubkey },
        20,
        viewer,
      ),
      activity(
        { type: "member_left", actor: pinky.pubkey },
        20,
        relay,
        "other",
      ),
      signed(relay, {
        kind: 40099,
        content: "broken JSON",
        tags: [["h", "a"]],
      }),
    ]),
  ).toEqual([]);
});

it.each([false, true])(
  "history, live, older pages and optional profiles share the existing session (prepared=%s)",
  async (prepared) => {
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    let live!: LiveCallbacks;
    const owner = createRelaySession(
      {
        ...wire.transport,
        subscribe(callbacks) {
          live = callbacks;
          return { update() {}, retry() {}, dispose() {} };
        },
      },
      { prepared },
    );
    const q = owner.session.channels;
    try {
      q.ensureList();
      wire
        .next()
        .respond([
          roster(relay, "a", [viewer.pubkey]),
          metadata(relay, "a", "A"),
        ]);
      await flush();
      q.ensure("a");
      const head = wire.next();
      expect([...(head.filters[0]?.kinds ?? [])].sort((a, b) => a - b)).toEqual(
        [9, 40002, 40099],
      );
      const row = addition();
      head.respond([
        row,
        bounds(relay, "a", "head", {
          has_more: true,
          next_cursor: { created_at: row.created_at, id: row.id },
        }),
      ]);
      await flush();
      expect(q.window("a").rows.map((r) => r.id)).toEqual([row.id]);
      // Render before enrichment, with no per-row blocking request.
      const names = wire.next();
      expect([...(names.filters[0]?.authors ?? [])].sort()).toEqual(
        [viewer.pubkey, pinky.pubkey].sort(),
      );
      names.respond([
        profile(viewer, { name: "Wes" }),
        profile(pinky, { name: "Pinky" }),
      ]);
      await flush();
      const chat = message(pinky, "a", "Conversation preview", 21);
      live.receive([chat, addition(brain.pubkey, 22)]);
      await flush();
      expect(q.window("a").rows.map((r) => r.id)).toEqual([
        row.id,
        chat.id,
        addition(brain.pubkey, 22).id,
      ]);
      expect(q.list().channels[0]?.preview).toBe("Conversation preview");
      expect(
        owner.session.unread.snapshot({ kind: "channel", channelId: "a" })
          .observedCount,
      ).toBe(1);
      const moreNames = wire.next();
      expect(moreNames.filters[0]?.authors).toEqual([brain.pubkey]);
      moreNames.respond([profile(brain, { name: "Brain" })]);
      await flush();
      q.loadOlder("a");
      const older = wire.next();
      expect(older.filters[0]).toMatchObject({
        kinds: [40002, 40099, 9],
        until: 20,
        before_id: row.id,
      });
      const old = addition(brain.pubkey, 19);
      older.respond([
        old,
        bounds(relay, "a", `20:${row.id}`, {
          has_more: false,
          next_cursor: null,
        }),
      ]);
      await flush();
      expect(q.window("a").rows.map((r) => r.id)).toEqual([
        old.id,
        row.id,
        chat.id,
        addition(brain.pubkey, 22).id,
      ]);
      const before = q.window("a").rows;
      live.receive([
        activity(
          { type: "member_joined", actor: viewer.pubkey, target: brain.pubkey },
          23,
          pinky,
        ),
      ]);
      expect(q.window("a").rows).toEqual(before);
      live.receive([roster(relay, "a", [], 1_800_000_000)]);
      expect(q.window("a").rows).toEqual([]);
    } finally {
      owner.dispose();
    }
  },
);

it("live activity obeys the same retained row budget as messages", async () => {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession(
    {
      ...wire.transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { maxHistoryRows: 2 },
  );
  try {
    live.receive([roster(relay, "a", [viewer.pubkey])]);
    owner.session.channels.ensure("a");
    wire.next().respond([end()]);
    await flush();
    live.receive([
      addition(pinky.pubkey, 1),
      addition(pinky.pubkey, 2),
      addition(brain.pubkey, 3),
    ]);
    expect(owner.session.channels.window("a")).toMatchObject({
      historyLimited: true,
    });
    expect(
      owner.session.channels.window("a").rows.map((r) => r.createdAt),
    ).toEqual([2, 3]);
  } finally {
    owner.dispose();
  }
});

it("prepared disk heads retain signed membership evidence and subject profiles for warm restore", async () => {
  let saved: SavedHead[] = [];
  const disk: HeadPersistence = {
    read: async () => saved,
    write: async (record) => {
      saved = [record];
    },
    retain: async () => {},
    remove: async () => {},
    clear: async () => {},
    close() {},
  };
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const first = createRelaySession(wire.transport, {
    prepared: true,
    persistence: disk,
  });
  try {
    first.session.channels.ensureList();
    wire
      .next()
      .respond([
        roster(relay, "a", [viewer.pubkey]),
        metadata(relay, "a", "A"),
      ]);
    await flush();
    first.session.channels.prepare?.("a");
    wire.next().respond([addition(), end()]);
    await flush();
    wire
      .next()
      .respond([
        profile(viewer, { name: "Wes" }),
        profile(pinky, { name: "Pinky" }),
      ]);
    await flush();
    expect(saved[0]?.events).toContainEqual(
      expect.objectContaining({ id: addition().id, kind: 40099 }),
    );
    expect(saved[0]?.profiles).toHaveLength(2);
  } finally {
    first.dispose();
  }
  const secondWire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const second = createRelaySession(secondWire.transport, {
    prepared: true,
    persistence: disk,
  });
  try {
    second.session.channels.ensureList();
    secondWire
      .next()
      .respond([
        roster(relay, "a", [viewer.pubkey]),
        metadata(relay, "a", "A"),
      ]);
    await flush();
    await flush();
    second.session.channels.ensure("a");
    await vi.waitFor(() =>
      expect(
        second.session.channels.window("a").rows[0]?.membership?.target,
      ).toBe(pinky.pubkey),
    );
    expect(second.session.profiles.snapshot().get(pinky.pubkey)?.name).toBe(
      "Pinky",
    );
  } finally {
    second.dispose();
  }
});
