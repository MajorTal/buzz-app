import { Context } from "@deepseek-ai/cordis";
import { PluginRuntime } from "../../plugins/runtime";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import type {
  SidebarDecoder,
  SidebarMuteMutator,
} from "../relay/sidebar-preferences";
import type { LiveCallbacks } from "../relay/live";
import type { ReadFilter } from "../relay/events";
import type { Communities } from "../communities/service";
import {
  keypair,
  message,
  metadata,
  profile,
  roster,
  signed,
  flush,
} from "../relay/testing";
import {
  newReadJournal,
  readJournal,
  type ReadJournal,
} from "../relay/read-state-storage";
import { NotificationsService } from "./service";
import { createNotificationPreferences } from "./preferences";
import { provideNavigation } from "../navigation/service";
import { bindMessageNotifications, notificationAuthorized } from "./messages";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const stop of cleanups.splice(0)) await stop();
  vi.restoreAllMocks();
});
async function setup(
  readBarrier: Promise<void> = Promise.resolve(),
  readFrontier?: number,
  remote?: {
    observation: "bounded" | "snapshot";
    barrier: Promise<void>;
    decodeBarrier?: Promise<void>;
    frontier: number;
    channelsMounted?: boolean;
    deferRoster?: boolean;
  },
  sidebar?: { decode: SidebarDecoder; write?: SidebarMuteMutator },
) {
  const viewer = keypair(),
    peer = keypair(),
    relay = keypair();
  const origin = "https://relay.example.com";
  let callbacks!: LiveCallbacks;
  let readState: ReadJournal | undefined =
    readFrontier === undefined
      ? undefined
      : {
          ...newReadJournal(),
          state: { frontiers: { room: readFrontier }, overrides: {} },
        };
  const markerQuery = vi.fn(async () => {
    await remote?.barrier;
    return [
      signed(viewer, {
        kind: 30078,
        tags: [
          ["d", `read-state:${"a".repeat(32)}`],
          ["t", "read-state"],
        ],
        content: "encrypted remote marker",
      }),
    ];
  });
  const decode = vi.fn(
    async (
      events: readonly ReturnType<typeof message>[],
      signal: AbortSignal,
    ) => {
      await remote?.decodeBarrier;
      signal.throwIfAborted();
      return events.map((event) => ({
        eventId: event.id,
        blob: {
          v: 1,
          client_id: "other-device",
          contexts: { room: remote?.frontier },
        },
      }));
    },
  );
  const query = vi.fn(async (filters: readonly ReadFilter[]) =>
    remote && filters[0]?.kinds?.includes(30078)
      ? markerQuery()
      : ([] as ReturnType<typeof message>[]),
  );
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      query,
      ...(remote
        ? {
            readState: {
              decode,
              ...(remote.observation === "snapshot"
                ? { communityId: "test-community" }
                : {}),
            },
            ...(remote.observation === "snapshot"
              ? { readStateSnapshot: markerQuery }
              : {}),
          }
        : {}),
      ...(sidebar
        ? {
            decodeSidebarPreferences: sidebar.decode,
            ...(sidebar.write ? { writeSidebarMute: sidebar.write } : {}),
          }
        : {}),
      media: () => undefined,
      subscribe(value) {
        callbacks = value;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      readStateStorage: {
        async update(change) {
          await readBarrier;
          readState = readJournal(change(readState), viewer.pubkey);
          return readState;
        },
        close() {},
      },
    },
  );
  cleanups.push(owner.dispose);
  const ctx = new Context();
  const runtime = new PluginRuntime(ctx, async () => ({ apply() {} }));
  ctx.effect(() => () => runtime.dispose());
  cleanups.push(() => ctx.fiber.dispose());
  const navigation = provideNavigation(ctx);
  const data = new Map<string, string>();
  const preferences = createNotificationPreferences({
    localStorage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as Window);
  let click = () => {};
  const show = vi.fn(async (_item, activate: () => void) => {
    click = activate;
  });
  const permission = vi.fn(async (): Promise<"granted"> => "granted");
  const listeners = new Set<() => void>();
  let selected: string | null = origin;
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    viewer: viewer.pubkey,
    session: owner.session,
  };
  const communities = {
    snapshot: () => ({
      status: "ready",
      viewer: viewer.pubkey,
      selected,
      memberships: [{ id: origin, name: "Example" }],
    }),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    relay: {
      snapshot: () => snapshot,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as Communities;
  const notifications = new NotificationsService(
    ctx,
    navigation.navigation,
    {
      label: "Test platform",
      permission,
      requestPermission: async () => "granted",
      show,
      dispose() {},
    },
    preferences,
    (target) => notificationAuthorized(communities, target),
  );
  const discover = () =>
    callbacks.receive([
      roster(relay, "room", [viewer.pubkey]),
      metadata(relay, "room", "Room"),
    ]);
  // Channels starts the same shared observation once the roster is ready.
  if (remote?.channelsMounted) {
    discover();
    void owner.session.unread.ensure();
  }
  const stop = bindMessageNotifications(notifications, communities);
  cleanups.push(stop);
  await flush();
  notifications.updatePreferences({ sound: false });
  const emit = (
    events: ReturnType<typeof message>[],
    phase?: "replay" | "live",
    channelId = "room",
  ) => callbacks.receive(events, phase ? { phase, channelId } : undefined);
  if (!remote?.channelsMounted && !remote?.deferRoster) discover();
  const make = (text: string, age = 0, author = peer) =>
    message(author, "room", text, Math.floor(Date.now() / 1000) - age, [
      ["p", viewer.pubkey],
    ]);
  return {
    owner,
    notifications,
    navigation,
    emit,
    make,
    show,
    permission,
    query,
    markerQuery,
    decode,
    stop,
    discover,
    peer,
    relay,
    viewer,
    click: () => click(),
    deselect() {
      selected = null;
      for (const listener of listeners) listener();
    },
  };
}
it.each([9, 40002])(
  "only production live kind-%s traffic can notify, never history/replay/local observation",
  async (kind) => {
    // Keep second-rounded fixtures outside the cutoff while signing/admitting.
    vi.spyOn(Date, "now").mockReturnValue(1_780_000_000_000);
    const h = await setup();
    const original = h.make;
    h.make = (text, age = 0, author = h.peer) =>
      signed(author, { ...original(text, age, author), kind });
    const historic = h.make("finite");
    h.query.mockResolvedValueOnce([historic]);
    await h.owner.session.read([{ ids: [historic.id], limit: 1 }]);
    h.emit([historic], "live");
    h.emit([h.make("legacy")]);
    h.emit([h.make("replay")], "replay");
    h.emit([h.make("wrong route")], "live", "elsewhere");
    h.emit(
      [h.make("stale", 121), h.make("future", -31), h.make("own", 0, h.viewer)],
      "live",
    );
    await flush();
    expect(h.show).not.toHaveBeenCalled();
    const fresh = h.make("fresh");
    h.emit([fresh, fresh], "live");
    await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(1));
    h.click();
    expect(h.navigation.navigation.snapshot().entry.target).toMatchObject({
      messageId: fresh.id,
    });
    expect(h.owner.session.unread.attention("room", fresh.id).unread).toBe(
      true,
    );
  },
);
it.each(
  [9, 40002].flatMap((kind) =>
    [
      { age: -30001, allowed: false },
      { age: -30000, allowed: true },
      { age: 120000, allowed: true },
      { age: 120001, allowed: false },
    ].map((boundary) => ({ kind, ...boundary })),
  ),
)(
  "live kind-$kind at age $age ms: notification allowed=$allowed",
  async ({ kind, age, allowed }) => {
    const createdAt = 1_780_000_000;
    vi.spyOn(Date, "now").mockReturnValue(createdAt * 1000 + age);
    const h = await setup();
    h.emit(
      [
        signed(h.peer, {
          kind,
          created_at: createdAt,
          content: "boundary",
          tags: [
            ["h", "room"],
            ["p", h.viewer.pubkey],
          ],
        }),
      ],
      "live",
    );
    await flush();
    expect(h.show).toHaveBeenCalledTimes(allowed ? 1 : 0);
  },
);
it("live membership activity and observer telemetry never become message notifications", async () => {
  const h = await setup();
  h.emit(
    [
      signed(h.relay, {
        kind: 40099,
        content: JSON.stringify({
          type: "member_joined",
          actor: h.viewer.pubkey,
          target: h.peer.pubkey,
        }),
        tags: [
          ["h", "room"],
          ["p", h.viewer.pubkey],
        ],
      }),
      signed(h.peer, {
        kind: 24200,
        content: "opaque",
        tags: [
          ["h", "room"],
          ["p", h.viewer.pubkey],
        ],
      }),
    ],
    "live",
  );
  await flush();
  expect(h.show).not.toHaveBeenCalled();
  h.emit([h.make("fresh after activity")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(1));
});

it("viewing suppression uses the shared lease, and suppressed candidates never become delayed alerts", async () => {
  const h = await setup();
  const row = h.make("visible");
  const lease = h.owner.session.unread.reading("room");
  const view = h.owner.session.observe([
    { kinds: [9], "#h": ["room"], limit: 50 },
  ]);
  view.subscribe(() => lease.view([row.id], () => true));
  h.emit([row], "live");
  await flush();
  expect(h.show).not.toHaveBeenCalled();
  lease.dispose();
  await h.notifications.requestPermission();
  await flush();
  expect(h.show).not.toHaveBeenCalled();
  h.notifications.updatePreferences({ notifyWhileViewing: true });
  const next = h.make("visible allowed");
  const visible = h.owner.session.unread.reading("room");
  view.subscribe(() => visible.view([next.id], () => true));
  h.emit([next], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(1));
  visible.dispose();
  view.dispose();
});
it("community switching stops new production but keeps prior scoped click intent", async () => {
  const h = await setup();
  const row = h.make("fresh");
  h.emit([row], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(1));
  h.deselect();
  h.click();
  // The real host navigation will select/check the target community and channel;
  // this service must not silently discard it because another community is selected.
  expect(h.navigation.navigation.snapshot().entry.target).toMatchObject({
    kind: "conversation",
    messageId: row.id,
    scope: { viewer: h.viewer.pubkey },
  });
  h.emit([h.make("unselected")], "live");
  await flush();
  expect(h.show).toHaveBeenCalledTimes(1);
});
it("authorized deletions in the same live batch cannot generate an alert", async () => {
  const h = await setup();
  const row = h.make("deleted");
  h.emit(
    [
      row,
      signed(h.peer, {
        kind: 5,
        tags: [["e", row.id]],
        content: "",
        created_at: row.created_at,
      }),
    ],
    "live",
  );
  await flush();
  expect(h.show).not.toHaveBeenCalled();
});

it("review: fresh incoming alert waits for initial unread readiness rather than becoming permanently quiet", async () => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await setup(ready);
  try {
    expect(h.owner.session.unread.sync().status).toBe("loading");
    const row = h.make("arrived during startup");
    h.emit([row], "live");
    await flush();
    expect(h.show).not.toHaveBeenCalled();
    release();
    await flush();
    expect(h.owner.session.unread.sync().status).toBe("local");
    expect(h.owner.session.unread.attention("room", row.id)).toMatchObject({
      status: "eligible",
      unread: true,
    });
    await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(1));
  } finally {
    release();
  }
});

