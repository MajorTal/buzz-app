import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import type { RelayEvent } from "../relay/events";
import type { LiveCallbacks } from "../relay/live";
import {
  flush,
  keypair,
  roster,
  signed,
  scriptedTransport,
} from "../relay/testing";
const channelId = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const relay = keypair(),
  viewer = keypair();
const definition = signed(viewer, {
  kind: 30620,
  created_at: 10,
  content: "PRIVATE yaml",
  tags: [
    ["h", channelId],
    ["d", id],
  ],
});
const reference = { id, channelId, owner: viewer.pubkey };
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function setup() {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let incoming!: (events: readonly RelayEvent[]) => void;
  let state!: LiveCallbacks["state"];
  let resolveRuns!: (value: unknown) => void;
  const runs = vi.fn(
    (_id: string, _cursor: unknown, _signal: AbortSignal) =>
      new Promise<unknown>((resolve) => {
        resolveRuns = resolve;
      }),
  );
  const owner = createRelaySession({
    ...wire.transport,
    workflows: { runs },
    subscribe(callbacks) {
      incoming = callbacks.receive;
      state = callbacks.state;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  owners.push(owner);
  return {
    ...wire,
    ...owner,
    runs,
    state: (status: "connected" | "retrying") => state({ status, routes: [] }),
    emit: (events: readonly RelayEvent[]) => incoming(events),
    resolveRuns: (value: unknown) => resolveRuns(value),
  };
}
it("workflow views start lazy and purge to unavailable before any channel/operation/view observer runs", async () => {
  const h = setup();
  h.emit([roster(relay, channelId, [viewer.pubkey], 1)]);
  const definitions = h.session.workflows.definitions(channelId),
    history = h.session.workflows.runs(reference);
  expect(h.pending).toHaveLength(0);
  expect(h.runs).not.toHaveBeenCalled();
  const loading = definitions.refresh();
  await vi.waitFor(() => expect(h.pending).toHaveLength(1));
  const request = h.next();
  expect(request.filters).toEqual([
    { kinds: [30620], "#h": [channelId], limit: 100 },
  ]);
  // A second refresh shares its pending read.
  expect(definitions.refresh()).toBe(loading);
  request.respond([definition]);
  await loading;
  expect(definitions.snapshot().status).toBe("ready");
  expect(history.snapshot().status).toBe("idle");
});
it("authoritative revocation clears all saved and structured data before callbacks, rejects late results and denies fresh views", async () => {
  const h = setup();
  h.emit([roster(relay, channelId, [viewer.pubkey], 1)]);
  const definitions = h.session.workflows.definitions(channelId),
    history = h.session.workflows.runs(reference);
  const loading = definitions.refresh();
  await vi.waitFor(() => expect(h.pending).toHaveLength(1));
  h.next().respond([definition]);
  await loading;
  expect(definitions.snapshot().data.items[0]?.revision).toBe(definition.id);
  const runRead = history.refresh();
  await vi.waitFor(() => expect(h.runs).toHaveBeenCalledTimes(1));
  const checked = vi.fn(() => {
    expect(definitions.snapshot()).toMatchObject({
      status: "unavailable",
      data: { items: [] },
    });
    expect(history.snapshot()).toMatchObject({
      status: "unavailable",
      data: { runs: [] },
    });
    expect(h.session.workflows.operations.snapshot()).toEqual([]);
  });
  definitions.subscribe(checked);
  history.subscribe(checked);
  h.session.workflows.operations.subscribe(checked);
  h.session.channels.subscribeList(checked);
  h.emit([roster(relay, channelId, [], 2)]);
  expect(checked).toHaveBeenCalled();
  expect(h.runs.mock.calls[0]?.[2].aborted).toBe(true);
  const denied = h.session.workflows.definitions(channelId);
  expect(denied.snapshot().status).toBe("unavailable");
  await denied.refresh();
  expect(h.pending).toHaveLength(0);
  h.resolveRuns({ runs: [], next: null });
  await runRead;
  expect(history.snapshot().status).toBe("unavailable");
});
it("regrant cannot resurrect stale history; clear-cache and dispose cancel interest", async () => {
  const h = setup();
  h.emit([roster(relay, channelId, [viewer.pubkey], 1)]);
  const history = h.session.workflows.runs(reference);
  const first = history.refresh();
  await vi.waitFor(() => expect(h.runs).toHaveBeenCalledTimes(1));
  h.emit([roster(relay, channelId, [], 2)]);
  h.emit([roster(relay, channelId, [viewer.pubkey], 3)]);
  h.resolveRuns({ runs: [], next: null });
  await first;
  expect(history.snapshot().status).toBe("unavailable");
  const fresh = history.refresh();
  await vi.waitFor(() => expect(h.runs).toHaveBeenCalledTimes(2));
  h.resolveRuns({ runs: [], next: null });
  await fresh;
  expect(history.snapshot().status).toBe("ready");
  const next = history.refresh();
  await vi.waitFor(() => expect(h.runs).toHaveBeenCalledTimes(3));
  await h.clearCache();
  expect(h.runs.mock.calls[2]?.[2].aborted).toBe(true);
  expect(history.snapshot()).toMatchObject({
    status: "idle",
    data: { runs: [] },
  });
  h.resolveRuns({ runs: [], next: null });
  await next;
  expect(history.snapshot().status).toBe("idle");
  h.dispose();
  expect(history.snapshot().status).toBe("unavailable");
});
it("a loading observer can revoke without leaving a wedged pending read", async () => {
  const h = setup();
  h.emit([roster(relay, channelId, [viewer.pubkey], 1)]);
  const history = h.session.workflows.runs(reference);
  const stop = history.subscribe(() => {
    if (history.snapshot().status === "loading")
      h.emit([roster(relay, channelId, [], 2)]);
  });
  await history.refresh();
  expect(h.runs).not.toHaveBeenCalled();
  expect(history.snapshot().status).toBe("unavailable");
  stop();
  h.emit([roster(relay, channelId, [viewer.pubkey], 3)]);
  const fresh = history.refresh();
  await vi.waitFor(() => expect(h.runs).toHaveBeenCalledTimes(1));
  h.resolveRuns({ runs: [], next: null });
  await fresh;
  expect(history.snapshot().status).toBe("ready");
});
it("existing backend permits workflow commands without lifecycle metadata while retaining session access and shape guards", async () => {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let incoming!: (events: readonly RelayEvent[]) => void;
  const sign = vi.fn(async (template: Parameters<typeof signed>[1]) =>
    signed(viewer, template),
  );
  const publish = vi.fn(async () => "");
  const owner = createRelaySession(
    {
      ...wire.transport,
      writer: { kinds: [9, 30620, 46020, 5], sign, publish },
      workflows: { runs: async () => ({ runs: [], next: null }) },
      subscribe(callbacks) {
        incoming = callbacks.receive;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { outboxStorage: { load: async () => [], save: async () => {} } },
  );
  owners.push(owner);
  incoming([roster(relay, channelId, [viewer.pubkey], 1)]);
  expect(owner.session.workflows.availability).toMatchObject({
    save: true,
    delete: true,
    trigger: true,
  });
  const workflow = {
    ...reference,
    yaml: definition.content,
    revision: definition.id,
    createdAt: 10,
  };
  const operation = owner.session.workflows.trigger(workflow);
  await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
  await vi.waitFor(() =>
    expect(owner.session.workflows.operations.snapshot()[0]).toMatchObject({
      eventId: operation,
      outcome: "unknown",
    }),
  );
  expect(sign).toHaveBeenCalledTimes(1);
  const invalid = owner.session.outbox?.send({
    kind: 46020,
    tags: [
      ["h", channelId],
      ["d", "not-a-uuid"],
    ],
    content: "",
  });
  await vi.waitFor(() =>
    expect(
      owner.session.outbox?.snapshot().find((row) => row.event.id === invalid)
        ?.delivery,
    ).toBe("failed"),
  );
  expect(sign).toHaveBeenCalledTimes(1);
  incoming([roster(relay, channelId, [], 2)]);
  expect(() => owner.session.workflows.trigger(workflow)).toThrow(
    "unavailable",
  );
  const denied = owner.session.outbox?.send({
    kind: 46020,
    tags: [
      ["h", channelId],
      ["d", id],
    ],
    content: "",
  });
  await vi.waitFor(() =>
    expect(
      owner.session.outbox?.snapshot().find((row) => row.event.id === denied)
        ?.delivery,
    ).toBe("failed"),
  );
  expect(sign).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenCalledTimes(1);
});

it("session fresh definition read resolves a lost save, while ordinary echo does not", async () => {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let incoming!: (events: readonly RelayEvent[]) => void;
  let reject!: (error: Error) => void;
  let published: RelayEvent | undefined;
  const sign = vi.fn(async (template: Parameters<typeof signed>[1]) =>
    signed(viewer, template),
  );
  const publish = vi.fn((event: RelayEvent) => {
    published = event;
    return new Promise<string>((_resolve, fail) => {
      reject = fail;
    });
  });
  const owner = createRelaySession(
    {
      ...wire.transport,
      writer: { kinds: [30620], sign, publish },
      workflows: { runs: async () => ({ runs: [], next: null }) },
      subscribe(callbacks) {
        incoming = callbacks.receive;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { outboxStorage: { load: async () => [], save: async () => {} } },
  );
  owners.push(owner);
  incoming([roster(relay, channelId, [viewer.pubkey], 1)]);
  const workflows = owner.session.workflows;
  const op = workflows.save({
    channelId,
    yaml: "name: Saved\nenabled: false\ntrigger:\n  on: message_posted\nsteps:\n  - id: wait\n    action: delay\n    duration: 1s\n",
  });
  await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
  if (!published) throw new Error("missing signed event");
  incoming([published]);
  reject(new Error("lost receipt"));
  await vi.waitFor(() =>
    expect(workflows.operations.snapshot()[0]).toMatchObject({
      eventId: op,
      outcome: "unknown",
      delivery: "seen",
    }),
  );
  // Settle the existing outbox confirmation read; it is not task-level recovery.
  await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
  wire.next().respond([published]);
  const view = workflows.definitions(channelId);
  expect(workflows.operations.snapshot()[0]?.outcome).toBe("unknown");
  const loading = view.refresh();
  await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
  const request = wire.next();
  expect(request.filters).toEqual([
    { kinds: [30620], "#h": [channelId], limit: 100 },
  ]);
  request.respond([published]);
  await loading;
  expect(view.snapshot().data.items[0]?.revision).toBe(op);
  expect(workflows.operations.snapshot()[0]?.outcome).toBe("succeeded");
  expect(sign).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenCalledTimes(1);
});

it("transient reconnect cancels reads without purging authorized snapshots", async () => {
  const h = setup();
  h.emit([roster(relay, channelId, [viewer.pubkey], 1)]);
  h.state("connected");
  const definitions = h.session.workflows.definitions(channelId);
  const loading = definitions.refresh();
  await vi.waitFor(() => expect(h.pending).toHaveLength(1));
  h.next().respond([definition]);
  await loading;
  const history = h.session.workflows.runs(reference);
  const pending = history.refresh();
  await vi.waitFor(() => expect(h.runs).toHaveBeenCalledTimes(1));
  h.state("retrying");
  expect(definitions.snapshot()).toMatchObject({
    status: "error",
    data: { items: [{ revision: definition.id }] },
  });
  expect(history.snapshot().status).toBe("error");
  expect(h.runs.mock.calls[0]?.[2].aborted).toBe(true);
  h.resolveRuns({ runs: [], next: null });
  await pending;
  expect(history.snapshot().status).toBe("error");
  h.state("connected");
  const refresh = definitions.refresh();
  await vi.waitFor(() => expect(h.pending).toHaveLength(1));
  h.next().respond([definition]);
  await refresh;
  expect(definitions.snapshot().status).toBe("ready");
});

it.each(["reconnect", "revoke", "dispose"])(
  "in-flight run receipt across %s follows session authority",
  async (transition) => {
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    let traffic!: LiveCallbacks;
    let settle!: (message: string) => void;
    const publish = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          settle = resolve;
        }),
    );
    const owner = createRelaySession(
      {
        ...wire.transport,
        writer: {
          kinds: [46020],
          sign: async (template) => signed(viewer, template),
          publish,
        },
        workflows: { runs: async () => ({ runs: [], next: null }) },
        subscribe(callbacks) {
          traffic = callbacks;
          return { update() {}, retry() {}, dispose() {} };
        },
      },
      { outboxStorage: { load: () => [], save() {} } },
    );
    owners.push(owner);
    traffic.receive([roster(relay, channelId, [viewer.pubkey], 1)]);
    traffic.state({ status: "connected", routes: [] });
    const eventId = owner.session.workflows.trigger({
      ...reference,
      yaml: definition.content,
      revision: definition.id,
      createdAt: 10,
    });
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    if (transition === "reconnect")
      traffic.state({ status: "retrying", routes: [] });
    else if (transition === "revoke")
      traffic.receive([roster(relay, channelId, [], 2)]);
    else owner.dispose();
    settle('response:{"run_id":"33333333-3333-4333-8333-333333333333"}');
    if (transition === "reconnect") {
      await vi.waitFor(() =>
        expect(owner.session.workflows.operations.snapshot()[0]).toMatchObject({
          eventId,
          outcome: "succeeded",
          runId: "33333333-3333-4333-8333-333333333333",
        }),
      );
    } else {
      await flush();
      expect(owner.session.workflows.operations.snapshot()).toEqual([]);
    }
  },
);
