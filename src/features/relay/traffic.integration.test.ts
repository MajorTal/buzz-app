import { assert, afterEach, expect, it, vi } from "vitest";
import type { EventTemplate } from "nostr-tools";
import { writeProfile } from "./profiling-test";
import { createRelaySession } from "./session";
import { createRelayProfiler } from "./profiling";
import { PublishRejected, type OutgoingEvent } from "./outbox";
import type { RelayEvent } from "./events";
import {
  bounds,
  flush,
  keypair,
  message,
  metadata,
  profile,
  roster,
  signed,
} from "./testing";

const viewer = keypair(),
  relay = keypair(),
  other = keypair();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(
  history: RelayEvent[] = [],
  options: import("./store").ChannelStoreOptions = {},
) {
  let clock = 0;
  const profiling = createRelayProfiler(() => clock);
  let records: readonly OutgoingEvent[] = [];
  const storage = {
    load: () => structuredClone(records),
    save: (items: readonly OutgoingEvent[]) => {
      records = structuredClone(items);
    },
  };
  const signings: {
    input: EventTemplate;
    result: ReturnType<typeof deferred<RelayEvent>>;
  }[] = [];
  const publications: {
    event: RelayEvent;
    result: ReturnType<typeof deferred<void>>;
  }[] = [];
  let resetTraffic = () => {};
  let incoming!: (events: readonly RelayEvent[]) => void;
  const stop = vi.fn();
  const accepted = new Map<string, RelayEvent>();
  let stale: ReturnType<typeof deferred<RelayEvent[]>> | undefined;
  const transport = {
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    profiling,
    media: () => undefined,
    subscribe(callbacks: import("./live").LiveCallbacks) {
      incoming = callbacks.receive;
      resetTraffic = () => {
        callbacks.state({ status: "connected", routes: [] });
        callbacks.state({ status: "retrying", routes: [] });
        callbacks.state({ status: "connected", routes: [] });
        callbacks.established();
      };
      return { update() {}, retry() {}, dispose: stop };
    },
    writer: {
      sign(input: EventTemplate) {
        const result = deferred<RelayEvent>();
        signings.push({ input, result });
        return result.promise;
      },
      publish(event: RelayEvent) {
        const result = deferred<void>();
        publications.push({ event, result });
        return result.promise;
      },
    },
    async query(filters: readonly import("./events").ReadFilter[]) {
      const filter = filters[0];
      assert.exists(filter);
      if (filter.ids) return filter.ids.flatMap((id) => accepted.get(id) ?? []);
      if (filter.kinds?.includes(0))
        return [
          profile(viewer, { name: "You" }),
          profile(other, { name: "Other" }),
        ];
      if (filter.kinds?.includes(39002) || filter.kinds?.includes(39000))
        return [
          roster(relay, "c", [viewer.pubkey]),
          metadata(relay, "c", "General"),
          roster(relay, "other", [viewer.pubkey]),
          metadata(relay, "other", "Other"),
        ];
      if (stale) {
        const pending = stale;
        stale = undefined;
        return pending.promise;
      }
      const channelId = filter["#h"]?.[0] ?? "c";
      const candidates = history
        .filter((event) =>
          event.tags.some((tag) => tag[0] === "h" && tag[1] === channelId),
        )
        .filter(
          (event) =>
            filter.until === undefined ||
            event.created_at < filter.until ||
            (event.created_at === filter.until &&
              event.id > (filter.before_id ?? "")),
        )
        .sort(
          (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
        );
      const page = candidates.slice(0, filter.limit);
      const last = page.at(-1);
      const hasMore = candidates.length > page.length;
      const suffix =
        filter.until === undefined
          ? "head"
          : `${filter.until}:${filter.before_id}`;
      if (!filter.include_aux) return page;
      return [
        ...page,
        bounds(relay, channelId, suffix, {
          has_more: hasMore,
          next_cursor:
            hasMore && last
              ? { created_at: last.created_at, id: last.id }
              : null,
        }),
      ];
    },
  };
  const owner = createRelaySession(transport, {
    ...options,
    outboxStorage: storage,
  });
  owners.push(owner);
  return {
    ...owner,
    transport,
    storage,
    profiling,
    signings,
    publications,
    accepted,
    stop,
    advance: (ms: number) => {
      clock += ms;
    },
    emit: (events: readonly RelayEvent[]) => incoming(events),
    reconnect: () => resetTraffic(),
    staleRead: () => (stale = deferred<RelayEvent[]>()),
    async open() {
      owner.session.channels.ensureList();
      await flush();
      owner.session.channels.ensure("c");
      await flush();
      await flush();
    },
    async sign() {
      await flush();
      const pending = signings.shift();
      assert.exists(pending);
      const event = signed(viewer, pending.input);
      pending.result.resolve(event);
      await flush();
      return event;
    },
    async acknowledge(event: RelayEvent) {
      accepted.set(event.id, event);
      const publication = publications.shift();
      assert.exists(publication);
      publication.result.resolve();
      await flush();
      await flush();
    },
  };
}

it("uses whole-thread totals from window summaries and live additions/deletions without loading replies", async () => {
  const root = message(other, "c", "root", 10);
  const summary = (total: number, at: number, author = relay) =>
    signed(author, {
      kind: 39005,
      created_at: at,
      tags: [
        ["h", "c"],
        ["e", root.id],
        ["d", root.id],
      ],
      content: JSON.stringify({
        reply_count: 1,
        descendant_count: total,
        participants: [other.pubkey],
      }),
    });
  const initial = summary(3, 20);
  const h = fixture([root, initial]);
  await h.open();
  const row = () => h.session.channels.window("c").rows[0];
  expect(row()?.replyCount).toBe(3);
  const before = row();
  h.emit([summary(4, 21)]);
  expect(row()?.replyCount).toBe(4);
  expect(row()).not.toBe(before);
  h.emit([summary(2, 22)]);
  expect(row()?.replyCount).toBe(2);
  h.emit([initial, summary(99, 23, other)]);
  expect(row()?.replyCount).toBe(2);
  h.emit([summary(0, 24)]);
  expect(row()?.replyCount).toBe(0);
  expect(h.session.channels.window("c").rows).toHaveLength(1);
});

it("attributes a slow first send to signing and publish acknowledgement, independently of read-back", async () => {
  const h = fixture();
  await h.open();
  const id = h.session.messages.send("c", "first");
  expect(h.session.channels.window("c").rows.at(-1)?.id).toBe(id);
  await flush();
  h.advance(700);
  expect(h.profiling.snapshot()).toContainEqual(
    expect.objectContaining({
      stage: "send.sign",
      id,
      duration: 700,
      outcome: "pending",
    }),
  );
  const event = await h.sign();
  h.advance(2300);
  expect(h.profiling.snapshot()).toContainEqual(
    expect.objectContaining({
      stage: "send.publish",
      id,
      duration: 2300,
      outcome: "pending",
    }),
  );
  await h.acknowledge(event);
  assert.exists(h.session.outbox);
  expect(h.session.outbox.snapshot()).toHaveLength(0);
  expect(h.session.channels.window("c").rows.at(-1)?.delivery).toBe("seen");
  const stages = h.profiling.snapshot().filter((sample) => sample.id === id);
  expect(stages).toContainEqual(
    expect.objectContaining({
      stage: "send.sign",
      duration: 700,
      outcome: "ok",
    }),
  );
  expect(stages).toContainEqual(
    expect.objectContaining({
      stage: "send.publish",
      duration: 2300,
      outcome: "ok",
    }),
  );
  const nextId = h.session.messages.send("c", "second");
  const next = await h.sign();
  await h.acknowledge(next);
  expect(h.profiling.snapshot()).toContainEqual(
    expect.objectContaining({ stage: "send.publish", id: nextId, duration: 0 }),
  );
  expect(JSON.stringify(h.profiling.snapshot())).not.toContain('"content"');
});

it("keeps send and acknowledgement work proportional to the changed message in a 2,400-row history", async () => {
  const history = Array.from({ length: 2400 }, (_, index) =>
    message(other, "c", `History ${index}`, 1700000000 + index),
  );
  const h = fixture(history);
  await h.open();
  while (h.session.channels.window("c").hasMore) {
    h.session.channels.loadOlder("c");
    await flush();
  }
  expect(h.session.channels.window("c").rows).toHaveLength(2400);
  const before = h.session.channels.window("c").rows;
  const unrelated = h.session.observe([
    { kinds: [9], "#h": ["other"], limit: 80 },
  ]);
  const unrelatedSnapshot = unrelated.snapshot();
  const render = vi.fn(),
    sidebar = vi.fn();
  unrelated.subscribe(render);
  h.session.channels.subscribeList(sidebar);
  h.profiling.clear();
  const start = performance.now();
  const id = h.session.messages.send("c", "new");
  const duration = performance.now() - start;
  expect(
    h.session.channels
      .window("c")
      .rows.slice(0, 2400)
      .every((row, index) => row === before[index]),
  ).toBe(true);
  const folds = () =>
    h.profiling
      .snapshot()
      .filter((sample) => sample.stage === "view.fold")
      .reduce((sum, sample) => sum + (sample.count ?? 0), 0);
  expect(folds()).toBe(1);
  const event = await h.sign();
  await h.acknowledge(event);
  expect(folds()).toBe(1);
  expect(
    h.session.channels.window("c").rows.find((row) => row.id === id)?.delivery,
  ).toBe("seen");
  expect(sidebar).toHaveBeenCalledTimes(1);
  expect(render).not.toHaveBeenCalled();
  expect(unrelated.snapshot()).toBe(unrelatedSnapshot);
  // Keep timing as diagnostic evidence; deterministic work/identity assertions
  // above enforce correctness without depending on runner speed.
  writeProfile("history", h.profiling, {
    synchronousSendMs: duration,
    retainedRows: 2400,
    foldedMessages: folds(),
  });
  console.info(
    `relay integration: 2400 retained rows; synchronous send ${duration.toFixed(2)} ms; folded messages ${folds()}`,
  );
}, 20000);

it("merges incoming traffic, stale reads, own echoes, and edit rollback through the same views", async () => {
  const h = fixture();
  await h.open();
  const view = h.session.observe([{ kinds: [9], "#h": ["c"], limit: 80 }]);
  const stale = h.staleRead();
  assert.exists(h.session.channels.refresh);
  h.session.channels.refresh("c");
  await flush();
  const remote = message(other, "c", "arrived during read", 1700000001);
  h.emit([remote]);
  expect(view.snapshot().events.some((event) => event.id === remote.id)).toBe(
    true,
  );
  stale.resolve([
    bounds(relay, "c", "head", { has_more: false, next_cursor: null }),
  ]);
  await flush();
  expect(
    h.session.channels.window("c").rows.some((row) => row.id === remote.id),
  ).toBe(true);
  const id = h.session.messages.send("c", "mine");
  const event = await h.sign();
  h.emit([event]);
  const latePublication = h.publications.shift();
  assert.exists(latePublication);
  latePublication.result.reject(new Error("lost ACK"));
  await flush();
  assert.exists(h.session.outbox);
  expect(h.session.outbox.snapshot()).toHaveLength(0);
  expect(view.snapshot().events.filter((item) => item.id === id)).toHaveLength(
    1,
  );
  const edit = h.session.messages.edit(id, "edited", id);
  expect(
    h.session.channels.window("c").rows.find((row) => row.id === id)?.content,
  ).toBe("edited");
  await h.sign();
  const editPublication = h.publications.shift();
  assert.exists(editPublication);
  editPublication.result.reject(new PublishRejected("denied"));
  await flush();
  expect(
    h.session.outbox.snapshot().find((item) => item.event.id === edit)
      ?.delivery,
  ).toBe("failed");
  expect(
    h.session.channels.window("c").rows.find((row) => row.id === id)?.content,
  ).toBe("mine");
  const snapshot = view.snapshot();
  h.dispose();
  h.emit([message(other, "c", "late", 1700000002)]);
  expect(view.snapshot()).toBe(snapshot);
  expect(h.stop).toHaveBeenCalledTimes(1);
});

it("removes a visible h-less reaction when its owner deletion arrives from live traffic", async () => {
  const root = message(other, "c", "reacted", 1);
  const reactor = keypair();
  const intruder = keypair();
  const reaction = signed(reactor, {
    kind: 7,
    content: "+",
    created_at: 2,
    tags: [["e", root.id]],
  });
  const h = fixture([root]);
  await h.open();
  h.emit([reaction]);
  expect(h.session.channels.window("c").rows).toMatchObject([
    { id: root.id, reactions: [{ content: "+" }] },
  ]);

  h.emit([
    signed(intruder, {
      kind: 5,
      content: "",
      created_at: 3,
      tags: [["e", reaction.id]],
    }),
  ]);
  expect(h.session.channels.window("c").rows).toMatchObject([
    { id: root.id, reactions: [{ content: "+" }] },
  ]);

  h.emit([
    signed(reactor, {
      kind: 5,
      content: "",
      created_at: 4,
      tags: [["e", reaction.id]],
    }),
  ]);

  expect(h.session.channels.window("c").rows).toMatchObject([
    { id: root.id, reactions: [] },
  ]);
});

it("applies a h-less reaction deletion delivered in the same live batch", async () => {
  const root = message(other, "c", "same batch", 1);
  const reactor = keypair();
  const reaction = signed(reactor, {
    kind: 7,
    content: "+",
    created_at: 2,
    tags: [["e", root.id]],
  });
  const remove = signed(reactor, {
    kind: 5,
    content: "",
    created_at: 3,
    tags: [["e", reaction.id]],
  });
  const h = fixture([root]);
  await h.open();

  h.emit([remove, reaction]);

  expect(h.session.channels.window("c").rows).toMatchObject([
    { id: root.id, reactions: [] },
  ]);
});

it("preserves more than 64 direct reactions when one reaction is deleted", async () => {
  const root = message(other, "c", "busy", 1);
  const reactor = keypair();
  const reactions = Array.from({ length: 70 }, (_, index) =>
    signed(reactor, {
      kind: 7,
      content: `+${index}`,
      created_at: 2 + index,
      tags: [["e", root.id]],
    }),
  );
  const h = fixture([root]);
  await h.open();
  h.emit(reactions);
  expect(h.session.channels.window("c").rows[0]?.reactions).toHaveLength(70);

  h.emit([
    signed(reactor, {
      kind: 5,
      content: "",
      created_at: 100,
      tags: [["e", reactions[69]?.id ?? ""]],
    }),
  ]);

  const contents = h.session.channels
    .window("c")
    .rows[0]?.reactions.map((reaction) => reaction.content);
  expect(contents).toHaveLength(69);
  expect(contents).toContain("+0");
  expect(contents).toContain("+68");
  expect(contents).not.toContain("+69");
});

it("restores content when an h-less owner deletion targets a live edit", async () => {
  const root = message(other, "c", "original", 1);
  const edit = signed(other, {
    kind: 40003,
    content: "edited",
    created_at: 2,
    tags: [["e", root.id]],
  });
  const h = fixture([root]);
  await h.open();
  h.emit([edit]);
  expect(h.session.channels.window("c").rows).toMatchObject([
    { id: root.id, content: "edited", edited: true },
  ]);

  h.emit([
    signed(keypair(), {
      kind: 5,
      content: "",
      created_at: 3,
      tags: [["e", edit.id]],
    }),
  ]);
  expect(h.session.channels.window("c").rows).toMatchObject([
    { id: root.id, content: "edited", edited: true },
  ]);

  h.emit([
    signed(other, {
      kind: 5,
      content: "",
      created_at: 4,
      tags: [["e", edit.id]],
    }),
  ]);
  expect(h.session.channels.window("c").rows).toMatchObject([
    { id: root.id, content: "original" },
  ]);
  expect(h.session.channels.window("c").rows[0]).not.toHaveProperty("edited");
});

it("automatically retires more than 256 confirmed writes and restores confirmed evidence without publishing", async () => {
  const h = fixture();
  const events: RelayEvent[] = [];
  for (let index = 0; index < 270; index++) {
    h.session.messages.send("c", `message ${index}`);
    const event = await h.sign();
    events.push(event);
    await h.acknowledge(event);
  }
  assert.exists(h.session.outbox);
  expect(h.session.outbox.snapshot()).toHaveLength(0);
  h.dispose();
  const restored = createRelaySession(h.transport, {
    outboxStorage: h.storage,
  });
  owners.push(restored);
  assert.exists(restored.session.outbox);
  expect(restored.session.outbox.snapshot()).toHaveLength(0);
  const view = restored.session.observe([
    { kinds: [9], "#h": ["c"], limit: 80 },
  ]);
  expect(view.snapshot().events).toHaveLength(270);
  expect(h.publications).toHaveLength(0);
  expect(
    view.snapshot().events.find((event) => event.id === events[0]?.id)
      ?.delivery,
  ).toBe("seen");
}, 20000);

it("persists queued intent even if the session closes before asynchronous storage hydration", async () => {
  const load = deferred<readonly OutgoingEvent[]>();
  let saved: readonly OutgoingEvent[] = [];
  const sign = vi.fn();
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      query: async () => [],
      writer: { sign, publish: vi.fn() },
    },
    {
      outboxStorage: {
        load: () => load.promise,
        save: (records) => {
          saved = records;
        },
      },
    },
  );
  const id = owner.session.messages.send("c", "queued before hydration");
  owner.dispose();
  load.resolve([]);
  await flush();
  await flush();
  expect(saved.some((item) => item.event.id === id)).toBe(true);
  expect(sign).not.toHaveBeenCalled();
});

