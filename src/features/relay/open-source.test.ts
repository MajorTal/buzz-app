import { expect, it, vi } from "vitest";
import type { LiveCallbacks } from "./live";
import type { HeadPersistence } from "./persistence";
import { createRelaySession } from "./session";
import {
  bounds,
  flush,
  keypair,
  message,
  metadata,
  roster,
  scriptedTransport,
} from "./testing";
import { clientMetrics } from "../developer/client-metrics";

// The store attributes each open's rows; record them with a live recorder.
vi.mock("../developer/client-metrics", async (original) => {
  const actual = await original<typeof import("../developer/client-metrics")>();
  return {
    ...actual,
    clientMetrics: actual.createClientMetrics({
      monitor: false,
      afterPaint: (callback) => callback(),
    }),
  };
});

const relay = keypair(),
  viewer = keypair(),
  alice = keypair();
const head = (id: string) => [
  message(alice, id, "hello", 20),
  bounds(relay, id, "head", { has_more: false, next_cursor: null }),
];
function open(channels: { ensure(id: string): void }, id: string) {
  clientMetrics.channelMounted(id);
  channels.ensure(id);
}
const sources = () => clientMetrics.export().opens.map((open) => open.source);

it("attributes rows retained across a dropped socket to memory, not disk", async () => {
  clientMetrics.reset();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  // No persistence: nothing can come from disk.
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, prioritize() {}, retry() {}, dispose() {} };
    },
  });
  const channels = owner.session.channels;
  try {
    live.receive([roster(relay, "a", [viewer.pubkey])]);
    live.state({ status: "connected", routes: [] });
    open(channels, "a");
    wire.next().respond(head("a"));
    await flush();
    clientMetrics.channelRendered("a");
    clientMetrics.channelUnmounted("a");
    // The drop marks every retained window `cached` without replacing its rows.
    live.state({ status: "retrying", routes: [] });
    expect(channels.window("a").freshness).toBe("cached");
    open(channels, "a");
    clientMetrics.channelRendered("a");
    expect(sources()).toEqual(["network", "memory"]);
  } finally {
    clientMetrics.channelUnmounted("a");
    owner.dispose();
  }
});

it("attributes rows restored from IndexedDB to disk", async () => {
  clientMetrics.reset();
  const disk: HeadPersistence = {
    read: vi.fn(async () => [
      { channelId: "a", savedAt: Date.now(), events: head("a"), profiles: [] },
    ]),
    write: vi.fn(async () => {}),
    retain: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    close: vi.fn(),
  };
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const store = createRelaySession(wire.transport, {
    prepared: true,
    persistence: disk,
  });
  const channels = store.session.channels;
  try {
    channels.ensureList();
    wire
      .next()
      .respond([
        roster(relay, "a", [viewer.pubkey]),
        metadata(relay, "a", "a"),
      ]);
    await flush();
    open(channels, "a");
    await vi.waitFor(() => expect(channels.window("a").rows).toHaveLength(1));
    clientMetrics.channelRendered("a");
    expect(sources()).toEqual(["disk"]);
  } finally {
    store.dispose();
  }
});
