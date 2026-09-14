import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { threadReference } from "./threads";
import type { LiveCallbacks } from "./live";
import {
  bounds,
  flush,
  keypair,
  message,
  profile,
  roster,
  scriptedTransport,
  signed,
} from "./testing";

const relay = keypair(),
  viewer = keypair(),
  alice = keypair();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function setup() {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let traffic!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      traffic = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  owners.push(owner);
  return { ...wire, ...owner, traffic };
}
const root = message(alice, "a", "Root", 1);
const reply = (text: string, time: number, parent = root.id) =>
  message(alice, "a", text, time, [
    ["e", root.id, "", "root"],
    ["e", parent, "", "reply"],
  ]);
function seeded() {
  const h = setup();
  h.traffic.receive([root]);
  return { ...h, view: h.session.thread("a", root.id) };
}

it("seeds a thread root and observed replies synchronously from retained session data", async () => {
  const h = setup();
  h.traffic.receive([roster(relay, "a", [viewer.pubkey])]);
  h.session.channels.ensure("a");
  h.next().respond([
    root,
    bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
  ]);
  await flush();
  expect(h.session.channels.window("a").rows.map((row) => row.id)).toEqual([
    root.id,
  ]);
  const observedReply = reply("Observed reply", 2);
  h.traffic.receive([observedReply]);

  const view = h.session.thread("a", root.id);
  expect(view.snapshot().root?.id).toBe(root.id);
  expect(view.snapshot().replies.map((row) => row.id)).toEqual([
    observedReply.id,
  ]);
});

it("resolves canonical marked ancestry, never arbitrary references or a lone root", () => {
  const tags = (extra: string[][]) => message(alice, "a", "test", 1, extra);
  expect(threadReference(tags([["e", root.id]]))).toBeUndefined();
  expect(threadReference(tags([["e", root.id, "", "root"]]))).toBeUndefined();
  expect(threadReference(tags([["e", root.id, "", "reply"]]))).toEqual({
    rootId: root.id,
    parentId: root.id,
  });
  expect(
    threadReference(
      tags([
        ["e", root.id, "", "reply"],
        ["e", "bad", "", "reply"],
      ]),
    )?.rootId,
  ).toBe(root.id);
  const nested = reply("nested", 3, "a".repeat(64));
  expect(threadReference(nested)).toEqual({
    rootId: root.id,
    parentId: "a".repeat(64),
  });
});

it("keeps exact forward page cursors separate from concurrent live rows and auxiliary timestamps", async () => {
  const h = seeded();
  const first = reply("first", 10),
    second = reply("second", 20),
    live = reply("live", 100);
  const loading = h.view.refresh();
  const page = h.next();
  expect(page.filters).toEqual([
    { ids: [root.id], "#h": ["a"], limit: 1 },
    {
      kinds: [40002, 9],
      "#h": ["a"],
      "#e": [root.id],
      depth_limit: 100,
      include_aux: true,
      limit: 50,
    },
  ]);
  h.traffic.receive([live]);
  page.respond([
    root,
    first,
    second,
    signed(alice, {
      kind: 40003,
      content: "edited",
      created_at: 200,
      tags: [["e", first.id]],
    }),
  ]);
  await loading;
  expect(h.view.snapshot().replies.map((row) => row.content)).toEqual([
    "edited",
    "second",
    "live",
  ]);
  const more = h.view.loadMore();
  const next = h.next();
  expect(next.filters[1]).toMatchObject({
    thread_cursor: 20,
    thread_cursor_id: second.id,
  });
  next.respond([root, reply("third", 30)]);
  await more;
  expect(h.view.snapshot().replies.map((row) => row.createdAt)).toEqual([
    10, 20, 30, 100,
  ]);
});

