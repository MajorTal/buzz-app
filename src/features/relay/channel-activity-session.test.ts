import { assert, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import {
  flush,
  keypair,
  message,
  metadata,
  roster,
  scriptedTransport,
  signed,
} from "./testing";
import type { LiveCallbacks } from "./live";
import type { RelayEvent } from "./events";
function setup() {
  const viewer = keypair(),
    relay = keypair(),
    peer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const pending: {
    ids: readonly string[];
    signal: AbortSignal;
    resolve(events: RelayEvent[]): void;
    reject(error: Error): void;
  }[] = [];
  const activity = vi.fn(
    (ids: readonly string[], signal: AbortSignal) =>
      new Promise<RelayEvent[]>((resolve, reject) =>
        pending.push({ ids, signal, resolve, reject }),
      ),
  );
  const sort: Record<string, "recent"> = {};
  const owner = createRelaySession({
    ...wire.transport,
    channelActivity: activity,
    decodeSidebarPreferences: async () => ({
      sections: [],
      assignments: {},
      starred: [],
      muted: [],
      sort: {},
    }),
    writeSidebarSort: async (group, mode) => {
      if (mode === "recent") sort[group] = mode;
      else delete sort[group];
      return { ...sort };
    },
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, dispose() {}, retry() {} };
    },
  });
  const channels = owner.session.channels;
  const preferences = owner.session.sidebarPreferences;
  async function initial() {
    channels.ensureList();
    wire
      .next()
      .respond([
        roster(relay, "alpha", [viewer.pubkey]),
        roster(relay, "beta", [viewer.pubkey]),
        metadata(relay, "alpha", "Alpha"),
        metadata(relay, "beta", "Beta"),
      ]);
    await flush();
    const reading = preferences.ensure();
    await flush();
    wire.next().respond([]);
    await reading;
    live.state({ status: "connected", routes: [] });
  }
  return {
    owner,
    channels,
    preferences,
    pending,
    activity,
    wire,
    viewer,
    relay,
    peer,
    live: () => live,
    initial,
  };
}
it("reads no roster activity for A–Z, deduplicates Recent demand, and projects verified live activity monotonically", async () => {
  const h = setup();
  try {
    await h.initial();
    expect(h.activity).not.toHaveBeenCalled();
    await h.preferences.setSort("channels", "recent", []);
    expect(h.activity).toHaveBeenCalledOnce();
    expect(h.channels.list().activityStatus).toBe("loading");
    expect(h.pending[0]?.ids).toEqual(["alpha", "beta"]);
    take(h.pending).resolve([message(h.peer, "alpha", "history", 50)]);
    await flush();
    const first = h.channels.list();
    expect(first.activityStatus).toBe("ready");
    expect(first.channels.find((c) => c.id === "alpha")?.lastActivityAt).toBe(
      50,
    );
    expect(h.channels.list()).toBe(first);
    await h.preferences.setSort("dms", "recent", []);
    expect(h.activity).toHaveBeenCalledOnce();
    h.live().receive([message(h.peer, "alpha", "new", 90)]);
    h.live().receive([
      message(h.peer, "alpha", "older", 70),
      signed(h.peer, {
        kind: 39000,
        created_at: 200,
        tags: [["d", "beta"]],
        content: "metadata is not activity",
      }),
    ]);
    expect(
      h.channels.list().channels.find((c) => c.id === "alpha")?.lastActivityAt,
    ).toBe(90);
    expect(
      h.channels.list().channels.find((c) => c.id === "beta")?.lastActivityAt,
    ).toBeUndefined();
  } finally {
    h.owner.dispose();
  }
});
it("keeps other channels' summaries when one channel's live activity advances", async () => {
  const h = setup();
  try {
    await h.initial();
    h.live().receive([message(h.peer, "alpha", "a1", 50)]);
    h.live().receive([message(h.peer, "beta", "b1", 60)]);
    const find = (id: string) =>
      h.channels.list().channels.find((channel) => channel.id === id);
    const alpha = find("alpha");
    const beta = find("beta");
    expect(beta?.lastActivityAt).toBe(60);
    h.live().receive([message(h.peer, "alpha", "a2", 90)]);
    expect(find("alpha")).not.toBe(alpha);
    expect(find("alpha")?.lastActivityAt).toBe(90);
    expect(find("beta")).toBe(beta);
  } finally {
    h.owner.dispose();
  }
});
it("retries failed Recent activity after an explicit roster refresh", async () => {
  const h = setup();
  try {
    await h.initial();
    h.live().receive([message(h.peer, "alpha", "last good", 50)]);
    await h.preferences.setSort("channels", "recent", []);
    take(h.pending).reject(new Error("offline"));
    await flush();
    expect(h.channels.list().activityStatus).toBe("error");
    expect(h.preferences.snapshot().data?.sort).toEqual({ channels: "recent" });
    expect(
      h.channels.list().channels.find((c) => c.id === "alpha")?.lastActivityAt,
    ).toBe(50);

    h.channels.refreshList?.();
    h.wire
      .next()
      .respond([
        roster(h.relay, "alpha", [h.viewer.pubkey]),
        roster(h.relay, "beta", [h.viewer.pubkey]),
        metadata(h.relay, "alpha", "Alpha"),
        metadata(h.relay, "beta", "Beta"),
      ]);
    await flush();
    expect(h.activity).toHaveBeenCalledTimes(2);
    expect(h.channels.list().activityStatus).toBe("loading");
    expect(
      h.channels.list().channels.find((c) => c.id === "alpha")?.lastActivityAt,
    ).toBe(50);
    take(h.pending).resolve([
      message(h.peer, "alpha", "last good", 50),
      message(h.peer, "beta", "recovered", 100),
    ]);
    await flush();
    expect(h.channels.list().activityStatus).toBe("ready");
    expect(h.preferences.snapshot().data?.sort).toEqual({ channels: "recent" });
    expect(
      h.channels.list().channels.find((c) => c.id === "beta")?.lastActivityAt,
    ).toBe(100);
  } finally {
    h.owner.dispose();
  }
});
it("retires failed activity only when the last Recent demand ends and recovers on re-entry", async () => {
  const h = setup();
  try {
    await h.initial();
    h.live().receive([message(h.peer, "alpha", "last good", 50)]);
    await h.preferences.setSort("channels", "recent", []);
    await h.preferences.setSort("dms", "recent", []);
    take(h.pending).reject(new Error("offline"));
    await flush();
    expect(h.channels.list().activityStatus).toBe("error");

    // Another section still needs Recent; its fresh failure must remain visible.
    await h.preferences.setSort("channels", "alpha", []);
    take(h.pending).reject(new Error("still offline"));
    await flush();
    expect(h.channels.list().activityStatus).toBe("error");
    await h.preferences.setSort("dms", "alpha", []);
    expect(h.channels.list().activityStatus).toBe("idle");
    expect(h.preferences.snapshot().data?.sort).toEqual({});
    expect(
      h.channels.list().channels.find((c) => c.id === "alpha")?.lastActivityAt,
    ).toBe(50);
    expect(h.activity).toHaveBeenCalledTimes(2);

    await h.preferences.setSort("channels", "recent", []);
    expect(h.channels.list().activityStatus).toBe("loading");
    take(h.pending).reject(new Error("fresh failure"));
    await flush();
    expect(h.channels.list().activityStatus).toBe("error");
    await h.preferences.setSort("channels", "alpha", []);
    expect(h.channels.list().activityStatus).toBe("idle");
    await h.preferences.setSort("channels", "recent", []);
    expect(h.activity).toHaveBeenCalledTimes(4);
    take(h.pending).resolve([message(h.peer, "alpha", "recovered", 120)]);
    await flush();
    expect(h.channels.list().activityStatus).toBe("ready");
    expect(
      h.channels.list().channels.find((c) => c.id === "alpha")?.lastActivityAt,
    ).toBe(120);
    expect(h.preferences.snapshot().data?.sort).toEqual({ channels: "recent" });
  } finally {
    h.owner.dispose();
  }
});
it("cancels only after the last Recent section clears and refreshes unchanged rosters on re-entry", async () => {
  const h = setup();
  try {
    await h.initial();
    await h.preferences.setSort("channels", "recent", []);
    const retired = take(h.pending);
    await h.preferences.setSort("dms", "recent", []);
    await h.preferences.setSort("channels", "alpha", []);
    expect(retired.signal.aborted).toBe(false);
    expect(h.activity).toHaveBeenCalledOnce();
    await h.preferences.setSort("dms", "alpha", []);
    expect(retired.signal.aborted).toBe(true);
    expect(h.channels.list().activityStatus).toBe("idle");
    // Ignoring transport cancellation must not let late history win. Live
    // activity remains valid even while every section is A–Z.
    retired.resolve([message(h.peer, "alpha", "retired history", 200)]);
    h.live().receive([message(h.peer, "alpha", "live", 90)]);
    await flush();
    expect(
      h.channels.list().channels.find((c) => c.id === "alpha")?.lastActivityAt,
    ).toBe(90);
    await h.preferences.setSort("channels", "recent", []);
    expect(h.activity).toHaveBeenCalledTimes(2);
    const resumed = take(h.pending);
    expect(resumed.ids).toEqual(["alpha", "beta"]);
    resumed.resolve([message(h.peer, "alpha", "fresh history", 120)]);
    await flush();
    expect(h.channels.list().activityStatus).toBe("ready");
    expect(
      h.channels.list().channels.find((c) => c.id === "alpha")?.lastActivityAt,
    ).toBe(120);
    // Completed data stays useful, but a new demand lifetime still refreshes it.
    await h.preferences.setSort("channels", "alpha", []);
    expect(
      h.channels.list().channels.find((c) => c.id === "alpha")?.lastActivityAt,
    ).toBe(120);
    await h.preferences.setSort("channels", "recent", []);
    expect(h.activity).toHaveBeenCalledTimes(3);
    take(h.pending).resolve([]);
    await flush();
  } finally {
    h.owner.dispose();
  }
});
it.each(["clear", "dispose", "revoke", "disconnect"] as const)(
  "%s fences activity reads and cannot leak late data into a new lifetime",
  async (action) => {
    const h = setup();
    try {
      await h.initial();
      await h.preferences.setSort("channels", "recent", []);
      const request = take(h.pending);
      if (action === "clear") await h.owner.clearCache();
      if (action === "dispose") h.owner.dispose();
      if (action === "revoke")
        h.live().receive([
          roster(h.relay, "alpha", [], Math.floor(Date.now() / 1000) + 1),
        ]);
      if (action === "disconnect")
        h.live().state({ status: "retrying", routes: [] });
      expect(request.signal.aborted).toBe(true);
      request.resolve([message(h.peer, "alpha", "retired", 100)]);
      await flush();
      expect(
        h.channels.list().channels.find((c) => c.id === "alpha")
          ?.lastActivityAt,
      ).toBeUndefined();
    } finally {
      h.owner.dispose();
    }
  },
);

function take<T>(pending: T[]): T {
  const next = pending.shift();
  assert.exists(next, "Expected a pending operation");
  return next;
}
