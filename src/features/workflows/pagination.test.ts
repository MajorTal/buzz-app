import { afterEach, expect, it, vi } from "vitest";
import type { RelayEvent } from "../relay/events";
import { matchesEvent } from "../relay/projection";
import { createRelayReader, type RelayReader } from "../relay/reader";
import { keypair, scriptedTransport, signed } from "../relay/testing";
import { createWorkflows } from "./capability";

const channel = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const author = keypair();
const event = signed(author, {
  kind: 30620,
  created_at: 100,
  content: "name: Fixture",
  tags: [],
});
const rows = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    ...event,
    id: index.toString(16).padStart(64, "0"),
    tags: [
      ["h", index % 2 ? other : channel],
      ["d", `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`],
    ],
  }));
const owners: ReturnType<typeof createWorkflows>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function setup() {
  let allowed = true;
  const read = vi.fn<RelayReader["read"]>().mockResolvedValue([]);
  const owner = createWorkflows({
    reader: { read },
    viewer: keypair().pubkey,
    outbox: undefined,
    local: undefined,
    host: undefined,
    canAccess: () => allowed,
  });
  owners.push(owner);
  return {
    ...owner,
    read,
    revoke() {
      allowed = false;
    },
  };
}

it.each([0, 99, 100, 101, 200, 201])(
  "pages %i same-second definitions with exact cursors and no author filter",
  async (count) => {
    const h = setup();
    const events = rows(count);
    h.read.mockImplementation(async (filters) =>
      filters.flatMap((filter) =>
        events
          .filter((row) => matchesEvent(row, filter))
          .slice(0, filter.limit)
          .reverse(),
      ),
    );
    const view = h.capability.definitions([channel, other]);
    await view.refresh();
    expect(view.snapshot()).toMatchObject({
      status: "ready",
      data: { partial: false, partialChannelIds: [] },
    });
    expect(view.snapshot().data.items.map((row) => row.revision)).toEqual(
      events.map((row) => row.id),
    );
    expect(h.read.mock.calls.map(([filters]) => filters)).toEqual(
      Array.from({ length: Math.floor(count / 100) + 1 }, (_, index) => [
        {
          kinds: [30620],
          "#h": [channel, other],
          limit: 100,
          ...(index
            ? { until: 100, before_id: events[index * 100 - 1]?.id }
            : {}),
        },
      ]),
    );
    expect(h.read.mock.calls.every(([, options]) => options?.fresh)).toBe(true);
    view.dispose();
    expect(h.capability.definitions([channel, other]).snapshot().status).toBe(
      "ready",
    );
  },
);

it("folds coordinates across pages and counts unique signed IDs before paging", async () => {
  const h = setup();
  const page = rows(100);
  const first = page[0];
  if (!first) throw new Error("Missing first row");
  h.read.mockResolvedValueOnce([...page, first]).mockResolvedValueOnce([
    { ...first, id: "f".repeat(64) },
    { ...first, id: "e".repeat(64), created_at: 99 },
  ]);
  const view = h.capability.definitions([channel, other]);
  await view.refresh();
  expect(view.snapshot().status).toBe("ready");
  expect(view.snapshot().data.items).toHaveLength(100);
  expect(view.snapshot().data.items[0]?.revision).toBe(first.id);
  expect(h.read).toHaveBeenCalledTimes(2);
  h.read.mockResolvedValue(Array.from({ length: 100 }, () => first));
  await view.refresh();
  expect(view.snapshot().data).toMatchObject({
    items: [{ revision: first.id }],
    partial: false,
  });
  expect(h.read).toHaveBeenCalledTimes(3);
});

it("keeps single-channel detail reads bounded and marks saturation partial", async () => {
  const h = setup();
  h.read.mockResolvedValue(
    rows(100).map((row) => ({
      ...row,
      tags: row.tags.map((tag) => (tag[0] === "h" ? ["h", channel] : tag)),
    })),
  );
  const view = h.capability.definitions(channel);
  await view.refresh();
  expect(view.snapshot()).toMatchObject({
    status: "ready",
    data: { partial: true, partialChannelIds: [channel] },
  });
  expect(h.read).toHaveBeenCalledTimes(1);
});

