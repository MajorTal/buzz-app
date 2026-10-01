import { verifiedSymbol } from "nostr-tools";
import { afterEach, assert, expect, it, vi } from "vitest";
import type { ChannelQueries } from "./contracts";
import { eventVisibility } from "./event-access";
import type { ReadFilter, RelayEvent } from "./events";
import { createReadState } from "./read-state";
import { readJournal, type ReadJournal } from "./read-state-storage";
import { createUnread } from "./unread";

// Conversation lookups with thousands of events. Unread receives events the
// transport already verified, so this fixture marks them verified instead of
// signing them; signing takes seconds. Session-level tests in
// unread-startup.test.ts keep real signatures.
let next = 0;
function event(
  pubkey: string,
  kind: number,
  created_at: number,
  tags: string[][],
): RelayEvent {
  return {
    id: (next++).toString(16).padStart(64, "0"),
    pubkey,
    kind,
    created_at,
    content: "",
    tags: [["h", "c0"], ...tags],
    sig: "0".repeat(128),
    [verifiedSymbol]: true,
  };
}
const reply = (pubkey: string, time: number, parent: RelayEvent) =>
  event(pubkey, 9, time, [["e", parent.id, "", "reply"]]);
const viewer = "a".repeat(64),
  peer = "b".repeat(64);
const flood = (count: number, from: number) =>
  Array.from({ length: count }, (_, i) => event(peer, 9, from + i, []));

const owners: ReturnType<typeof createUnread>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

async function setup() {
  // A relay whose channel sample holds only the 500 newest rows, so older
  // conversation membership is reachable only by parent lookup.
  const store: RelayEvent[] = [];
  const asked: string[] = [];
  const reader = {
    read: vi.fn(async (filters: readonly ReadFilter[]) =>
      filters.flatMap((filter) => {
        if (filter.authors && filter["#e"]?.length === 1)
          asked.push(filter["#e"][0] ?? "");
        return store
          .filter(
            (item) =>
              (!filter.kinds || filter.kinds.includes(item.kind)) &&
              (!filter.ids || filter.ids.includes(item.id)) &&
              (!filter.authors || filter.authors.includes(item.pubkey)) &&
              (filter.until === undefined || item.created_at <= filter.until) &&
              (!filter["#e"] ||
                item.tags.some(
                  ([name, value]) =>
                    name === "e" && filter["#e"]?.includes(value ?? ""),
                )),
          )
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, filter.limit);
      }),
    ),
  };
  let journal: ReadJournal | undefined;
  const reads = createReadState({
    viewer,
    reader,
    host: undefined,
    storage: {
      async update(change) {
        journal = readJournal(change(journal), viewer);
        return journal;
      },
      close() {},
    },
  });
  await reads.ready;
  const channels: ChannelQueries = {
    list: () => ({
      status: "ready" as const,
      channels: [{ id: "c0", name: "Channel", members: [viewer] }],
    }),
    subscribeList: () => () => {},
    window() {
      throw new Error("Unread must not inspect windows");
    },
    subscribeWindow() {
      throw new Error("Unread must not subscribe to windows");
    },
    ensureList() {},
    ensure() {},
    loadOlder() {},
  };
  const owner = createUnread({ reads, channels, reader, viewer });
  owners.push(owner);
  const lookups = () =>
    reader.read.mock.calls.filter(
      ([[filter]]) => filter?.ids || filter?.authors,
    ).length;
  return { owner, store, asked, reader, lookups };
}

it("a lookup batch larger than the witness bound keeps every membership deletable", async () => {
  const { owner, store, asked, reader } = await setup();
  // Ten parents, each with 500 old replies of the viewer: one batch returns
  // 5,000 of the viewer's replies, more than the 4,096 witnesses unread keeps.
  const parents = Array.from({ length: 10 }, (_, i) =>
    event(peer, 9, 10 + i, []),
  );
  const mine = parents.map((parent) =>
    Array.from({ length: 500 }, (_, j) => reply(viewer, 20 + j, parent)),
  );
  const siblings = parents.map((parent, i) => reply(peer, 700 + i, parent));
  store.push(...parents, ...mine.flat());
  owner.accept(siblings);
  const attention = (i: number) => {
    const sibling = siblings[i];
    assert(sibling);
    return owner.capability.attention("c0", sibling.id);
  };
  // Ask for every parent in one turn, so they share one lookup batch.
  await vi.waitFor(() => {
    const states = parents.map((_, i) => attention(i));
    for (const state of states)
      expect(state).toMatchObject({ category: "thread", unread: true });
  });
  expect(
    reader.read.mock.calls.filter(([[filter]]) => filter?.ids),
  ).toHaveLength(1);
  // Witnessing every reply would evict the first-answered parent's replies
  // before the batch ends. Another client deletes all of them; like the
  // session, admit only deletions whose target unread can still show.
  const first = parents.findIndex((parent) => parent.id === asked[0]);
  const deleted = mine[first];
  assert(deleted);
  for (const item of deleted) store.splice(store.indexOf(item), 1);
  const visible = eventVisibility(
    () => true,
    (id) => owner.event(id),
  );
  owner.accept(
    deleted
      .map((item, i) => event(viewer, 5, 800 + i, [["e", item.id]]))
      .filter(visible),
  );
  await vi.waitFor(() => {
    expect(attention(first).pending).toBeUndefined();
    expect(attention(first)).toMatchObject({ unread: false });
  });
  expect(attention(first).category).toBeUndefined();
  for (const i of parents.keys())
    if (i !== first)
      expect(attention(i)).toMatchObject({ category: "thread", unread: true });
});

it("a later reply of the viewer outlives a negative lookup and a window reset", async () => {
  const { owner, store, lookups } = await setup();
  const root = event(peer, 9, 10, []);
  const answer = reply(peer, 700, root);
  store.push(root, answer, ...flood(499, 100));
  await owner.capability.ensure();
  const attention = () => owner.capability.attention("c0", answer.id);
  await vi.waitFor(() => {
    expect(attention().pending).toBeUndefined();
    expect(lookups()).toBeGreaterThan(0);
  });
  expect(attention().unread).toBe(false);
  // The viewer joins the conversation live, after the lookup said no.
  owner.accept([reply(viewer, 800, root)]);
  expect(attention()).toMatchObject({ category: "thread", unread: true });
  const count = lookups();
  // The overflow reset drops the live reply; the refreshed sample lacks it.
  owner.accept(flood(4096, 900));
  await owner.capability.refresh();
  expect(attention()).toMatchObject({ category: "thread", unread: true });
  expect(lookups()).toBe(count);
});

it("lookup results survive a full-window reset and refresh without asking again", async () => {
  const { owner, store, lookups } = await setup();
  const mine = event(viewer, 9, 10, []);
  const answer = reply(peer, 700, mine);
  store.push(mine, answer, ...flood(499, 100));
  await owner.capability.ensure();
  const attention = () => owner.capability.attention("c0", answer.id);
  await vi.waitFor(() => expect(attention().unread).toBe(true));
  expect(lookups()).toBeGreaterThan(0);
  const count = lookups();
  // Overflow the 4,096-event window: every channel's evidence is dropped.
  owner.accept(flood(4096, 800));
  expect(
    owner.capability.snapshot({ kind: "channel", channelId: "c0" }).freshness,
  ).toBe("stale");
  expect(attention().status).toBe("unknown");
  await owner.capability.refresh();
  expect(attention()).toMatchObject({ category: "thread", unread: true });
  expect(lookups()).toBe(count);
});
