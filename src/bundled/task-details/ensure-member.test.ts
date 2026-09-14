import { test, expect, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import { ensureTaskMember } from "./ensure-member";

test("existing members need no membership write", async () => {
  const send = vi.fn();
  await ensureTaskMember(
    {
      channels: {
        list: () => ({ channels: [{ id: "channel", members: ["agent"] }] }),
      },
      outbox: { send },
    } as unknown as RelaySession,
    "channel",
    "agent",
  );
  expect(send).not.toHaveBeenCalled();
});

test("adds a bot and waits for the updated roster", async () => {
  vi.useFakeTimers();
  try {
    let members: string[] = [];
    const send = vi.fn(() => "event");
    const session = {
      channels: {
        list: () => ({ channels: [{ id: "channel", members }] }),
        refreshList: () => {
          members = ["agent"];
        },
      },
      outbox: { supports: () => true, send, snapshot: () => [] },
    } as unknown as RelaySession;
    const pending = ensureTaskMember(session, "channel", "agent");
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(send).toHaveBeenCalledWith({
      kind: 9000,
      content: "",
      tags: [
        ["h", "channel"],
        ["p", "agent"],
        ["role", "bot"],
      ],
    });
  } finally {
    vi.useRealTimers();
  }
});

test("rejected membership propagates before notification", async () => {
  const session = {
    channels: { list: () => ({ channels: [] }) },
    outbox: {
      supports: () => true,
      send: () => "event",
      snapshot: () => [
        { event: { id: "event" }, delivery: "failed", error: "Not an admin" },
      ],
    },
  } as unknown as RelaySession;
  await expect(ensureTaskMember(session, "channel", "agent")).rejects.toThrow(
    "Not an admin",
  );
});