it("continues incoming traffic at the history budget and applies live membership revocation", async () => {
  const h = fixture(
    [message(other, "c", "one", 1), message(other, "c", "two", 2)],
    { maxHistoryRows: 2 },
  );
  await h.open();
  const third = message(other, "c", "three", 3);
  h.emit([third]);
  expect(h.session.channels.window("c").rows.map((row) => row.content)).toEqual(
    ["two", "three"],
  );
  expect(h.session.channels.window("c").historyLimited).toBe(true);
  h.emit([roster(relay, "c", [], 1800000000)]);
  expect(h.session.channels.window("c").rows).toHaveLength(0);
  h.emit([message(other, "c", "late revoked traffic", 4)]);
  expect(h.session.channels.window("c").rows).toHaveLength(0);
});

it("keeps an inactive channel preview and its next window consistent with incoming traffic", async () => {
  const h = fixture([], { maxWindows: 1 });
  await h.open();
  const remote = message(other, "other", "new in another channel", 10);
  h.emit([remote]);
  expect(
    h.session.channels.list().channels.find((channel) => channel.id === "other")
      ?.preview,
  ).toBe(remote.content);
  h.session.channels.ensure("other");
  expect(
    h.session.channels.window("other").rows.some((row) => row.id === remote.id),
  ).toBe(true);
  // Even a failed/stale finite read cannot discard the separately retained traffic.
  await flush();
  expect(
    h.session.channels.window("other").rows.some((row) => row.id === remote.id),
  ).toBe(true);
});

