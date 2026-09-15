import { afterEach, expect, it, vi } from "vitest";
import { createWorkflows } from "./capability";
import {
  createOutbox,
  PublishRejected,
  type OutgoingEvent,
} from "../relay/outbox";
import { keypair, signed, flush } from "../relay/testing";
import type { RelayEvent } from "../relay/events";
const id = "11111111-1111-4111-8111-111111111111",
  channelId = "22222222-2222-4222-8222-222222222222",
  runId = "33333333-3333-4333-8333-333333333333";
const yaml =
  "name: Fixture\nenabled: false\ntrigger:\n  on: message_posted\nsteps:\n  - id: send\n    action: send_message\n    text: Hi\n";
const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});
function setup() {
  const key = keypair();
  let saved: readonly OutgoingEvent[] = [],
    allowed = true;
  let settle!: (value: string) => void, reject!: (error: Error) => void;
  const sign = vi.fn(async (template: Parameters<typeof signed>[1]) =>
    signed(key, template),
  );
  const publish = vi.fn(
    (_event: RelayEvent, _signal: AbortSignal) =>
      new Promise<string>((resolve, fail) => {
        settle = resolve;
        reject = fail;
      }),
  );
  const outbox = createOutbox(
    key.pubkey,
    { kinds: [30620, 46020, 5], sign, publish },
    {
      load: () => [],
      save: (rows) => {
        saved = structuredClone(rows);
      },
    },
    {
      needsReceipt: (event) => [30620, 46020, 5].includes(event.kind),
      onReceipt: (event, message) => workflows.receipt(event, message),
    },
  );
  const read = vi.fn(async () => [] as RelayEvent[]);
  const workflows = createWorkflows({
    viewer: key.pubkey,
    reader: { read },
    outbox: outbox.outbox,
    local: outbox.local,
    host: {
      runs: async () => ({ runs: [], next: null }),
    },
    canAccess: () => allowed,
  });
  disposers.push(() => {
    workflows.dispose();
    outbox.dispose();
  });
  const definition = {
    id,
    channelId,
    owner: key.pubkey,
    revision: "a".repeat(64),
    createdAt: 1,
    yaml,
  };
  return {
    ...workflows,
    outbox,
    read,
    sign,
    publish,
    definition,
    saved: () => saved,
    settle: (value: string) => settle(value),
    reject: (error: Error) => reject(error),
    revoke: () => {
      allowed = false;
      workflows.clear();
    },
  };
}
it("save preserves exact YAML/coordinate/revision, receipt success is distinct from signed head readback", async () => {
  const h = setup();
  const view = h.capability.definitions(channelId);
  const operation = h.capability.save({
    channelId,
    yaml,
    existing: h.definition,
  });
  await flush();
  const event = h.publish.mock.calls[0]?.[0];
  expect(event).toBeDefined();
  expect(event?.content).toBe(yaml);
  expect(event?.tags).toContainEqual([
    "expected-revision",
    h.definition.revision,
  ]);
  expect(event?.tags).toContainEqual(["d", id]);
  h.settle(`response:${JSON.stringify({ workflow_id: id })}`);
  await flush();
  expect(h.capability.operations.snapshot()[0]).toMatchObject({
    eventId: operation,
    outcome: "succeeded",
  });
  // Local echo and receipt never masquerade as a freshly read committed head.
  expect(view.snapshot()).toMatchObject({
    status: "idle",
    data: { items: [] },
  });
  await view.refresh();
  expect(view.snapshot().data.items).toEqual([]);
});
it.each([
  [JSON.stringify({ run_id: runId }), "succeeded", runId],
  [JSON.stringify({ workflow_id: id, run_id: runId }), "succeeded", runId],
  [JSON.stringify({ workflow_id: runId, run_id: runId }), "unknown", undefined],
  [JSON.stringify({ run_id: "bad" }), "unknown", undefined],
  [
    JSON.stringify({ run_id: runId, webhook_secret: "PRIVATE" }),
    "unknown",
    undefined,
  ],
  ["{PRIVATE malformed", "unknown", undefined],
])(
  "manual run only correlates validated returned run ID: %s",
  async (payload, outcome, expectedRun) => {
    const h = setup();
    h.capability.trigger(h.definition);
    await flush();
    h.settle(`response:${payload}`);
    await flush();
    expect(h.capability.operations.snapshot()[0]?.outcome).toBe(outcome);
    expect(h.capability.operations.snapshot()[0]?.runId).toBe(expectedRun);
    expect(h.read).not.toHaveBeenCalled();
    expect(JSON.stringify(h.saved())).not.toContain("PRIVATE");
    expect(JSON.stringify(h.capability.operations.snapshot())).not.toContain(
      "PRIVATE",
    );
  },
);
it("lost receipt plus echo stays unknown; dismissal never repeats the command", async () => {
  const h = setup();
  const operation = h.capability.trigger(h.definition);
  await flush();
  const event = h.publish.mock.calls[0]?.[0];
  if (!event) throw new Error("missing publication");
  h.outbox.observe([event]);
  h.reject(new Error("PRIVATE lost"));
  await flush();
  expect(h.capability.operations.snapshot()[0]).toMatchObject({
    eventId: operation,
    delivery: "seen",
    outcome: "unknown",
  });
  await h.capability.operations.dismiss(operation);
  expect(h.capability.operations.snapshot()).toEqual([]);
  expect(h.publish).toHaveBeenCalledTimes(1);
  expect(h.sign).toHaveBeenCalledTimes(1);
});
it("explicit rejection is rejected, not unknown; revocation fences late receipts without discarding durable intent", async () => {
  const h = setup();
  h.capability.trigger(h.definition);
  await flush();
  h.reject(new PublishRejected("PRIVATE rejection"));
  await flush();
  expect(h.capability.operations.snapshot()[0]?.outcome).toBe("rejected");
  const id = h.capability.trigger(h.definition);
  await flush();
  h.revoke();
  h.settle(`response:${JSON.stringify({ run_id: runId })}`);
  await flush();
  expect(h.capability.operations.snapshot()).toEqual([]);
  expect(h.saved().some((row) => row.event.id === id)).toBe(true);
  expect(JSON.stringify(h.saved())).not.toContain("PRIVATE");
});
it("webhook saves are blocked through raw YAML; stale/legacy deletion receipt never proves deletion", async () => {
  const h = setup();
  expect(() =>
    h.capability.save({
      channelId,
      yaml: yaml.replace("message_posted", "webhook"),
    }),
  ).toThrow("secret");
  expect(h.publish).not.toHaveBeenCalled();
  h.capability.delete(h.definition);
  await flush();
  h.settle("");
  await flush();
  expect(h.capability.operations.snapshot()[0]?.outcome).toBe("unknown");
  h.capability.delete(h.definition);
  await flush();
  h.settle(`response:${JSON.stringify({ workflow_id: id, deleted: true })}`);
  await flush();
  expect(h.capability.operations.snapshot()[1]?.outcome).toBe("succeeded");
});

