import { expect, it, vi } from "vitest";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
  verifyEvent,
} from "nostr-tools";
import {
  assertSidebarMuteIntent,
  prepareSidebarMute,
  mutateSidebarMute,
} from "./sidebar-mutes.mjs";
import {
  decodeSidebarPreferences,
  SIDEBAR_REQUEST_BYTES,
} from "./sidebar-preferences.mjs";

function harness() {
  const secret = generateSecretKey();
  const viewer = getPublicKey(secret);
  return {
    secret,
    viewer,
    encrypt(channels, overrides = {}) {
      const key = nip44.v2.utils.getConversationKey(secret, viewer);
      try {
        return finalizeEvent(
          {
            kind: 30078,
            created_at: 100,
            tags: [["d", "channel-mutes"]],
            content: nip44.v2.encrypt(
              JSON.stringify({ version: 1, channels }),
              key,
            ),
            ...overrides,
          },
          secret,
        );
      } finally {
        key.fill(0);
      }
    },
  };
}
it("rejects invalid intent shapes before relay reads", async () => {
  const h = harness();
  for (const intent of [
    null,
    [],
    {},
    { channelId: "", muted: true },
    { channelId: "a" },
    { channelId: "a", muted: 1 },
    { channelId: "x".repeat(257), muted: true },
    { channelId: "a", muted: true, extra: 1 },
  ])
    expect(() => assertSidebarMuteIntent(intent)).toThrow(
      "Invalid sidebar mute intent",
    );
  const read = vi.fn();
  await expect(mutateSidebarMute({}, h.secret, read, vi.fn())).rejects.toThrow(
    "Invalid sidebar mute intent",
  );
  expect(read).not.toHaveBeenCalled();
});
it("encrypts explicit Mute/Unmute with monotonic timestamps and preserves unrelated tombstones", () => {
  const h = harness();
  const channels = {
    alpha: { muted: false, updatedAt: 60000 },
    beta: { muted: true, updatedAt: 2 },
    gone: { muted: false, updatedAt: 3 },
  };
  const added = prepareSidebarMute(
    [h.encrypt(channels)],
    { channelId: "alpha", muted: true },
    h.secret,
    50000,
  );
  expect(verifyEvent(added.event)).toBe(true);
  expect(added.event).toMatchObject({
    pubkey: h.viewer,
    kind: 30078,
    created_at: 101,
    tags: [
      ["d", "channel-mutes"],
      ["t", "channel-mutes"],
    ],
  });
  expect(added.event.content).not.toContain("alpha");
  expect(added.mutes.channels).toEqual({
    ...channels,
    alpha: { muted: true, updatedAt: 60001 },
  });
  expect(decodeSidebarPreferences([added.event], h.secret).muted).toEqual([
    "alpha",
    "beta",
  ]);
  const removed = prepareSidebarMute(
    [added.event],
    { channelId: "alpha", muted: false },
    h.secret,
    50000,
  );
  expect(removed.mutes.channels).toEqual({
    ...channels,
    alpha: { muted: false, updatedAt: 60002 },
  });
  expect(decodeSidebarPreferences([removed.event], h.secret).muted).toEqual([
    "beta",
  ]);
  expect(
    prepareSidebarMute(
      [removed.event],
      { channelId: "alpha", muted: false },
      h.secret,
    ).event,
  ).toBeUndefined();
  expect(
    prepareSidebarMute([], { channelId: "new", muted: false }, h.secret, 50000)
      .mutes.channels,
  ).toEqual({ new: { muted: false, updatedAt: 50000 } });
});
it("refuses untrusted, ambiguous, malformed and over-budget heads rather than seeding", () => {
  const h = harness(),
    other = harness();
  const intent = { channelId: "alpha", muted: true };
  const valid = h.encrypt({});
  for (const events of [
    null,
    [other.encrypt({})],
    [valid, valid],
    [{ ...JSON.parse(JSON.stringify(valid)), sig: "0".repeat(128) }],
    [h.encrypt({}, { tags: [["d", "channel-sections"]] })],
    [
      h.encrypt(
        {},
        {
          tags: [
            ["d", "channel-mutes"],
            ["d", "channel-mutes"],
          ],
        },
      ),
    ],
    [h.encrypt({ alpha: { muted: true, updatedAt: -1 } })],
    [h.encrypt({}, { content: "x".repeat(SIDEBAR_REQUEST_BYTES) })],
  ])
    expect(() => prepareSidebarMute(events, intent, h.secret)).toThrow();
  const full = Object.fromEntries(
    Array.from({ length: 500 }, (_, i) => [
      `id-${i}`,
      { muted: false, updatedAt: 1 },
    ]),
  );
  expect(() => prepareSidebarMute([h.encrypt(full)], intent, h.secret)).toThrow(
    "budget exceeded",
  );
});
it("confirms fresh retained state, including newer unrelated entries, and does not publish no-ops", async () => {
  const h = harness();
  let heads = [];
  const read = vi.fn(async () => heads);
  const publish = vi.fn(async () => {
    heads = [
      h.encrypt({
        alpha: { muted: true, updatedAt: 1 },
        beta: { muted: true, updatedAt: 2 },
      }),
    ];
  });
  const intent = { channelId: "alpha", muted: true };
  expect(
    (await mutateSidebarMute(intent, h.secret, read, publish)).channels,
  ).toHaveProperty("beta");
  expect(read).toHaveBeenCalledTimes(2);
  expect(publish).toHaveBeenCalledOnce();
  await mutateSidebarMute(intent, h.secret, read, publish);
  expect(publish).toHaveBeenCalledOnce();
});
it("does not report success on read/publish failures or conflicting confirmation", async () => {
  const h = harness(),
    intent = { channelId: "alpha", muted: true };
  const publish = vi.fn();
  await expect(
    mutateSidebarMute(
      intent,
      h.secret,
      async () => {
        throw new Error("read failed");
      },
      publish,
    ),
  ).rejects.toThrow("read failed");
  expect(publish).not.toHaveBeenCalled();
  const read = vi.fn(async () => []);
  await expect(
    mutateSidebarMute(intent, h.secret, read, async () => {
      throw new Error("publish failed");
    }),
  ).rejects.toThrow("publish failed");
  expect(read).toHaveBeenCalledOnce();
  await expect(
    mutateSidebarMute(intent, h.secret, read, publish),
  ).rejects.toThrow("changed on another device");
});