it("does not overwrite an unreadable journal with a new failed operation", async () => {
  const save = vi.fn(),
    sign = vi.fn();
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      query: async () => [],
      writer: { sign, publish: vi.fn() },
    },
    {
      outboxStorage: {
        load: async () => {
          throw new Error("corrupt journal");
        },
        save,
      },
    },
  );
  owners.push(owner);
  owner.session.messages.send("c", "new intent while loading");
  await flush();
  await flush();
  assert.exists(owner.session.outbox);
  expect(owner.session.outbox.snapshot()[0]?.delivery).toBe("failed");
  expect(save).not.toHaveBeenCalled();
  expect(sign).not.toHaveBeenCalled();
});

it("reconnect cancels stalled reads before refreshing owned views and ignores their late responses", async () => {
  const h = fixture();
  await h.open();
  const view = h.session.observe([{ kinds: [9], "#h": ["c"], limit: 80 }]);
  const stale = h.staleRead();
  const first = view.refresh();
  await flush();
  expect(view.snapshot().status).toBe("loading");
  h.reconnect();
  await flush();
  await first;
  await flush();
  expect(view.snapshot().status).toBe("ready");
  const late = message(other, "c", "cancelled response", 10);
  stale.resolve([late]);
  await flush();
  expect(view.snapshot().events.some((event) => event.id === late.id)).toBe(
    false,
  );
});