it.each([true, false])(
  "fresh exact saved configuration resolves a lost save receipt without replay (echo=%s)",
  async (echo) => {
    const h = setup();
    const operation = h.capability.save({
      channelId,
      yaml,
      existing: h.definition,
    });
    await flush();
    const event = h.publish.mock.calls[0]?.[0];
    if (!event) throw new Error("missing publication");
    if (echo) h.outbox.observe([event]);
    h.reject(new Error("lost receipt"));
    await flush();
    expect(h.capability.operations.snapshot()[0]?.outcome).toBe("unknown");
    h.read.mockResolvedValue([event]);
    const view = h.capability.definitions(channelId);
    expect(h.read).not.toHaveBeenCalled();
    await view.refresh();
    expect(h.read).toHaveBeenCalledWith(
      [{ kinds: [30620], "#h": [channelId], limit: 100 }],
      expect.objectContaining({ fresh: true }),
    );
    expect(view.snapshot()).toMatchObject({
      status: "ready",
      data: { items: [{ revision: operation }] },
    });
    expect(h.capability.operations.snapshot()[0]).toMatchObject({
      eventId: operation,
      outcome: "succeeded",
    });
    expect(h.capability.operations.snapshot()[0]?.error).toBeUndefined();
    expect(h.sign).toHaveBeenCalledTimes(1);
    expect(h.publish).toHaveBeenCalledTimes(1);
  },
);
it.each([
  "revision",
  "owner",
  "channel",
  "workflow",
  "newer-head",
  "read-failure",
  "revoked",
  "disposed",
])(
  "fresh read does not resolve an unknown save on %s mismatch or lost interest",
  async (caseName) => {
    const h = setup();
    h.capability.save({ channelId, yaml, existing: h.definition });
    await flush();
    const event = h.publish.mock.calls[0]?.[0];
    if (!event) throw new Error("missing publication");
    h.reject(new Error("lost receipt"));
    await flush();
    const view = h.capability.definitions(channelId);
    let row = event;
    if (caseName === "revision") row = { ...event, id: "f".repeat(64) };
    if (caseName === "owner") row = { ...event, pubkey: "f".repeat(64) };
    if (caseName === "channel" || caseName === "workflow")
      row = {
        ...event,
        tags: event.tags.map((tag) =>
          tag[0] === (caseName === "channel" ? "h" : "d")
            ? [tag[0], runId]
            : tag,
        ),
      };
    let resolve!: (events: RelayEvent[]) => void;
    h.read.mockImplementationOnce(
      () =>
        new Promise<RelayEvent[]>((done) => {
          resolve = done;
        }),
    );
    const reading = view.refresh();
    await flush();
    if (caseName === "revoked") h.revoke();
    if (caseName === "disposed") view.dispose();
    resolve(
      caseName === "newer-head"
        ? [
            event,
            { ...event, id: "f".repeat(64), created_at: event.created_at + 1 },
          ]
        : caseName === "read-failure"
          ? [{ ...event, kind: 9 }]
          : [row],
    );
    await reading;
    expect(
      h.capability.operations
        .snapshot()
        .some((op) => op.outcome === "succeeded"),
    ).toBe(false);
    expect(h.publish).toHaveBeenCalledTimes(1);
  },
);
it("fresh saved configuration never resolves an unknown manual run", async () => {
  const h = setup();
  h.capability.trigger(h.definition);
  await flush();
  h.reject(new Error("lost receipt"));
  await flush();
  const event = h.publish.mock.calls[0]?.[0];
  if (!event) throw new Error("missing publication");
  h.read.mockResolvedValue([{ ...event, kind: 30620, content: yaml }]);
  await h.capability.definitions(channelId).refresh();
  expect(h.capability.operations.snapshot()[0]?.outcome).toBe("unknown");
});