it("pages same-second ties, counts non-rendered content and keeps short pages continuable", async () => {
  const h = seeded();
  const tied = [reply("one", 10), reply("two", 10)].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const first = h.view.refresh();
  h.next().respond([root, ...tied]);
  await first;
  const more = h.view.loadMore();
  const page = h.next();
  expect(page.filters[1]).toMatchObject({
    thread_cursor: 10,
    thread_cursor_id: tied[1]?.id,
  });
  const other = signed(alice, {
    kind: 45003,
    content: "other content kind",
    created_at: 11,
    tags: [
      ["h", "a"],
      ["e", root.id, "", "reply"],
    ],
  });
  page.respond([root, other]);
  await more;
  expect(h.view.snapshot().canLoadMore).toBe(true);
  const end = h.view.loadMore();
  const empty = h.next();
  expect(empty.filters[1]).toMatchObject({
    thread_cursor: 11,
    thread_cursor_id: other.id,
  });
  empty.respond([root]);
  await end;
  expect(h.view.snapshot()).toMatchObject({
    status: "ready",
    canLoadMore: false,
    limited: false,
  });
});

it("resolves a selected broadcast reply to its actual root", async () => {
  const h = setup();
  const selected = reply("nested", 3, "b".repeat(64));
  const view = h.session.thread("a", selected.id);
  const loading = view.refresh();
  h.next().respond([selected]);
  await flush();
  const page = h.next();
  expect(page.filters[1]?.["#e"]).toEqual([root.id]);
  page.respond([root, selected]);
  await loading;
  expect(view.snapshot().root?.id).toBe(root.id);
});

it("updates nested replies and reply-targeted overlays without a new socket or arbitrary e-tag matches", async () => {
  const h = seeded();
  const parent = reply("parent", 10),
    child = reply("child", 11, parent.id);
  const loading = h.view.refresh();
  h.next().respond([root, parent]);
  await loading;
  h.traffic.receive([
    child,
    message(alice, "a", "reference only", 12, [["e", root.id]]),
    message(alice, "b", "wrong channel", 12, [["e", root.id, "", "reply"]]),
  ]);
  const edit = signed(alice, {
    kind: 40003,
    content: "child edited",
    tags: [["e", child.id]],
  });
  h.traffic.receive([edit]);
  expect(h.view.snapshot().replies.map((row) => row.content)).toEqual([
    "parent",
    "child edited",
  ]);
  h.traffic.receive([
    signed(alice, { kind: 5, content: "", tags: [["e", child.id]] }),
  ]);
  expect(h.view.snapshot().replies.map((row) => row.content)).toEqual([
    "parent",
  ]);
});

it("purges atomically on access loss, fences late results and allows explicit regrant recovery", async () => {
  const h = seeded();
  h.traffic.receive([roster(relay, "a", [viewer.pubkey], 10)]);
  const loading = h.view.refresh();
  const stale = h.next();
  h.traffic.receive([roster(relay, "a", [], 11)]);
  expect(stale.signal?.aborted).toBe(true);
  expect(h.view.snapshot().root).toBeUndefined();
  expect(h.view.snapshot().replies).toEqual([]);
  h.traffic.receive([roster(relay, "a", [viewer.pubkey], 12)]);
  stale.respond([root, reply("late", 10)]);
  await loading;
  expect(h.view.snapshot().replies).toEqual([]);
  const fresh = h.view.refresh();
  h.next().respond([root]);
  await flush();
  h.next().respond([root, reply("fresh", 13)]);
  await fresh;
  expect(h.view.snapshot().replies.map((row) => row.content)).toEqual([
    "fresh",
  ]);
});

it("disposes pending work and never allocates beyond the shared owned-view budget", async () => {
  const h = seeded();
  const loading = h.view.refresh();
  const pending = h.next();
  h.view.dispose();
  expect(pending.signal?.aborted).toBe(true);
  pending.respond([root]);
  await loading;
  for (let i = 0; i < 64; i++) h.session.thread("a", root.id);
  expect(() => h.session.thread("a", root.id)).toThrow("capacity");
});

