import { assert, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { flush, keypair, signed } from "./testing";
import type { ReadTransport } from "./transport";
import type { OutgoingEvent } from "./outbox";

function setup(overrides: Partial<ReadTransport> = {}) {
  const key = keypair();
  const close = vi.fn();
  const storageClose = vi.fn();
  let journal: readonly OutgoingEvent[] = [];
  const transport: ReadTransport = {
    viewer: key.pubkey,
    relayAuthor: key.pubkey,
    scope: "https://synthetic.example",
    agentActivity: true,
    query: async () => [],
    media: () => undefined,
    subscribe: () => ({ dispose: close, retry: vi.fn(), update: vi.fn() }),
    writer: {
      kinds: [9],
      sign: async (event) => signed(key, event),
      publish: async () => {},
    },
    ...overrides,
  };
  const owner = createRelaySession(transport, {
    outboxStorage: {
      load: () => [],
      save: (records) => {
        journal = structuredClone(records);
      },
      close: storageClose,
    },
  });
  return { owner, key, close, transport, storageClose, journal: () => journal };
}

it("terminal cleanup reaches streams and writes without invoking projection observers", async () => {
  const { owner, close, storageClose } = setup();
  const observers = [
    owner.session.agentActivity,
    owner.session.profiles,
    owner.session.emoji,
    owner.session.agentLibrary,
    owner.session.archives,
  ];
  const callbacks = observers.map(() =>
    vi.fn(() => {
      throw new Error("Projection observer failed");
    }),
  );
  const stops = observers.map((view, i) => {
    const callback = callbacks[i];
    assert.exists(callback);
    return view.subscribe(callback);
  });
  let failure: unknown;
  try {
    owner.dispose();
    expect(close).toHaveBeenCalledTimes(1);
    expect(owner.session.outbox?.supports(9)).toBe(false);
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled();
    expect(owner.session.agentActivity.snapshot().status).toBe("unavailable");
    await flush();
    expect(storageClose).toHaveBeenCalledTimes(1);
  } catch (error) {
    failure = error;
  } finally {
    // Preserve test ownership even if a mutation interrupts disposal.
    for (const stop of stops) stop();
    if (failure) owner.dispose();
  }
  expect(failure).toBeUndefined();
});

it("keeps live projection notifications but never reenters disposal from them", () => {
  const { owner, close } = setup();
  const changed = vi.fn();
  const stop = owner.session.agentActivity.subscribe(changed);
  const release = owner.session.agentActivity.activate();
  expect(changed).toHaveBeenCalledTimes(1);
  let terminal = false;
  const reenter = vi.fn(() => {
    if (terminal) owner.dispose();
  });
  const stopReenter = owner.session.agentActivity.subscribe(reenter);
  try {
    terminal = true;
    owner.dispose();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(reenter).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(owner.session.outbox?.supports(9)).toBe(false);
  } finally {
    stop();
    stopReenter();
    release();
  }
});

it("cancels a pending read and rejects its late result after silent retirement", async () => {
  let resolve!: (events: []) => void;
  const query = vi.fn(
    (_filters: unknown, _signal?: AbortSignal) =>
      new Promise<[]>((done) => {
        resolve = done;
      }),
  );
  const { owner } = setup({ query });
  const read = owner.session.read([{ kinds: [1], limit: 1 }]);
  const rejected = expect(read).rejects.toThrow();
  await flush();
  const signal = query.mock.calls[0]?.[1];
  assert.exists(signal);
  const changed = vi.fn(() => {
    throw new Error("Retired projection must not run");
  });
  owner.session.agentActivity.subscribe(changed);
  owner.dispose();
  expect(signal.aborted).toBe(true);
  resolve([]);
  await rejected;
  expect(changed).not.toHaveBeenCalled();
});

it("cancels publication while preserving the exact signed durable intent", async () => {
  let resolve!: () => void;
  const publish = vi.fn(
    (_event: unknown, _signal: AbortSignal) =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  const key = keypair();
  const { owner, journal, storageClose } = setup({
    viewer: key.pubkey,
    writer: {
      kinds: [9],
      sign: async (event) => signed(key, event),
      publish,
    },
  });
  const outbox = owner.session.outbox;
  assert.exists(outbox);
  const id = outbox.send({
    kind: 9,
    content: "Keep original intent",
    tags: [],
  });
  await flush();
  await flush();
  expect(publish).toHaveBeenCalledTimes(1);
  const signal = publish.mock.calls[0]?.[1];
  assert.exists(signal);
  const before = JSON.stringify(journal());
  expect(journal()[0]?.signed?.id).toBe(id);
  owner.session.agentActivity.subscribe(() => {
    throw new Error("Do not strand publication");
  });
  owner.dispose();
  expect(signal.aborted).toBe(true);
  expect(outbox.supports(9)).toBe(false);
  resolve();
  await flush();
  expect(JSON.stringify(journal())).toBe(before);
  expect(outbox.snapshot()[0]?.delivery).not.toBe("accepted");
  expect(publish).toHaveBeenCalledTimes(1);
  expect(storageClose).toHaveBeenCalledTimes(1);
});
