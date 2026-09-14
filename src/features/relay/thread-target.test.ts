import { afterEach, expect, it } from "vitest";
import { createRelaySession } from "./session";
import { ReadError } from "./errors";
import type { RelayEvent } from "./events";
import type { LiveCallbacks } from "./live";
import {
  bounds,
  flush,
  keypair,
  message,
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
const root = message(alice, "a", "Old root", 1);
const reply = message(alice, "a", "Selected reply", 10000, [
  ["e", root.id, "", "reply"],
]);
const aux = (kind: number, target: RelayEvent, content = "", time = 10001) =>
  signed(alice, { kind, content, created_at: time, tags: [["e", target.id]] });
function setup(id = reply.id) {
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
  return {
    ...wire,
    ...owner,
    traffic,
    view: owner.session.thread("a", id, { exact: true }),
  };
}
async function targetRead(
  h: ReturnType<typeof setup>,
  target = reply,
  overlays: RelayEvent[] = [],
) {
  const loading = h.view.refresh();
  h.next().respond([target]);
  await flush();
  h.next().respond(overlays);
  await flush();
  if (overlays.length) {
    h.next().respond([]);
    await flush();
  }
  return { loading };
}

it("retains the selected reply beyond traversal limits without using it as a cursor or channel history", async () => {
  const h = setup();
  h.traffic.receive([roster(relay, "a", [viewer.pubkey])]);
  h.session.channels.ensure("a");
  const head = message(alice, "a", "Head", 20000);
  h.next().respond([
    head,
    bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
  ]);
  await flush();
  for (const pending of h.pending.splice(0)) pending.respond([]);
  const { loading } = await targetRead(h, reply, [
    aux(40003, reply, "Edited target"),
  ]);
  h.next().respond([
    root,
    message(alice, "a", "First reply", 2, [["e", root.id, "", "reply"]]),
  ]);
  await loading;
  expect(h.view.snapshot().target).toMatchObject({
    id: reply.id,
    content: "Edited target",
  });
  expect(h.view.snapshot().replies.map((row) => row.content)).toEqual([
    "First reply",
    "Edited target",
  ]); // Unrelated top-level seed events must not become replies before root resolution.
  for (let page = 2; page <= 10; page++) {
    const more = h.view.loadMore();
    const request = h.next();
    expect(request.filters[1]?.thread_cursor).toBe(page);
    request.respond([
      root,
      message(alice, "a", `Reply ${page}`, page + 1, [
        ["e", root.id, "", "reply"],
      ]),
    ]);
    await more;
  }
  expect(h.view.snapshot()).toMatchObject({
    limited: true,
    canLoadMore: false,
    targetStatus: "ready",
    target: { id: reply.id },
  });
  expect(h.session.channels.window("a").rows.map((row) => row.id)).toEqual([
    head.id,
  ]);
});

it("folds reference-only edits and deletes of overlays before exposing the target", async () => {
  const h = setup();
  const loading = h.view.refresh();
  h.next().respond([reply]);
  await flush();
  const edit = aux(40003, reply, "Edited"),
    reaction = aux(7, reply, "+");
  const overlays = h.next();
  expect(overlays.filters[0]?.["#h"]).toBeUndefined();
  overlays.respond([edit, reaction]);
  await flush();
  expect(h.view.snapshot().target).toBeUndefined();
  h.next().respond([aux(5, reaction)]);
  await flush();
  h.next().respond([root]);
  await loading;
  expect(h.view.snapshot().target).toMatchObject({
    content: "Edited",
    reactions: [],
  });
  h.traffic.receive([aux(5, edit)]);
  expect(h.view.snapshot().target?.content).toBe(reply.content);
  h.traffic.receive([aux(5, reply)]);
  expect(h.view.snapshot()).toMatchObject({
    targetStatus: "unavailable",
    target: undefined,
  });
});

it("keeps an accessible reply when the original is unavailable, without a composer root", async () => {
  const h = setup();
  const { loading } = await targetRead(h);
  h.next().respond([]);
  await loading;
  expect(h.view.snapshot()).toMatchObject({
    root: undefined,
    targetStatus: "ready",
    target: { id: reply.id },
  });
  expect(h.view.snapshot().replies.map((row) => row.id)).toEqual([reply.id]);
});

it("keeps a fetched root in the existing thread surface", async () => {
  const h = setup(root.id);
  const { loading } = await targetRead(h, root);
  h.next().respond([root]);
  await loading;
  expect(h.view.snapshot()).toMatchObject({
    root: { id: root.id },
    target: { id: root.id },
    targetStatus: "ready",
  });
});

it("distinguishes absent targets and failed lookup, then permits explicit retry", async () => {
  const h = setup();
  const missing = h.view.refresh();
  h.next().respond([]);
  await missing;
  expect(h.view.snapshot().targetStatus).toBe("unavailable");
  const failed = h.view.refresh();
  h.next().fail(new Error("offline"));
  await failed;
  expect(h.view.snapshot().targetStatus).toBe("error");
  await flush();
  const { loading } = await targetRead(h);
  h.next().respond([root]);
  await loading;
  expect(h.view.snapshot().target?.id).toBe(reply.id);
});

it("rejects a capped raw overlay response before visibility filtering hides its size", async () => {
  const h = setup();
  const reading = h.view.refresh();
  h.next().respond([reply]);
  await flush();
  const other = message(alice, "private", "Hidden", 2);
  h.next().respond(
    Array.from({ length: 500 }, (_, i) => aux(7, other, `${i}`)),
  );
  await reading;
  expect(h.view.snapshot()).toMatchObject({
    targetStatus: "error",
    target: undefined,
  });
});

it("retains target tombstones across sparse refresh and shared-cache eviction", async () => {
  const h = setup();
  const edit = aux(40003, reply, "Edited");
  const { loading } = await targetRead(h, reply, [edit]);
  h.next().respond([root]);
  await loading;
  h.traffic.receive(
    Array.from({ length: 140 }, (_, i) =>
      message(alice, "b", `${i}${"x".repeat(65536)}`, i + 20),
    ),
  );
  h.traffic.receive([aux(5, edit)]);
  expect(h.view.snapshot().target?.content).toBe(reply.content);
  h.traffic.receive([aux(5, reply)]);
  const again = h.view.refresh();
  h.next().respond([reply]);
  await flush();
  h.next().respond([]);
  await flush();
  h.next().respond([]);
  await again;
  expect(h.view.snapshot()).toMatchObject({
    targetStatus: "unavailable",
    target: undefined,
  });
});

it("seeds already observed tombstones rather than resurrecting a selected row", async () => {
  const h = setup();
  h.view.dispose();
  h.traffic.receive([reply, aux(5, reply)]);
  const view = h.session.thread("a", reply.id, { exact: true });
  const reading = view.refresh();
  h.next().respond([reply]);
  await flush();
  h.next().respond([]);
  await flush();
  h.next().respond([]);
  await reading;
  expect(view.snapshot()).toMatchObject({
    targetStatus: "unavailable",
    target: undefined,
  });
});

it("revokes the channel after a denied reference-only read and fences late access-lost results", async () => {
  const h = setup();
  h.traffic.receive([roster(relay, "a", [viewer.pubkey], 10)]);
  const reading = h.view.refresh();
  h.next().respond([reply]);
  await flush();
  h.next().fail(new ReadError("denied", "denied"));
  await reading;
  expect(h.session.channels.list().channels).toEqual([]);
  expect(h.view.snapshot().target).toBeUndefined();
  h.traffic.receive([roster(relay, "a", [viewer.pubkey], 11)]);
  expect(
    h.session.channels.list().channels.map((channel) => channel.id),
  ).toEqual(["a"]);
  const retry = h.view.refresh();
  // The shared scheduler yields to the host after a failed transport read.
  await flush();
  h.next().respond([reply]);
  await flush();
  const held = h.next();
  h.traffic.receive([roster(relay, "a", [], 12)]);
  expect(held.signal?.aborted).toBe(true);
  held.respond([]);
  await retry;
  expect(h.view.snapshot().target).toBeUndefined();
});

it("disposes held exact reads and purges loaded targets on cache clear", async () => {
  const h = setup();
  const reading = h.view.refresh();
  const held = h.next();
  h.view.dispose();
  expect(held.signal?.aborted).toBe(true);
  held.respond([reply]);
  await reading;
  expect(h.view.snapshot().target).toBeUndefined();
  const next = setup();
  const { loading } = await targetRead(next);
  next.next().respond([root]);
  await loading;
  await next.clearCache();
  expect(next.view.snapshot().target).toBeUndefined();
});

it("seeds a retained deletion after its selected target was evicted from the shared cache", async () => {
  const h = setup();
  h.view.dispose();
  h.traffic.receive([reply]);
  const noise = Array.from({ length: 140 }, (_, i) =>
    message(alice, "b", `${i}${"x".repeat(65536)}`, i + 20),
  );
  h.traffic.receive(noise.slice(0, 100));
  // Still-resolvable deletion is newer in the LRU than its original content.
  h.traffic.receive([aux(5, reply)]);
  h.traffic.receive(noise.slice(100)); // >8 MiB evicts the target, not this tombstone.
  const view = h.session.thread("a", reply.id, { exact: true });
  const reading = view.refresh();
  h.next().respond([reply]);
  await flush();
  h.next().respond([]); // Sparse relay read omits the already-observed deletion.
  await flush();
  const tombstones = h.next();
  expect(tombstones.filters[0]?.kinds).toEqual([5, 9005]);
  tombstones.respond([]);
  await reading;
  expect(view.snapshot()).toMatchObject({
    targetStatus: "unavailable",
    target: undefined,
  });
});

it("retains verified rows throughout repair and keeps valid context when the selected reply is deleted", async () => {
  const h = setup();
  const sibling = message(alice, "a", "Sibling", 2, [
    ["e", root.id, "", "reply"],
  ]);
  const { loading } = await targetRead(h);
  h.next().respond([root, sibling]);
  await loading;
  const repairing = h.view.refresh();
  expect(h.view.snapshot()).toMatchObject({
    status: "loading",
    root: { id: root.id },
    target: { id: reply.id },
    targetStatus: "ready",
  });
  expect(h.view.snapshot().replies.map((row) => row.id)).toEqual([
    sibling.id,
    reply.id,
  ]);
  h.next().respond([reply]);
  await flush();
  h.next().respond([]);
  await flush();
  h.next().respond([root, sibling]);
  await repairing;
  h.traffic.receive([aux(5, reply)]);
  expect(h.view.snapshot()).toMatchObject({
    root: { id: root.id },
    target: undefined,
    targetStatus: "unavailable",
  });
  expect(h.view.snapshot().replies.map((row) => row.id)).toEqual([sibling.id]);
});

for (const outcome of ["deleted", "failed", "live withdrawal"] as const) {
  it(`keeps the last safe selected fold through held repair overlays: ${outcome}`, async () => {
    const h = setup();
    const { loading } = await targetRead(h);
    h.next().respond([root]);
    await loading;
    const repair = h.view.refresh();
    h.next().respond([reply]);
    await flush();
    const edit = aux(40003, reply, "Unsafe intermediate edit");
    h.next().respond([edit]);
    await flush();
    const held = h.next();
    expect(held.filters[0]?.kinds).toEqual([5, 9005]);
    expect(h.view.snapshot().target?.content).toBe(reply.content);
    expect(h.view.snapshot().replies[0]?.content).toBe(reply.content);
    if (outcome === "failed") held.fail(new Error("offline"));
    else {
      if (outcome === "live withdrawal") {
        h.traffic.receive([aux(5, edit)]); // Resolve against staged evidence without exposing it.
        h.traffic.receive([aux(5, reply)]);
        expect(h.view.snapshot().target).toBeUndefined();
      }
      held.respond([aux(5, edit)]);
      await flush();
      if (outcome !== "live withdrawal") h.next().respond([root]);
    }
    await repair;
    if (outcome === "live withdrawal") {
      expect(h.view.snapshot().targetStatus).toBe("unavailable");
    } else {
      expect(h.view.snapshot().target?.content).toBe(reply.content);
      expect(h.view.snapshot().replies[0]?.content).toBe(reply.content);
    }
  });
}

it("never retains a selected reply rejected by the shared dual-channel access gate", async () => {
  const denied = message(alice, "a", "Forbidden dual-tag reply", 3, [
    ["h", "b"],
    ["e", root.id, "", "reply"],
  ]);
  const h = setup(denied.id);
  h.traffic.receive([
    roster(relay, "a", [viewer.pubkey]),
    roster(relay, "b", []),
  ]);
  const reading = h.view.refresh();
  h.next().respond([denied]);
  await reading;
  expect(h.view.snapshot()).toMatchObject({
    targetStatus: "unavailable",
    target: undefined,
    replies: [],
  });
  expect(h.pending).toHaveLength(0); // No overlay/traversal can authorize rejected content.
  h.traffic.receive([root]);
  expect(h.view.snapshot().target).toBeUndefined();
  expect(h.view.snapshot().replies).toEqual([]);
});