it.each(["failure", "repeated-page", "newer-page", "wrong-channel"])(
  "rejects a partly read batch on %s and retries from the head",
  async (mode) => {
    const h = setup();
    const page = rows(100);
    const first = page[0];
    if (!first) throw new Error("Missing first row");
    h.read.mockResolvedValueOnce(page);
    if (mode === "failure") h.read.mockRejectedValueOnce(new Error("offline"));
    else
      h.read.mockResolvedValueOnce(
        mode === "repeated-page"
          ? page
          : [
              {
                ...first,
                id: "f".repeat(64),
                ...(mode === "newer-page"
                  ? { created_at: 101 }
                  : {
                      tags: [
                        ["h", "44444444-4444-4444-8444-444444444444"],
                        ...first.tags.slice(1),
                      ],
                    }),
              },
            ],
      );
    const view = h.capability.definitions([channel, other]);
    await view.refresh();
    expect(view.snapshot()).toMatchObject({
      status: "error",
      data: { items: [] },
    });
    expect(h.read).toHaveBeenCalledTimes(2);
    h.read.mockResolvedValue([first]);
    await view.refresh();
    expect(h.read.mock.calls[2]?.[0]).toEqual([
      { kinds: [30620], "#h": [channel, other], limit: 100 },
    ]);
    expect(view.snapshot()).toMatchObject({
      status: "ready",
      data: { items: [{ revision: page[0]?.id }] },
    });
  },
);

it.each(["success", "timeout"])(
  "uses a separate reader deadline for each page: %s",
  async (mode) => {
    vi.useFakeTimers();
    // Node's native AbortSignal timer is not driven by Vitest's clock.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    const relay = scriptedTransport(author.pubkey, author.pubkey);
    const reader = createRelayReader(relay.transport);
    const owner = createWorkflows({
      reader: reader.reader,
      viewer: author.pubkey,
      outbox: undefined,
      local: undefined,
      host: undefined,
      canAccess: () => true,
    });
    const view = owner.capability.definitions([channel, other]);
    const loading = view.refresh();
    try {
      await vi.advanceTimersByTimeAsync(6000);
      expect(relay.pending).toHaveLength(1);
      relay.next().respond(rows(100));
      await vi.advanceTimersByTimeAsync(0);
      expect(relay.pending).toHaveLength(1);
      const second = relay.next();
      await vi.advanceTimersByTimeAsync(6000);
      expect(view.snapshot().status).toBe("loading");
      if (mode === "success") {
        second.respond([]);
        await loading;
        expect(view.snapshot().status).toBe("ready");
        expect(view.snapshot().data.items).toHaveLength(100);
      } else {
        await vi.advanceTimersByTimeAsync(3999);
        expect(view.snapshot().status).toBe("loading");
        await vi.advanceTimersByTimeAsync(1);
        await loading;
        expect(view.snapshot()).toMatchObject({
          status: "error",
          data: { items: [] },
        });
      }
    } finally {
      owner.dispose();
      reader.dispose();
      await loading;
    }
  },
);

it.each([
  "dispose",
  "clear",
  "interrupt",
  "access-loss",
  "revoked-and-cleared",
])("stops paging after %s and ignores a late full page", async (mode) => {
  const h = setup();
  let complete!: (events: readonly RelayEvent[]) => void;
  let began!: (signal: AbortSignal | undefined) => void;
  const pending = new Promise<readonly RelayEvent[]>((resolve) => {
    complete = resolve;
  });
  const started = new Promise<AbortSignal | undefined>((resolve) => {
    began = resolve;
  });
  h.read
    .mockResolvedValueOnce(rows(100))
    .mockImplementationOnce((_filters, options) => {
      began(options?.signal);
      return pending;
    });
  const view = h.capability.definitions([channel, other]);
  const loading = view.refresh();
  const signal = await started;
  try {
    expect(view.snapshot()).toMatchObject({
      status: "loading",
      data: { items: [] },
    });
    if (mode === "dispose") view.dispose();
    else if (mode === "clear" || mode === "interrupt") h[mode]();
    else {
      h.revoke();
      if (mode === "revoked-and-cleared") h.clear();
    }
    if (mode !== "access-loss") expect(signal?.aborted).toBe(true);
  } finally {
    complete(rows(100).map((row) => ({ ...row, created_at: 99 })));
    await loading;
  }
  expect(h.read).toHaveBeenCalledTimes(2);
  expect(view.snapshot().data.items).toEqual([]);
  expect(view.snapshot().status).not.toBe("loading");
});