it("repairs retained thread pages through the real channel-established catch-up path without head invalidation cancelling traversal", async () => {
  const h = seeded();
  h.traffic.receive([
    roster(relay, "a", [viewer.pubkey]),
    profile(alice, { name: "Alice" }),
  ]);
  h.session.channels.ensure("a");
  h.next().respond([
    bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
  ]);
  await flush();
  const first = h.view.refresh();
  h.next().respond([root, reply("old", 10)]);
  await first;
  const more = h.view.loadMore();
  h.next().respond([root, reply("later", 20)]);
  await more;
  h.traffic.established("b");
  expect(h.pending).toHaveLength(0);
  h.traffic.state({ status: "connected", routes: [] });
  h.traffic.state({ status: "retrying", routes: [] });
  h.traffic.state({ status: "connected", routes: [] });
  h.traffic.established("a");
  const repair = h.next();
  await flush(); // EOSE queues the actual retained channel catch-up.
  const head = h.next();
  expect(head.filters[0]?.depth_limit).toBeUndefined();
  expect(head.filters[0]?.["#h"]).toEqual(["a"]);
  expect(repair.signal?.aborted).toBe(false);
  head.respond([
    bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
  ]);
  repair.respond([root, reply("old", 10), reply("missed", 15)]);
  await flush();
  const next = h.next();
  expect(next.filters[1]?.thread_cursor).toBe(15);
  next.respond([root, reply("later", 20)]);
  await flush();
  expect(h.view.snapshot().replies.map((row) => row.content)).toEqual([
    "old",
    "missed",
    "later",
  ]);
});

it("offers retry on failures and rejects a non-advancing cursor without erasing readable rows", async () => {
  const h = seeded();
  const first = h.view.refresh();
  h.next().fail(new Error("offline"));
  await first;
  expect(h.view.snapshot()).toMatchObject({
    status: "error",
    root: { id: root.id },
  });
  const retry = h.view.refresh();
  await vi.waitFor(() => expect(h.pending).toHaveLength(1));
  const one = reply("one", 10);
  h.next().respond([root, one]);
  await retry;
  const more = h.view.loadMore();
  h.next().respond([root, one]);
  await more;
  expect(h.view.snapshot().error).toContain("did not advance");
  expect(h.view.snapshot().replies).toHaveLength(1);
});

it("drops stale root content when the finite root is missing and exposes explicit page limits", async () => {
  const h = seeded();
  const missing = h.view.refresh();
  h.next().respond([]);
  await missing;
  expect(h.view.snapshot().root).toBeUndefined();
  const retry = h.view.refresh();
  h.next().respond([root, reply("1", 10)]);
  await retry;
  for (let page = 2; page <= 10; page++) {
    const more = h.view.loadMore();
    h.next().respond([root, reply(String(page), page * 10)]);
    await more;
  }
  expect(h.view.snapshot()).toMatchObject({
    limited: true,
    canLoadMore: false,
  });
  await h.view.loadMore();
  expect(h.pending).toHaveLength(0);
});

it("explicitly limits oversized evidence rather than evicting aux and resurrecting deleted rows", async () => {
  const h = seeded();
  const loading = h.view.refresh();
  h.next().respond([root, reply("x".repeat(4 * 1024 * 1024), 2)]);
  await loading;
  expect(h.view.snapshot()).toMatchObject({
    status: "error",
    limited: true,
    canLoadMore: false,
    root: undefined,
    replies: [],
  });
});

it("checks live overlays against retained thread targets after shared-cache eviction, without allowing orphan or denied targets", async () => {
  const h = seeded();
  const row = reply("retained", 10);
  const first = h.view.refresh();
  h.next().respond([root, row]);
  await first;
  // Byte budget eviction with a few large, unrelated verified events.
  h.traffic.receive(
    Array.from({ length: 9 }, (_, i) =>
      message(alice, "b", "x".repeat(1024 * 1024), 100 + i),
    ),
  );
  expect(h.view.snapshot().replies[0]?.content).toBe("retained");
  const edit = signed(alice, {
    kind: 40003,
    content: "edited after eviction",
    tags: [["e", row.id]],
  });
  h.traffic.receive([edit]);
  expect(h.view.snapshot().replies[0]?.content).toBe("edited after eviction");
  h.traffic.receive([
    signed(alice, {
      kind: 5,
      content: "",
      tags: [
        ["e", row.id],
        ["e", "a".repeat(64)],
      ],
    }),
  ]);
  expect(h.view.snapshot().replies).toHaveLength(1);
  h.traffic.receive([
    signed(alice, { kind: 5, content: "", tags: [["e", row.id]] }),
  ]);
  expect(h.view.snapshot().replies).toEqual([]);
  h.traffic.receive([roster(relay, "a", [], 200)]);
  h.traffic.receive([edit]);
  const raw = h.session.read([{ ids: [edit.id], limit: 1 }]);
  h.next().respond([edit]);
  expect(await raw).toEqual([]);
  expect(h.view.snapshot().root).toBeUndefined();
});

