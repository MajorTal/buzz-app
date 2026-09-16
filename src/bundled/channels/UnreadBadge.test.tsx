// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import { UnreadOptions } from "./UnreadBadge";

afterEach(cleanup);

function session(rows: { id: string; membership?: unknown }[]) {
  const markThrough = vi.fn().mockResolvedValue(undefined);
  const sync = {
    capability: "frontier-sync",
    status: "reconciled",
    error: null,
  } as const;
  const unread = {
    subscribeSync: () => () => {},
    sync: () => sync,
    markUnreadLocal: vi.fn().mockResolvedValue(undefined),
    markThrough,
    refresh: vi.fn().mockResolvedValue(undefined),
    retrySync: vi.fn().mockResolvedValue(undefined),
  };
  return {
    value: {
      unread,
      channels: { window: () => ({ rows }) },
    } as unknown as RelaySession,
    markThrough,
  };
}

it("marks through the newest verified message, never trailing membership activity", async () => {
  const h = session([
    { id: "older" },
    { id: "newest-chat" },
    { id: "membership", membership: {} },
  ]);
  render(
    <StrictMode>
      <UnreadOptions session={h.value} channelId="room" />
    </StrictMode>,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Mark read through loaded messages" }),
  );
  expect(h.markThrough).toHaveBeenCalledExactlyOnceWith(
    { kind: "channel", channelId: "room" },
    "newest-chat",
  );
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("keeps manual intent when only membership activity is loaded", async () => {
  const h = session([{ id: "membership", membership: {} }]);
  render(
    <StrictMode>
      <UnreadOptions session={h.value} channelId="room" />
    </StrictMode>,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Mark read through loaded messages" }),
  );
  expect(h.markThrough).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Load a verified message before marking through it.",
  );
});
