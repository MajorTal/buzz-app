import { assert, expect, it, vi } from "vitest";
import { readSessionWindow } from "./session-window";
import { foldMessages } from "./fold";
import { keypair, message, signed } from "./testing";
import type { RelayEvent } from "./events";

const author = keypair();
const root = message(author, "work", "Prompt", 10);
const reply = message(author, "work", "Answer", 11, [
  ["e", root.id, "", "reply"],
]);

it("reads threaded replies inline and closes edits and deletions before publishing", async () => {
  const edit = signed(author, {
    kind: 40003,
    content: "Edited",
    created_at: 12,
    tags: [["e", reply.id]],
  });
  const deletion = signed(author, {
    kind: 5,
    content: "",
    created_at: 13,
    tags: [["e", edit.id]],
  });
  const read = vi
    .fn<(...args: unknown[]) => Promise<readonly RelayEvent[]>>()
    .mockResolvedValueOnce([reply, root])
    .mockResolvedValueOnce([edit])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([deletion])
    .mockResolvedValueOnce([]);
  const page = await readSessionWindow({ read }, "work", null, {});
  expect(
    foldMessages("work", author.pubkey, page.events, {
      includeReplies: true,
    }).map((row) => row.content),
  ).toEqual(["Prompt", "Answer"]);
  expect(page.cursor).toEqual({ createdAt: root.created_at, eventId: root.id });
  expect(page.hasMore).toBe(true);
  expect(read.mock.calls[0]?.[0]).toEqual([
    { kinds: [9, 40002, 40099], "#h": ["work"], limit: 20 },
  ]);
});

it("keeps equal-time paging deterministic and rejects a repeated cursor", async () => {
  const sameTime = [
    message(author, "work", "A", 20),
    message(author, "work", "B", 20),
  ].sort((a, b) => a.id.localeCompare(b.id));
  const [first, second] = sameTime;
  assert(first && second);
  const cursor = { createdAt: 20, eventId: first.id };
  const read = vi
    .fn()
    .mockResolvedValueOnce([second])
    .mockResolvedValueOnce([]);
  expect(
    (await readSessionWindow({ read }, "work", cursor, {})).cursor?.eventId,
  ).toBe(second.id);
  expect(read.mock.calls[0]?.[0][0]).toMatchObject({
    until: 20,
    before_id: first.id,
  });
  await expect(
    readSessionWindow({ read: async () => [first] }, "work", cursor, {}),
  ).rejects.toThrow(/did not advance/);
  expect(
    await readSessionWindow({ read: async () => [] }, "work", cursor, {}),
  ).toMatchObject({ events: [], hasMore: false, cursor: null });
});

it("propagates failed overlay reads instead of showing incomplete message state", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce([reply])
    .mockRejectedValueOnce(new Error("offline"));
  await expect(readSessionWindow({ read }, "work", null, {})).rejects.toThrow(
    "offline",
  );
});