it.each([
  "already-read",
  "expired",
  "revoked",
  "muted",
  "viewed",
  "switched",
] as const)(
  "a loading live candidate stays quiet after readiness when %s",
  async (condition) => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const now = Date.now();
    const h = await setup(
      barrier,
      condition === "already-read" ? Math.floor(now / 1000) + 10 : undefined,
    );
    try {
      const row = h.make("pending at startup");
      h.emit([row], "live");
      await flush();
      if (condition === "expired")
        vi.spyOn(Date, "now").mockReturnValue(now + 121000);
      if (condition === "revoked")
        h.emit([roster(h.relay, "room", [], Math.floor(now / 1000))]);
      if (condition === "muted")
        h.notifications.updatePreferences({ enabled: false });
      if (condition === "switched") h.deselect();
      if (condition === "viewed") {
        const lease = h.owner.session.unread.reading("room");
        lease.view([row.id], () => true);
        cleanups.push(lease.dispose);
      }
      release();
      await flush();
      expect(h.show).not.toHaveBeenCalled();
      await h.notifications.requestPermission();
      await flush();
      expect(h.show).not.toHaveBeenCalled();
    } finally {
      release();
    }
  },
);

it("review: channel revoke/regrant plus history restoration must not revive a pending live alert", async () => {
  const h = await setup();
  let finish!: (permission: "granted") => void;
  h.permission.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const row = h.make("pending before access removal");
  h.emit([row], "live");
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  const now = Math.floor(Date.now() / 1000);
  h.emit([roster(h.relay, "room", [], now + 1)]);
  h.emit([roster(h.relay, "room", [h.viewer.pubkey], now + 2)]);
  h.query.mockResolvedValueOnce([row]);
  await h.owner.session.read([{ ids: [row.id], limit: 1 }]);
  expect(h.owner.session.unread.attention("room", row.id)).toMatchObject({
    status: "eligible",
    unread: true,
  });
  finish("granted");
  await flush();
  expect(h.show).not.toHaveBeenCalled();
});