it("dismissal cannot unlock an active echoed command", async () => {
  const h = setup();
  const operation = h.capability.trigger(h.definition);
  await flush();
  const event = h.publish.mock.calls[0]?.[0];
  if (!event) throw new Error("missing publication");
  h.outbox.observe([event]);
  await expect(h.capability.operations.dismiss(operation)).rejects.toThrow(
    "still being delivered",
  );
  expect(h.capability.operations.snapshot()[0]?.eventId).toBe(operation);
  h.settle(`response:${JSON.stringify({ run_id: runId })}`);
  await flush();
  expect(h.capability.operations.snapshot()[0]?.outcome).toBe("succeeded");
  await h.capability.operations.dismiss(operation);
  expect(h.capability.operations.snapshot()).toEqual([]);
});

it.each(["save", "trigger", "delete"] as const)(
  "foreign definitions stay browsable but cannot be used for %s",
  async (action) => {
    const h = setup();
    const foreign = { ...h.definition, owner: keypair().pubkey };
    const write =
      action === "save"
        ? () => h.capability.save({ channelId, yaml, existing: foreign })
        : () => h.capability[action](foreign);
    expect(write).toThrow(/owner/i);
    await flush();
    expect(h.sign).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    expect(() => h.capability.runs(foreign)).not.toThrow();
  },
);