it("keeps pre-refresh live tombstones and edits when a stale finite repair omits them", async () => {
  const h = seeded();
  const deleted = reply("deleted", 10),
    edited = reply("original", 11);
  const first = h.view.refresh();
  h.next().respond([root, deleted, edited]);
  await first;
  h.traffic.receive([
    signed(alice, { kind: 5, content: "", tags: [["e", deleted.id]] }),
    signed(alice, { kind: 40003, content: "edited", tags: [["e", edited.id]] }),
  ]);
  expect(h.view.snapshot().replies.map((row) => row.content)).toEqual([
    "edited",
  ]);
  const refresh = h.view.refresh();
  h.next().respond([root, deleted, edited]);
  await refresh;
  expect(h.view.snapshot().replies.map((row) => row.content)).toEqual([
    "edited",
  ]);
});

it("keeps deleted edits and reactions removed, including a delete-of-aux arriving before its target in a page", async () => {
  const h = seeded();
  const row = reply("original", 10);
  const edit = signed(alice, {
    kind: 40003,
    content: "edited",
    tags: [["e", row.id]],
  });
  const reaction = signed(viewer, {
    kind: 7,
    content: "+",
    tags: [["e", row.id]],
  });
  const removeEdit = signed(alice, {
    kind: 5,
    content: "",
    tags: [["e", edit.id]],
  });
  const first = h.view.refresh();
  h.next().respond([root, row, removeEdit, edit, reaction]);
  await first;
  expect(h.view.snapshot().replies[0]).toMatchObject({
    content: "original",
    reactions: [{ content: "+" }],
  });
  h.traffic.receive([
    signed(alice, { kind: 5, content: "", tags: [["e", reaction.id]] }),
  ]);
  expect(h.view.snapshot().replies[0]?.reactions).toEqual([{ content: "+" }]);
  h.traffic.receive([
    signed(viewer, { kind: 5, content: "", tags: [["e", reaction.id]] }),
  ]);
  expect(h.view.snapshot().replies[0]?.reactions).toEqual([]);
});

it("does not lose tombstones through missing-root recovery, and clears handles on cache/session disposal", async () => {
  const h = seeded();
  const row = reply("deleted", 10);
  const first = h.view.refresh();
  h.next().respond([root, row]);
  await first;
  h.traffic.receive([
    signed(alice, { kind: 5, content: "", tags: [["e", row.id]] }),
  ]);
  const missing = h.view.refresh();
  h.next().respond([]);
  await missing;
  expect(h.view.snapshot().root).toBeUndefined();
  const retry = h.view.refresh();
  h.next().respond([root, row]);
  await retry;
  expect(h.view.snapshot().root?.id).toBe(root.id);
  expect(h.view.snapshot().replies).toEqual([]);
  const pending = h.view.refresh();
  const stale = h.next();
  await h.clearCache();
  expect(stale.signal?.aborted).toBe(true);
  await pending;
  expect(h.view.snapshot().root).toBeUndefined();
  const disposed = h.view.refresh();
  const read = h.next();
  h.dispose();
  expect(read.signal?.aborted).toBe(true);
  await disposed;
  h.traffic.receive([root, row]);
  expect(h.view.snapshot().root).toBeUndefined();
});