it("live message wiring supplies the signed author and body, resolving names at delivery without extra reads", async () => {
  const h = await setup();
  let release!: (permission: "granted") => void;
  h.permission.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const row = h.make("**Hello** [Wes](https://example.com/private)");
  h.emit([row], "live");
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  // Profile can arrive from the existing shared stream while permission is pending.
  h.emit([profile(h.peer, { display_name: "Pinky" })]);
  release("granted");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  expect(h.show.mock.calls[0]?.[0]).toMatchObject({
    title: "Pinky mentioned you in #Room",
    body: "Hello Wes",
  });
  expect(h.query).not.toHaveBeenCalled();
});

it.each([
  [9, "direct"],
  [9, "thread"],
  [40002, "direct"],
  [40002, "thread"],
] as const)(
  "live kind-%s %s messages carry the correct title and preview",
  async (kind, category) => {
    const h = await setup();
    h.emit([profile(h.peer, { name: "Pinky" })]);
    const now = Math.floor(Date.now() / 1000);
    const root = message(h.viewer, "room", "Own thread", now - 1);
    if (category === "direct") {
      h.emit([
        signed(h.relay, {
          kind: 39000,
          content: JSON.stringify({
            name: "internal-dm-id",
            channel_type: "dm",
          }),
          tags: [
            ["d", "room"],
            ["name", "internal-dm-id"],
            ["t", "dm"],
          ],
          created_at: now,
        }),
      ]);
    } else h.emit([root], "replay");
    const row = signed(h.peer, {
      kind,
      content:
        kind === 40002
          ? JSON.stringify({ content: "A **new** reply" })
          : "A **new** reply",
      created_at: now,
      tags: [
        ["h", "room"],
        ...(category === "thread" ? [["e", root.id, "", "reply"]] : []),
      ],
    });
    h.emit([row], "live");
    await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
    expect(h.show.mock.calls[0]?.[0]).toMatchObject({
      title:
        category === "direct"
          ? "Pinky sent you a direct message"
          : "Pinky replied in #Room",
      body: "A new reply",
    });
  },
);

