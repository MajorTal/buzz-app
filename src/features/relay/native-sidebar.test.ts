import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { finalizeEvent, nip44 } from "nostr-tools";
import { connectNativeTransport } from "./native";
import { keypair } from "./testing";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));
const viewer = keypair();
const relay = keypair();
const community = "https://packaged.test";
const signal = new AbortController().signal;
const key = nip44.v2.utils.getConversationKey(viewer.secret, viewer.pubkey);
const records = new Map<string, ReturnType<typeof finalizeEvent>>();
const defaultValue = (coordinate: string) =>
  coordinate === "channel-sections"
    ? { version: 1, sections: [], assignments: {} }
    : coordinate === "channel-sort"
      ? { version: 1, groups: {} }
      : { version: 1, channels: {} };
function signedRecord(
  coordinate: string,
  value: unknown,
  created_at = 1_700_000_000,
) {
  return finalizeEvent(
    {
      kind: 30078,
      created_at,
      tags: [
        ["d", coordinate],
        ["t", coordinate],
      ],
      content: nip44.v2.encrypt(JSON.stringify(value), key),
    },
    viewer.secret,
  );
}
function decode(events: ReturnType<typeof finalizeEvent>[]) {
  const result: Record<string, unknown> = {};
  const seen = new Set<string>();
  for (const event of events) {
    const coordinate = event.tags.find(([name]) => name === "d")?.[1];
    if (
      event.kind !== 30078 ||
      event.pubkey !== viewer.pubkey ||
      !coordinate ||
      seen.has(coordinate) ||
      ![
        "channel-sections",
        "channel-stars",
        "channel-mutes",
        "channel-sort",
      ].includes(coordinate)
    )
      throw new Error("Invalid sidebar record");
    seen.add(coordinate);
    result[coordinate] = JSON.parse(nip44.v2.decrypt(event.content, key));
  }
  return result;
}
beforeEach(() => {
  records.clear();
  vi.mocked(invoke)
    .mockReset()
    .mockImplementation(async (command, args) => {
      if (command === "identity_restore") return viewer.pubkey;
      if (command === "relay_sign")
        return finalizeEvent(
          (args as { event: Parameters<typeof finalizeEvent>[0] }).event,
          viewer.secret,
        );
      if (command === "relay_decode_sidebar")
        return decode(
          (args as { events: ReturnType<typeof finalizeEvent>[] }).events,
        );
      if (command === "relay_sign_sidebar") {
        const { coordinate, payload, createdAt } = args as {
          coordinate: string;
          payload: unknown;
          createdAt: number;
        };
        return signedRecord(coordinate, payload, createdAt);
      }
      if (command === "relay_http") {
        const request = args as { path: string; body: string | null };
        if (request.path === "/")
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({ self: relay.pubkey }),
          };
        if (request.path === "/query") {
          const filters = JSON.parse(request.body ?? "[]") as {
            "#d": string[];
            consistency?: string;
          }[];
          expect(
            filters.every(
              (filter) =>
                filter.consistency === "strong" ||
                filter.consistency === undefined,
            ),
          ).toBe(true);
          const events = filters.flatMap((filter) =>
            filter["#d"].flatMap((coordinate) =>
              records.has(coordinate) ? [records.get(coordinate)] : [],
            ),
          );
          return { status: 200, headers: {}, body: JSON.stringify(events) };
        }
        if (request.path === "/events") {
          const event = JSON.parse(request.body ?? "null") as ReturnType<
            typeof finalizeEvent
          >;
          const coordinate = event.tags[0]?.[1] ?? "";
          records.set(coordinate, event);
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({
              accepted: true,
              event_id: event.id,
              message: "",
            }),
          };
        }
      }
      throw new Error(`Unexpected native command: ${command}`);
    });
});

it("decodes four self-encrypted coordinates through the narrow IPC command", async () => {
  for (const coordinate of [
    "channel-sections",
    "channel-stars",
    "channel-mutes",
    "channel-sort",
  ])
    records.set(coordinate, signedRecord(coordinate, defaultValue(coordinate)));
  const transport = await connectNativeTransport(community);
  const result = await transport.decodeSidebarPreferences?.(
    [...records.values()],
    signal,
  );
  expect(result).toMatchObject({
    sections: [],
    starred: [],
    muted: [],
    sort: {},
  });
  expect(invoke).toHaveBeenCalledWith("relay_decode_sidebar", {
    events: [...records.values()],
  });
  // Main also grants purpose-bound channel recipes (kind 30078); sidebar writes stay on narrow IPC.
  expect(transport.writer?.kinds).toContain(30078);
});

