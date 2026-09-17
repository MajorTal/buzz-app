import { expect, it, vi } from "vitest";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
  verifyEvent,
} from "nostr-tools";
import { prepareSidebarSort, mutateSidebarSort } from "./sidebar-sort.mjs";
import { projectSidebarPreferences } from "../src/features/relay/sidebar-preferences.ts";
function harness() {
  const secret = generateSecretKey(),
    viewer = getPublicKey(secret);
  const key = nip44.v2.utils.getConversationKey(secret, viewer);
  return {
    secret,
    viewer,
    encrypt(blob, overrides = {}) {
      return finalizeEvent(
        {
          kind: 30078,
          created_at: 100,
          tags: [["d", "channel-sort"]],
          content: nip44.v2.encrypt(JSON.stringify(blob), key),
          ...overrides,
        },
        secret,
      );
    },
    decode(event) {
      return JSON.parse(nip44.v2.decrypt(event.content, key));
    },
  };
}
const intent = { group: "section:work", mode: "recent", sectionIds: ["work"] };
it("mutates only the selected override, preserves unprojected data, and encodes alpha as absence", () => {
  const h = harness();
  const blob = {
    version: 1,
    future: { x: 1 },
    groups: {
      channels: "recent",
      "section:elsewhere": "recent",
      future: "next-mode",
    },
  };
  const draft = prepareSidebarSort([h.encrypt(blob)], intent, h.secret, 50_000);
  expect(verifyEvent(draft.event)).toBe(true);
  expect(draft.event.created_at).toBe(101);
  expect(h.decode(draft.event)).toEqual({
    ...blob,
    groups: { ...blob.groups, "section:work": "recent" },
  });
  expect(draft.groups).toEqual({
    channels: "recent",
    "section:work": "recent",
  });
  const alpha = prepareSidebarSort(
    [draft.event],
    { ...intent, mode: "alpha" },
    h.secret,
    50_000,
  );
  expect(h.decode(alpha.event)).toEqual(blob);
  expect(alpha.event.created_at).toBe(102);
  expect(
    prepareSidebarSort([alpha.event], { ...intent, mode: "alpha" }, h.secret)
      .event,
  ).toBeUndefined();
});
it("rejects invalid intent before reading, and ambiguous/untrusted/invalid heads before publishing", async () => {
  const h = harness(),
    other = harness();
  const read = vi.fn(),
    publish = vi.fn();
  for (const invalid of [
    null,
    {},
    { ...intent, group: "group:work" },
    { ...intent, mode: "unknown" },
    { ...intent, sectionIds: [" "] },
    { ...intent, extra: 1 },
  ]) {
    await expect(
      mutateSidebarSort(invalid, h.secret, read, publish),
    ).rejects.toThrow();
  }
  expect(read).not.toHaveBeenCalled();
  const valid = h.encrypt({ version: 1, groups: {} });
  for (const heads of [
    null,
    [valid, valid],
    [other.encrypt({ version: 1, groups: {} })],
    [{ ...JSON.parse(JSON.stringify(valid)), sig: "0".repeat(128) }],
    [h.encrypt({ version: 2, groups: {} })],
    [h.encrypt({ version: 1, groups: [] })],
    [h.encrypt({ version: 1, groups: {} }, { tags: [["d", "channel-stars"]] })],
    [h.encrypt({ version: 1, groups: {} }, { content: "not encrypted" })],
  ]) {
    await expect(
      mutateSidebarSort(intent, h.secret, async () => heads, publish),
    ).rejects.toThrow();
  }
  expect(publish).not.toHaveBeenCalled();
});
it("confirms newer unrelated choices, rejects a replaced intent, and never seeds after a failed read", async () => {
  const h = harness();
  let heads = [];
  const read = vi.fn(async () => heads);
  const publish = vi.fn(async () => {
    heads = [
      h.encrypt({
        version: 1,
        groups: { "section:work": "recent", forums: "recent" },
      }),
    ];
  });
  expect(await mutateSidebarSort(intent, h.secret, read, publish)).toEqual({
    "section:work": "recent",
    forums: "recent",
  });
  expect(read).toHaveBeenCalledTimes(2);
  await mutateSidebarSort(intent, h.secret, read, publish);
  expect(publish).toHaveBeenCalledOnce();
  heads = [];
  await expect(
    mutateSidebarSort(intent, h.secret, read, async () => {}),
  ).rejects.toThrow("changed on another device");
  await expect(
    mutateSidebarSort(
      intent,
      h.secret,
      async () => {
        throw new Error("offline");
      },
      publish,
    ),
  ).rejects.toThrow("offline");
  expect(publish).toHaveBeenCalledOnce();
});
it("projection accepts full-length section keys, rejects over-budget data, and ignores unknown keys/modes", () => {
  const id = "x".repeat(256);
  expect(
    projectSidebarPreferences(
      undefined,
      undefined,
      {
        version: 1,
        groups: {
          [`section:${id}`]: "recent",
          channels: "recent",
          future: "recent",
          dms: "unknown",
        },
      },
      [id],
    ).sort,
  ).toEqual({ [`section:${id}`]: "recent", channels: "recent" });
  expect(() =>
    projectSidebarPreferences(undefined, undefined, {
      version: 1,
      groups: Object.fromEntries(
        Array.from({ length: 105 }, (_, i) => [`section:${i}`, "recent"]),
      ),
    }),
  ).toThrow("budget exceeded");
});