function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it.each([
  ["bounded", false],
  ["bounded", true],
  ["snapshot", false],
  ["snapshot", true],
] as const)(
  "waits for %s remote marker merge (Channels consumer=%s), then revalidates retained live candidates",
  async (observation, channelsMounted) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const marker = deferred(),
      merge = deferred();
    const h = await setup(Promise.resolve(), undefined, {
      observation,
      channelsMounted,
      barrier: marker.promise,
      decodeBarrier: merge.promise,
      frontier: Math.floor(Date.now() / 1000) - 1,
    });
    try {
      // Without Channels this must be initiated by the actual app-global binding.
      await vi.waitFor(() => expect(h.markerQuery).toHaveBeenCalledOnce());
      expect(h.owner.session.unread.sync()).toMatchObject({
        status: "local",
        completeness: "unknown",
      });
      const read = h.make("already read on another device", 1),
        unread = h.make("genuinely unread");
      h.emit([read, unread], "live");
      await flush();
      expect(h.owner.session.unread.attention("room", read.id).unread).toBe(
        true,
      );
      expect(h.show).not.toHaveBeenCalled();
      marker.release();
      await vi.waitFor(() => expect(h.decode).toHaveBeenCalledOnce());
      await flush();
      expect(h.show).not.toHaveBeenCalled(); // Response alone is not a merged frontier.
      merge.release();
      await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
      expect(h.owner.session.unread.sync()).toMatchObject({
        status: "reconciled",
        completeness: observation,
      });
      expect(h.owner.session.unread.attention("room", read.id).unread).toBe(
        false,
      );
      expect(h.show.mock.calls[0]?.[0]).toMatchObject({
        body: "genuinely unread",
      });
      expect(h.markerQuery).toHaveBeenCalledOnce(); // Shared with Channels, not a second observation.
    } finally {
      marker.release();
      merge.release();
    }
  },
);