it("creates a section, moves a channel, stars, mutes and sorts with encrypted readback", async () => {
  const transport = await connectNativeTransport(community);
  const id = "12345678-1234-1234-1234-123456789abc";
  const groups = await transport.writeSidebarAssignment?.(
    { channelId: "c1", createSection: { id, name: "Work" } },
    signal,
  );
  expect(groups?.assignments).toEqual({ c1: id });
  expect(groups?.sections).toEqual([{ id, name: "Work", order: 0 }]);
  expect(
    await transport.writeSidebarStar?.(
      { channelId: "c1", starred: true },
      signal,
    ),
  ).toEqual(["c1"]);
  expect(
    await transport.writeSidebarMute?.(
      { channelId: "c1", muted: true },
      signal,
    ),
  ).toEqual(["c1"]);
  expect(
    await transport.writeSidebarSort?.(`section:${id}`, "recent", [id], signal),
  ).toEqual({ [`section:${id}`]: "recent" });
  expect(
    await transport.writeSidebarStar?.(
      { channelId: "c1", starred: false },
      signal,
    ),
  ).toEqual([]);
  expect(
    await transport.writeSidebarMute?.(
      { channelId: "c1", muted: false },
      signal,
    ),
  ).toEqual([]);
  const starRecord = records.get("channel-stars");
  expect(starRecord).toBeDefined();
  const star = decode(starRecord ? [starRecord] : [])["channel-stars"] as {
    channels: Record<string, { starred: boolean }>;
  };
  expect(star.channels.c1?.starred).toBe(false); // tombstone retained
  expect(
    await transport.writeSidebarSort?.(`section:${id}`, "alpha", [id], signal),
  ).toEqual({});
  expect(
    await transport.writeSidebarAssignment?.({ channelId: "c1" }, signal),
  ).toMatchObject({ assignments: {} });
  expect(records.size).toBe(4);
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "relay_sign_sidebar"),
  ).toHaveLength(8);
});

it("does not report a competing write as saved", async () => {
  const transport = await connectNativeTransport(community);
  let queryCount = 0;
  const original = vi.mocked(invoke).getMockImplementation();
  expect(original).toBeDefined();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (
      command === "relay_http" &&
      (args as { path?: string }).path === "/query" &&
      ++queryCount === 2
    )
      records.set(
        "channel-stars",
        signedRecord(
          "channel-stars",
          { version: 1, channels: {} },
          1_700_000_011,
        ),
      );
    return original?.(command, args);
  });
  await expect(
    transport.writeSidebarStar?.({ channelId: "c1", starred: true }, signal),
  ).rejects.toThrow("Sidebar stars changed on another device");
});

it("fails closed on unreadable heads and never signs or publishes them", async () => {
  records.set(
    "channel-stars",
    signedRecord("channel-stars", { version: 2, channels: {} }),
  );
  const transport = await connectNativeTransport(community);
  await expect(
    transport.writeSidebarStar?.({ channelId: "c1", starred: true }, signal),
  ).rejects.toThrow("Unsupported sidebar stars");
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => command === "relay_sign_sidebar"),
  ).toBe(false);
  expect(
    records.get("channel-stars") &&
      decode([
        records.get("channel-stars") as ReturnType<typeof finalizeEvent>,
      ])["channel-stars"],
  ).toMatchObject({ version: 2 });
});

it("does not sign a redundant intent or continue after cancellation", async () => {
  const transport = await connectNativeTransport(community);
  expect(
    await transport.writeSidebarStar?.(
      { channelId: "c1", starred: false },
      signal,
    ),
  ).toEqual([]);
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => command === "relay_sign_sidebar"),
  ).toBe(false);
  const controller = new AbortController();
  controller.abort();
  await expect(
    transport.writeSidebarStar?.(
      { channelId: "c1", starred: true },
      controller.signal,
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
});
