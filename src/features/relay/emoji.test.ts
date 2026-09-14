import { afterEach, expect, it, vi } from "vitest";
import { createEmojiDirectory } from "./emoji-directory";
import { EMOJI_SET, emojiTags, referencedEmoji } from "./emoji";
import { createRelaySession } from "./session";
import { foldMessages } from "./fold";
import { PublishRejected } from "./outbox";
import {
  flush,
  keypair,
  message,
  roster,
  scriptedTransport,
  signed,
  type Key,
} from "./testing";
import type { LiveCallbacks } from "./live";
import type { RelayEvent } from "./events";

const viewer = keypair(),
  relay = keypair(),
  member = keypair();
const url = "https://a.test/media/party.png";
function set(key = member, time = 1, tags = [["emoji", "party", url]]) {
  return signed(key, {
    kind: 30030,
    created_at: time,
    content: "",
    tags: [["d", EMOJI_SET], ...tags],
  });
}
const owners: { dispose(): void }[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function session(scope = "a", publishSucceeds = false) {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const sign = vi.fn(async (template) => signed(viewer, template));
  const publish = vi.fn(async (_event: RelayEvent) => {
    if (publishSucceeds) return;
    throw new PublishRejected("retry test");
  });
  const query = vi.fn(wire.transport.query);
  const owner = createRelaySession(
    {
      ...wire.transport,
      scope,
      query,
      writer: { sign, publish },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  return { ...owner, wire, live, sign, publish, query };
}
it("normalizes first-wins tags and leaves URL fragments out of text references", () => {
  expect(
    emojiTags({
      tags: [
        ["emoji", ":PaRtY:", url],
        ["emoji", "party", "ignored"],
        ["emoji", "bad code", url],
      ],
    }),
  ).toEqual([{ shortcode: "party", url }]);
  expect(
    referencedEmoji(":PARTY: :party: https://a.test/:link: :other:"),
  ).toEqual(["party", "other"]);
});
it("unions latest complete member sets; empty replacements and ties survive stale reads", async () => {
  const h = session();
  const loading = h.session.emoji.ensure();
  const pending = h.wire.next();
  expect(pending.filters).toEqual([
    { kinds: [30030], "#d": [EMOJI_SET], limit: 500 },
  ]);
  expect(h.query.mock.calls[0]?.[3]).toBe("background");
  h.live.receive([
    set(member, 3, []),
    set(viewer, 2, [["emoji", "party", "https://z.test/p"]]),
  ]);
  pending.respond([set(member, 1)]);
  await loading;
  expect(h.session.emoji.snapshot().entries).toEqual([
    { shortcode: "party", url: "https://z.test/p" },
  ]);
  h.live.receive([set(relay, 2, [["emoji", "party", "https://b.test/p"]])]);
  expect(h.session.emoji.snapshot().entries[0]?.url).toBe("https://b.test/p");
  const sameA = set(member, 4, [["emoji", "party", "https://x.test/a"]]);
  const sameB = set(member, 4, [["emoji", "party", "https://x.test/b"]]);
  h.live.receive([sameA, sameB, sameA]);
  expect(h.session.emoji.snapshot().entries[0]?.url).toBe(
    emojiTags(sameA.id < sameB.id ? sameA : sameB)[0]?.url,
  );
});
it("actual session cold send is draft-safe; A/B sends, replies and signed retries pin original URLs", async () => {
  const a = session("a"),
    b = session("b");
  expect(() => a.session.messages.send("c", ":party:")).toThrow(/loading/);
  expect(a.session.outbox?.snapshot()).toHaveLength(0);
  expect(b.wire.pending).toHaveLength(0);
  const aRead = a.wire.next();
  const bReady = b.session.emoji.ensure();
  b.wire
    .next()
    .respond([
      set(member, 1, [["emoji", "party", "https://b.test/media/party.png"]]),
    ]);
  aRead.respond([set()]);
  await bReady;
  await flush();
  const sendId = a.session.messages.send("c", ":unknown:party:");
  const replyId = b.session.messages.reply(
    "c",
    "e".repeat(64),
    ":party: :party:",
  );
  const aEvent = a.session.outbox
    ?.snapshot()
    .find((e) => e.event.id === sendId)?.event;
  const bEvent = b.session.outbox
    ?.snapshot()
    .find((e) => e.event.id === replyId)?.event;
  expect(bEvent?.tags.filter(([name]) => name === "emoji")).toEqual([
    ["emoji", "party", "https://b.test/media/party.png"],
  ]);
  expect(aEvent?.tags.filter(([name]) => name === "emoji")).toEqual([
    ["emoji", "party", url],
  ]);
  expect(bEvent?.tags).toEqual(
    expect.arrayContaining([
      ["emoji", "party", "https://b.test/media/party.png"],
      ["e", "e".repeat(64), "", "reply"],
    ]),
  );
  await flush();
  await flush();
  expect(a.publish).toHaveBeenCalledTimes(1);
  a.live.receive([set(member, 9, [["emoji", "party", "https://new.test/p"]])]);
  a.session.messages.retry(sendId);
  await flush();
  await flush();
  expect(a.sign).toHaveBeenCalledTimes(1);
  expect(a.publish.mock.calls[1]?.[0]).toEqual(a.publish.mock.calls[0]?.[0]);
  expect(a.publish.mock.calls[1]?.[0].tags).toContainEqual([
    "emoji",
    "party",
    url,
  ]);
  expect(a.session.emoji.snapshot().entries[0]?.url).toBe("https://new.test/p");
});
it("reactions use retained thread targets after shared-cache eviction", () => {
  const h = session();
  const root = message(member, "c", "Still visible", 1);
  h.live.receive([root]);
  const thread = h.session.thread("c", root.id);
  owners.push(thread);
  h.live.receive(
    Array.from({ length: 9 }, (_, index) =>
      message(member, "other", "x".repeat(1024 * 1024), 100 + index),
    ),
  );
  expect(thread.snapshot().root?.id).toBe(root.id);
  const id = h.session.messages.react(root.id, "👍");
  expect(
    h.session.outbox?.snapshot().find((item) => item.event.id === id)?.event,
  ).toMatchObject({
    kind: 7,
    content: "👍",
    tags: expect.arrayContaining([
      ["h", "c"],
      ["e", root.id],
    ]),
  });
});
it("reconciles retained channel reactions through confirmation and access loss", async () => {
  const h = session("a", true);
  const root = message(member, "c", "Still visible", 1);
  h.session.channels.ensure("c");
  h.live.receive([roster(relay, "c", [viewer.pubkey], 1), root]);
  h.live.receive(
    Array.from({ length: 9 }, (_, index) =>
      message(member, "other", "x".repeat(1024 * 1024), 100 + index),
    ),
  );
  expect(h.session.channels.window("c").rows[0]?.id).toBe(root.id);
  const id = h.session.messages.react(root.id, "👍");
  expect(h.session.channels.window("c").rows[0]?.reactions).toEqual([
    { content: "👍" },
  ]);
  await flush();
  await flush();
  const operation = h.session.outbox
    ?.snapshot()
    .find((item) => item.event.id === id);
  expect(operation).toMatchObject({ delivery: "accepted", signed: { id } });
  const confirmation = h.wire.pending.find((request) =>
    request.filters.some((filter) => filter.ids?.includes(id)),
  );
  if (!confirmation || !operation?.signed)
    throw new Error("Missing signed reaction confirmation");
  confirmation.respond([operation.signed]);
  await flush();
  expect(h.session.outbox?.snapshot()).toHaveLength(0);
  expect(h.session.channels.window("c").rows[0]?.reactions).toEqual([
    { content: "👍" },
  ]);
  h.live.receive([roster(relay, "c", [], 2)]);
  expect(h.session.channels.window("c").rows).toEqual([]);
  expect(() => h.session.messages.react(root.id, "🎉")).toThrow(/Load/);
});
it("accepts every catalog shortcode length through session reaction authoring", async () => {
  const h = session();
  const root = message(member, "c", "React here", 1);
  const names = [62, 63, 64].map((length) => "a".repeat(length));
  h.live.receive([root]);
  const ready = h.session.emoji.ensure();
  h.wire.next().respond([
    set(
      member,
      1,
      names.map((name) => ["emoji", name, `https://a.test/${name}.png`]),
    ),
  ]);
  await ready;
  for (const name of names) {
    const content = `:${name}:`;
    const id = h.session.messages.react(root.id, content);
    expect(
      h.session.outbox?.snapshot().find((item) => item.event.id === id)?.event,
    ).toMatchObject({
      kind: 7,
      content,
      tags: expect.arrayContaining([
        ["e", root.id],
        ["emoji", name, `https://a.test/${name}.png`],
      ]),
    });
  }
});
it("reactions use the loaded target and preserve custom emoji on a failed delivery retry", async () => {
  const h = session();
  const root = message(member, "c", "React here", 1);
  h.live.receive([root]);
  const ready = h.session.emoji.ensure();
  h.wire.next().respond([set()]);
  await ready;
  const id = h.session.messages.react(root.id, ":party:");
  await flush();
  await flush();
  const event = h.publish.mock.calls[0]?.[0];
  expect(event).toMatchObject({ kind: 7, content: ":party:" });
  expect(event?.tags).toEqual(
    expect.arrayContaining([
      ["h", "c"],
      ["e", root.id],
      ["emoji", "party", url],
    ]),
  );
  h.live.receive([set(member, 9, [["emoji", "party", "https://new.test/p"]])]);
  h.session.messages.retry(id);
  await flush();
  await flush();
  expect(h.sign).toHaveBeenCalledTimes(1);
  expect(h.publish.mock.calls[1]?.[0]).toEqual(event);
  expect(() => h.session.messages.react("missing", "👍")).toThrow(/Load/);
  expect(() => h.session.messages.react(root.id, " ")).toThrow(/empty/);
  expect(() => h.session.messages.react(root.id, "x".repeat(65))).toThrow(
    /long/,
  );
  expect(() =>
    h.session.messages.react(root.id, `:${"x".repeat(65)}:`),
  ).toThrow(/long/);
});
it("plain sends are immediate and do not acquire a palette; load failure requires explicit retry", async () => {
  const h = session();
  expect(h.session.messages.send("c", "hello")).toMatch(/^[0-9a-f]{64}$/);
  expect(h.wire.pending.some((p) => p.filters[0]?.kinds?.includes(30030))).toBe(
    false,
  );
  for (const pending of h.wire.pending.splice(0)) pending.respond([]);
  await flush();
  const ready = h.session.emoji.ensure();
  await flush();
  h.wire.next().fail(new Error("offline"));
  await ready;
  expect(h.session.emoji.snapshot().status).toBe("error");
  expect(() =>
    h.session.messages.reply("c", "a".repeat(64), ":party:"),
  ).toThrow(/unavailable/);
  await h.session.emoji.ensure();
  expect(h.wire.pending).toHaveLength(0);
  const retry = h.session.emoji.refresh();
  await vi.waitFor(() => expect(h.wire.pending).toHaveLength(1));
  h.wire.next().respond([set()]);
  await retry;
  expect(h.session.emoji.snapshot().status).toBe("ready");
});
it("initial roster cancellation restarts demanded emoji once; clear/dispose fence obsolete results", async () => {
  const h = session();
  h.session.channels.ensureList();
  const discovery = h.wire.next();
  const ready = h.session.emoji.ensure(),
    stale = h.wire.next();
  discovery.respond([roster(relay, "c", [viewer.pubkey])]);
  await ready;
  await flush();
  expect(stale.signal?.aborted).toBe(true);
  const fresh = h.wire.pending.find((p) =>
    p.filters[0]?.kinds?.includes(30030),
  );
  expect(fresh).toBeDefined();
  fresh?.respond([set(member, 2)]);
  h.wire.pending
    .splice(0)
    .filter((p) => p !== fresh)
    .forEach((p) => {
      p.respond([]);
    });
  await flush();
  expect(h.session.emoji.snapshot().status).toBe("ready");
  const refreshing = h.session.emoji.refresh(),
    old = h.wire.next();
  const clear = h.clearCache();
  await clear;
  await refreshing;
  await flush();
  expect(old.signal?.aborted).toBe(true);
  expect(h.session.emoji.snapshot().entries).toEqual([]);
  h.dispose();
  old.respond([set(member, 99)]);
  await flush();
  expect(h.session.emoji.snapshot().entries).toEqual([]);
});
it("reconnect repairs a previously requested catalog, without preloading an unused community", async () => {
  const h = session(),
    idle = session();
  const ready = h.session.emoji.ensure();
  h.wire.next().respond([set()]);
  await ready;
  for (const target of [h, idle]) {
    target.live.state({ status: "connected", routes: [] });
    target.live.established();
  }
  await flush();
  await flush();
  const requests = h.wire.pending.filter((p) =>
    p.filters[0]?.kinds?.includes(30030),
  );
  expect(requests).toHaveLength(1);
  expect(
    idle.wire.pending.some((p) => p.filters[0]?.kinds?.includes(30030)),
  ).toBe(false);
  requests[0]?.respond([set(member, 2, [])]);
  await flush();
  expect(h.session.emoji.snapshot().entries).toEqual([]);
});
it("exposes read-cap and retained-byte limits rather than evicting replacement evidence", async () => {
  const reader = {
    read: vi.fn(async () => Array(500).fill(set()) as RelayEvent[]),
  };
  const directory = createEmojiDirectory(reader);
  owners.push(directory);
  await directory.queries.ensure();
  expect(directory.queries.snapshot()).toMatchObject({
    status: "error",
    error: expect.stringContaining("incomplete"),
  });
  directory.accept([
    set(member, 2, [["emoji", "party", "x".repeat(2 * 1024 * 1024)]]),
  ]);
  expect(directory.queries.snapshot()).toMatchObject({
    status: "error",
    entries: [],
    error: expect.stringContaining("budget"),
  });
  directory.accept([set(member, 1)]);
  expect(directory.queries.snapshot().entries).toEqual([]);
  reader.read.mockResolvedValueOnce([set(member, 3, [])]);
  await directory.queries.refresh();
  expect(reader.read).toHaveBeenCalledTimes(2);
  expect(directory.queries.snapshot()).toMatchObject({
    status: "ready",
    entries: [],
  });
  directory.accept([set(member, 1)]);
  expect(directory.queries.snapshot().entries).toEqual([]);
});
it("fold preserves historical message/edit mappings and per-reaction URLs without a catalog", () => {
  const original = message(viewer, "c", ":party:", 1, [
    ["emoji", "party", url],
  ]);
  const edit = (key: Key, time: number, tags: string[][]) =>
    signed(key, {
      kind: 40003,
      created_at: time,
      content: "edited :party:",
      tags: [["e", original.id], ...tags],
    });
  const reactions = ["https://one.test/p", "https://two.test/p"].map((url) =>
    signed(member, {
      kind: 7,
      content: ":party:",
      tags: [
        ["e", original.id],
        ["emoji", "party", url],
      ],
    }),
  );
  const tagged = edit(viewer, 2, [["emoji", "party", "https://edited.test/p"]]);
  const fold = (...extra: RelayEvent[]) =>
    foldMessages("c", relay.pubkey, [original, ...reactions, ...extra])[0];
  expect(fold(tagged)?.emoji).toEqual([
    { shortcode: "party", url: "https://edited.test/p" },
  ]);
  expect(fold(tagged, edit(viewer, 3, []))?.emoji).toEqual([
    { shortcode: "party", url },
  ]);
  expect(
    fold(edit(member, 4, [["emoji", "party", "https://spoof.test/p"]]))?.emoji,
  ).toEqual([{ shortcode: "party", url }]);
  expect(fold()?.reactions.map((r) => r.emoji?.url)).toEqual([
    "https://one.test/p",
    "https://two.test/p",
  ]);
});