it.each(["failed", "cancelled", "switched", "disposed"] as const)(
  "remote marker observation keeps candidates quiet when %s",
  async (condition) => {
    const marker = deferred();
    const h = await setup(Promise.resolve(), undefined, {
      observation: "bounded",
      barrier: marker.promise,
      frontier: 0,
    });
    try {
      await vi.waitFor(() => expect(h.markerQuery).toHaveBeenCalledOnce());
      h.emit([h.make("pending remote state")], "live");
      await flush();
      expect(h.show).not.toHaveBeenCalled();
      if (condition === "failed" || condition === "cancelled")
        h.decode.mockRejectedValueOnce(
          condition === "failed"
            ? new Error("decode unavailable")
            : new DOMException("cancelled", "AbortError"),
        );
      if (condition === "switched") h.deselect();
      if (condition === "disposed") h.stop();
      marker.release();
      await vi.waitFor(() =>
        expect(h.owner.session.unread.sync().status).toBe(
          condition === "failed" || condition === "cancelled"
            ? "error"
            : "reconciled",
        ),
      );
      await h.notifications.requestPermission();
      await flush();
      expect(h.show).not.toHaveBeenCalled();
      expect(h.markerQuery).toHaveBeenCalledOnce();
    } finally {
      marker.release();
    }
  },
);

it.each([
  [
    JSON.stringify({ content: "**Decoded** preview", extra: "not displayed" }),
    "Decoded preview",
  ],
  [
    JSON.stringify({
      extra: "x".repeat(5000),
      content: "Text after envelope metadata",
    }),
    "Text after envelope metadata",
  ],
  [JSON.stringify({ content: "Long ".repeat(1000) }), null],
  ["Plain text fallback", "Plain text fallback"],
  [JSON.stringify({ content: "" }), "New message"],
])(
  "kind-40002 mentions decode their envelope before bounding the preview (case %#)",
  async (content, body) => {
    const h = await setup();
    const event = signed(h.peer, { ...h.make(content), kind: 40002 });
    h.emit([event], "live");
    await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
    const shown = h.show.mock.calls[0]?.[0];
    if (body !== null) expect(shown.body).toBe(body);
    else {
      expect([...shown.body].length).toBeLessThanOrEqual(200);
      expect(shown.body.startsWith("Long Long")).toBe(true);
    }
  },
);

it("notification startup waits for the roster without consuming the shared evidence repair early", async () => {
  const h = await setup(Promise.resolve(), undefined, {
    observation: "bounded",
    barrier: Promise.resolve(),
    frontier: 0,
    deferRoster: true,
  });
  expect(h.markerQuery).not.toHaveBeenCalled();
  expect(h.query).not.toHaveBeenCalled();
  h.discover();
  await h.owner.session.unread.ensure();
  expect(h.markerQuery).toHaveBeenCalledOnce();
  const evidence = () =>
    h.query.mock.calls.filter(([filters]) => filters[0]?.kinds?.includes(9));
  expect(evidence()).toHaveLength(1);
  expect(evidence()[0]?.[0][0]).toMatchObject({ "#h": ["room"] });
  h.discover();
  await h.owner.session.unread.ensure();
  expect(h.markerQuery).toHaveBeenCalledOnce();
  expect(evidence()).toHaveLength(1);
});

