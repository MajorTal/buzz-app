import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import type { LiveCallbacks } from "./live";
import { ReadError } from "./errors";
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

const relay = keypair(),
  viewer = keypair();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
const head = (id: string, content = `Preview ${id}`) => [
  message(viewer, id, content, 1_700_000_000),
  bounds(relay, id, "head", { has_more: false, next_cursor: null }),
];
const discovery = (ids: readonly string[]) =>
  ids.flatMap((id) => [
    roster(relay, id, [viewer.pubkey]),
    metadata(relay, id, id),
  ]);
async function setup(
  ids: string[],
  options: Parameters<typeof createRelaySession>[1] = {},
) {
  const h = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  let starred: readonly string[] = [];
  const transport = {
    ...h.transport,
    subscribe(callbacks: LiveCallbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
    decodeSidebarPreferences: async () => ({
      sections: [],
      assignments: {},
      starred,
      muted: [],
    }),
    query: vi.fn((...args: Parameters<typeof h.transport.query>) =>
      args[0].some((filter) => filter.kinds?.includes(0))
        ? Promise.resolve([profile(viewer, { name: "Viewer" })])
        : args[0].some((filter) => filter.kinds?.includes(30078))
          ? Promise.resolve([])
          : h.transport.query(...args),
    ),
  };
  const store = createRelaySession(transport, {
    prepared: true,
    warm: true,
    ...options,
  });
  owners.push(store);
  const queries = store.session.channels;
  queries.ensureList();
  h.next().respond(discovery(ids));
  await flush();
  return {
    ...h,
    store,
    queries,
    transport,
    live,
    async setStars(ids: readonly string[]) {
      starred = ids;
      await store.session.sidebarPreferences.refresh();
    },
  };
}

it.each([
  ["entry", { maxHeads: 2 }],
  ["byte", { maxHeadBytes: 2500 }],
] as const)(
  "finishes populated warming beyond the %s budget without requeueing evicted heads",
  async (_budget, options) => {
    let clock = Date.now();
    const h = await setup(["a", "b", "c"], { ...options, now: () => clock });
    for (const id of ["a", "b", "c"]) {
      expect(h.pending).toHaveLength(1);
      const request = h.next();
      expect(request.filters[0]).toMatchObject({
        "#h": [id],
        top_level: true,
        limit: 20,
      });
      request.respond(head(id));
      await flush();
    }
    expect(h.store.diagnostics().heads.entries).toBeLessThan(3);
    // Every response and its preview notification has settled; no live events or
    // reconnects are needed to provoke the old self-replenishing queue.
    expect(h.pending).toHaveLength(0);
    clock += 61_000; // Expiry is not a fresh optional obligation either.
    h.queries.refresh?.("c");
    h.next().respond(head("c", "Changed preview"));
    await flush();
    expect(
      h.queries.list().channels.find((channel) => channel.id === "c")?.preview,
    ).toBe("Changed preview");
    expect(h.pending).toHaveLength(0);
    // Eviction is not a new warm obligation, but opening that channel still reads.
    h.queries.ensure("a");
    expect(h.next().filters[0]?.["#h"]).toEqual(["a"]);
  },
);

it("finishes a 65-channel populated roster with the production cache limits", async () => {
  const ids = Array.from(
    { length: 65 },
    (_, index) => `channel-${String(index).padStart(2, "0")}`,
  );
  const h = await setup(ids);
  for (const id of ids) {
    expect(h.pending).toHaveLength(1);
    const request = h.next();
    expect(request.filters[0]?.["#h"]).toEqual([id]);
    request.respond(head(id));
    await flush();
  }
  expect(h.store.diagnostics().heads.entries).toBe(64);
  expect(h.pending).toHaveLength(0);
});

it("warms newly eligible channels and updates queued starred-first ordering without restarting completed work", async () => {
  const h = await setup(["a", "b", "c"], { maxHeads: 1 });
  const first = h.next();
  await h.setStars(["c"]);
  first.respond(head("a"));
  await flush();
  expect(h.pending[0]?.filters[0]?.["#h"]).toEqual(["c"]);
  h.next().respond(head("c"));
  await flush();
  expect(h.pending[0]?.filters[0]?.["#h"]).toEqual(["b"]);
  h.next().respond(head("b"));
  await flush();
  expect(h.pending).toHaveLength(0);
  h.queries.refreshList?.();
  h.next().respond(discovery(["a", "b", "c", "d"]));
  await flush();
  expect(h.pending).toHaveLength(1);
  expect(h.pending[0]?.filters[0]?.["#h"]).toEqual(["d"]);
  h.next().respond(head("d"));
  await flush();
  expect(h.pending).toHaveLength(0);
});

it("does not automatically retry a failed optional head when another preview changes", async () => {
  const h = await setup(["a", "b"]);
  h.next().fail(new Error("Head unavailable"));
  await vi.waitFor(() => expect(h.pending).toHaveLength(1));
  expect(h.pending[0]?.filters[0]?.["#h"]).toEqual(["b"]);
  h.next().respond(head("b"));
  await flush();
  expect(h.pending).toHaveLength(0);
  h.queries.ensure("a");
  expect(h.pending[0]?.filters[0]?.["#h"]).toEqual(["a"]);
  h.next().respond(head("a"));
  await flush();
  expect(h.queries.window("a").status).toBe("ready");
});

it.each(["clear", "dispose"])(
  "does not resurrect queued warming after in-flight %s",
  async (boundary) => {
    const h = await setup(["a", "b"]);
    const first = h.next();
    if (boundary === "clear") await h.store.clearCache();
    else h.store.dispose();
    expect(first.signal?.aborted).toBe(true);
    first.respond(head("a"));
    await flush();
    expect(h.pending).toHaveLength(0);
    expect(h.store.diagnostics().heads.entries).toBe(0);
    if (boundary === "clear") {
      await h.store.session.sidebarPreferences.ensure();
      expect(h.pending[0]?.filters[0]?.["#h"]).toEqual(["a"]);
      h.next().respond(head("a"));
      await flush();
      h.next().respond(head("b"));
      await flush();
      expect(h.pending).toHaveLength(0);
    }
  },
);

it.each(["a", "b"])(
  "drops revoked in-flight/queued work and rewarms %s after regrant",
  async (revoked) => {
    const h = await setup(["a", "b", "c"]);
    const first = h.next();
    // Revocation cancels all reads; neither that response nor preview changes
    // may restart the consumed candidate. Other queued eligible work can finish.
    const removed = roster(relay, revoked, [], 1_700_000_001);
    h.live.receive([removed]);
    expect(first.signal?.aborted).toBe(true);
    first.respond(head("a"));
    await flush();
    for (const id of revoked === "a" ? ["b", "c"] : ["c"]) {
      expect(h.pending[0]?.filters[0]?.["#h"]).toEqual([id]);
      h.next().respond(head(id));
      await flush();
    }
    expect(h.pending).toHaveLength(0);
    expect(
      h.queries.list().channels.some((channel) => channel.id === revoked),
    ).toBe(false);
    const added = roster(relay, revoked, [viewer.pubkey], 1_700_000_002);
    h.live.receive([added]);
    expect(h.pending[0]?.filters[0]?.["#h"]).toEqual([revoked]);
    h.next().respond(head(revoked));
    await flush();
    expect(h.pending).toHaveLength(0);
  },
);

it("warms an archived channel only after it becomes starred", async () => {
  const h = await setup([]);
  h.queries.refreshList?.();
  h.next().respond([
    roster(relay, "a", [viewer.pubkey]),
    signed(relay, {
      kind: 39000,
      content: JSON.stringify({ name: "a", archived: true }),
      tags: [
        ["d", "a"],
        ["name", "a"],
        ["archived", "true"],
      ],
    }),
  ]);
  await flush();
  expect(h.pending).toHaveLength(0);
  await h.setStars(["a"]);
  expect(h.pending[0]?.filters[0]?.["#h"]).toEqual(["a"]);
  h.next().respond(head("a"));
  await flush();
  expect(h.pending).toHaveLength(0);
});

it("forgets warming eligibility after authoritative roster denial, then permits regrant", async () => {
  const h = await setup(["a", "b"]);
  const first = h.next();
  h.queries.refreshList?.();
  h.next().fail(new ReadError("denied", "Roster denied"));
  await vi.waitFor(() => expect(h.queries.list().status).toBe("error"));
  expect(first.signal?.aborted).toBe(true);
  first.respond(head("a"));
  await flush();
  expect(h.pending).toHaveLength(0);
  expect(h.store.diagnostics().heads.entries).toBe(0);
  h.live.receive([roster(relay, "a", [viewer.pubkey], 1_700_000_002)]);
  await vi.waitFor(() => expect(h.pending).toHaveLength(1));
  expect(h.pending[0]?.filters[0]?.["#h"]).toEqual(["a"]);
  h.next().respond(head("a"));
  await flush();
  expect(h.pending).toHaveLength(0);
});

it("drops an archived queued channel, then warms it after unarchiving", async () => {
  const h = await setup(["a", "b"]);
  const first = h.next();
  h.live.receive([
    signed(relay, {
      kind: 39000,
      content: JSON.stringify({ name: "b" }),
      created_at: 1_700_000_001,
      tags: [
        ["d", "b"],
        ["name", "b"],
        ["archived", "true"],
      ],
    }),
  ]);
  first.respond(head("a"));
  await flush();
  expect(h.pending).toHaveLength(0);
  h.live.receive([metadata(relay, "b", "b", 1_700_000_002)]);
  expect(h.pending[0]?.filters[0]?.["#h"]).toEqual(["b"]);
  h.next().respond(head("b"));
  await flush();
  expect(h.pending).toHaveLength(0);
});