it.each([false, true])(
  "reuses the durable outbox for reply ancestry, retry and echo without channel leaks (nested=%s)",
  async (nested) => {
    const root = message(other, "c", "root", 1);
    const h = fixture([root]);
    await h.open();
    const thread = h.session.thread("c", root.id);
    const parentId = nested ? "a".repeat(64) : root.id;
    // A parent outside recent history must not prevent a valid targeted send.
    const id = h.session.messages.reply(
      "c",
      root.id,
      "  reply  ",
      [],
      [],
      parentId,
    );
    expect(thread.snapshot().replies).toMatchObject([
      {
        id,
        content: "reply",
        delivery: "sending",
        threadRootId: root.id,
        replyParentId: parentId,
      },
    ]);
    expect(h.session.channels.window("c").rows.map((row) => row.id)).toEqual([
      root.id,
    ]);
    const event = await h.sign();
    expect(event.tags).toEqual([
      ["h", "c"],
      ...(nested ? [["e", root.id, "", "root"]] : []),
      ["e", parentId, "", "reply"],
      ["client-id", expect.any(String)],
      ["ms", String((thread.snapshot().replies[0]?.createdAtMs ?? 0) % 1000)],
    ]);
    expect(event.created_at).toBe(thread.snapshot().replies[0]?.createdAt);
    const publication = h.publications.shift();
    assert.exists(publication);
    publication.result.reject(new PublishRejected("denied"));
    await flush();
    expect(thread.snapshot().replies).toMatchObject([
      { id, delivery: "failed", deliveryError: "denied" },
    ]);
    h.session.messages.retry(id);
    expect(thread.snapshot().replies).toMatchObject([
      { id, delivery: "sending" },
    ]);
    await flush();
    expect(h.signings).toHaveLength(0); // Retry reuses the persisted signature.
    expect(h.publications[0]?.event).toEqual(event);
    h.emit([event]);
    expect(thread.snapshot().replies).toHaveLength(1);
    expect(thread.snapshot().replies[0]?.id).toBe(id);
    expect(h.session.outbox?.snapshot()).toHaveLength(0);
    expect(h.session.channels.window("c").rows.map((row) => row.id)).toEqual([
      root.id,
    ]);
    h.publications.shift()?.result.resolve();
    await flush();
    const editId = h.session.messages.edit(id, "edited", id);
    expect(thread.snapshot().replies[0]).toMatchObject({
      content: "edited",
      threadRootId: root.id,
      replyParentId: parentId,
    });
    await h.sign();
    const edit = h.publications.shift();
    assert.exists(edit);
    edit.result.reject(new PublishRejected("edit denied"));
    await flush();
    expect(
      h.session.outbox?.snapshot().find((item) => item.event.id === editId)
        ?.delivery,
    ).toBe("failed");
    expect(thread.snapshot().replies[0]?.content).toBe("reply");
    thread.dispose();
  },
);