it.each(["direct", "thread"] as const)(
  "confirmed mute suppresses %s alerts but preserves unread and explicit mentions",
  async (category) => {
    vi.spyOn(Date, "now").mockReturnValue(1_780_000_000_000);
    const write = vi.fn<SidebarMuteMutator>(async ({ muted }) =>
      muted ? ["room"] : [],
    );
    const h = await setup(Promise.resolve(), undefined, undefined, {
      decode: async () => ({
        sections: [],
        assignments: {},
        starred: [],
        muted: [],
      }),
      write,
    });
    await h.owner.session.sidebarPreferences.ensure();
    const root = message(h.viewer, "room", "root", 1_779_999_999);
    if (category === "direct")
      h.emit([
        signed(h.relay, {
          kind: 39000,
          created_at: 1_780_000_000,
          content: JSON.stringify({ name: "Room", channel_type: "dm" }),
          tags: [
            ["d", "room"],
            ["name", "Room"],
            ["t", "dm"],
          ],
        }),
      ]);
    else h.emit([root], "replay");
    const make = (text: string) =>
      message(
        h.peer,
        "room",
        text,
        1_780_000_000,
        category === "thread" ? [["e", root.id, "", "reply"]] : [],
      );
    await h.owner.session.sidebarPreferences.setMute("room", true);
    const quiet = make("quiet");
    h.emit([quiet], "live");
    // Mention is an observable presentation barrier behind the muted candidate.
    h.emit([h.make("mention")], "live");
    await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
    expect(h.show.mock.calls[0]?.[0].body).toBe("mention");
    expect(h.owner.session.unread.attention("room", quiet.id).unread).toBe(
      true,
    );
    await h.owner.session.sidebarPreferences.setMute("room", false);
    h.emit([make("audible")], "live");
    await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(2));
    expect(h.show.mock.calls[1]?.[0].body).toBe("audible");
  },
);

it("a confirmed mute cancels an alert waiting on permission, even after unmute", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1_780_000_000_000);
  const h = await setup(Promise.resolve(), undefined, undefined, {
    decode: async () => ({
      sections: [],
      assignments: {},
      starred: [],
      muted: [],
    }),
    write: async ({ muted }) => (muted ? ["room"] : []),
  });
  await h.owner.session.sidebarPreferences.ensure();
  let release!: (permission: "granted") => void;
  h.permission.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const root = message(h.viewer, "room", "root", 1_779_999_999);
  const reply = message(h.peer, "room", "cancelled reply", 1_780_000_000, [
    ["e", root.id, "", "reply"],
  ]);
  h.emit([root], "replay");
  h.emit([reply], "live");
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  try {
    await h.owner.session.sidebarPreferences.setMute("room", true);
    await h.owner.session.sidebarPreferences.setMute("room", false);
  } finally {
    release("granted");
  }
  // A fresh candidate drains the presentation turn after permission resolves.
  h.emit([h.make("fresh mention")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  expect(h.show.mock.calls[0]?.[0].body).toBe("fresh mention");
  expect(h.owner.session.unread.attention("room", reply.id).unread).toBe(true);
});

it.each([true, false])(
  "initial mute read failure holds ordinary alerts until explicit retry (muted=%s), without Channels mounted",
  async (muted) => {
    vi.spyOn(Date, "now").mockReturnValue(1_780_000_000_000);
    const decode = vi
      .fn<SidebarDecoder>()
      .mockRejectedValueOnce(new Error("preferences unavailable"))
      .mockResolvedValue({
        sections: [],
        assignments: {},
        starred: [],
        muted: muted ? ["room"] : [],
      });
    const h = await setup(Promise.resolve(), undefined, undefined, { decode });
    await h.owner.session.sidebarPreferences.ensure();
    expect(h.owner.session.sidebarPreferences.snapshot().status).toBe("error");
    const root = message(h.viewer, "room", "root", 1_779_999_999);
    h.emit([root], "replay");
    const reply = message(h.peer, "room", "waiting", 1_780_000_000, [
      ["e", root.id, "", "reply"],
    ]);
    h.emit([reply], "live");
    // A mention bypasses only mute readiness, not existing read/permission policy.
    h.emit([h.make("mention")], "live");
    await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
    expect(h.show.mock.calls[0]?.[0].body).toBe("mention");
    await h.owner.session.sidebarPreferences.refresh();
    if (!muted) await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(2));
    else {
      h.emit([h.make("second mention")], "live");
      await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(2));
      expect(h.show.mock.calls[1]?.[0].body).toBe("second mention");
    }
    expect(decode).toHaveBeenCalledTimes(2);
  },
);
