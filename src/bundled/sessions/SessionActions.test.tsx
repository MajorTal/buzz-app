// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import { SessionActions } from "./SessionActions";

afterEach(cleanup);

function setup(failed = true) {
  const channel = {
    id: "session",
    name: "Work",
    channelType: "session" as const,
  };
  const snapshot = { status: "ready", channels: [channel] };
  const library = {
    status: "ready",
    definitions: [],
    identities: [
      { pubkey: "a".repeat(64), name: "Fizz" },
      { pubkey: "b".repeat(64), name: "Other" },
    ],
  };
  const workSessions = {
    invite: vi.fn(() => "c".repeat(64)),
    delivered: vi.fn<(id: string) => Promise<void>>(async () => {
      throw new Error(failed ? "Invitation rejected" : "Delivery uncertain");
    }),
    refresh: vi.fn(async () => {}),
    failed: vi.fn(() => failed),
    discardFailed: vi.fn(async () => {}),
  };
  const session = {
    workSessions,
    channels: {
      list: () => snapshot,
      subscribeList: () => () => {},
      ensureList: () => {},
    },
    agentLibrary: {
      snapshot: () => library,
      subscribe: () => () => {},
    },
  } as unknown as RelaySession;
  render(<SessionActions session={session} channel={channel} />);
  const user = userEvent.setup();
  async function invite() {
    await user.click(screen.getByRole("button", { name: "Invite an agent" }));
    await user.click(screen.getByRole("button", { name: "Choose an agent" }));
    await user.click(
      await screen.findByRole("menuitemradio", { name: "Fizz" }),
    );
    await user.click(screen.getByRole("button", { name: "Invite" }));
    await screen.findByRole("alert");
  }
  return { user, workSessions, invite };
}

it("unlocks a rejected invitation only after its failed operation is dismissed", async () => {
  const test = setup();
  let releaseDismissal = () => {};
  const dismissed = new Promise<void>((resolve) => {
    releaseDismissal = resolve;
  });
  test.workSessions.discardFailed.mockImplementation(() => dismissed);
  await test.invite();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await test.user.click(
    screen.getByRole("button", { name: "Choose another agent" }),
  );
  await waitFor(() =>
    expect(test.workSessions.discardFailed).toHaveBeenCalledWith(
      "c".repeat(64),
    ),
  );
  try {
    expect(
      screen.getByRole("button", { name: "Change agent: Fizz" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  } finally {
    await act(async () => releaseDismissal());
  }
  expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  await test.user.click(
    screen.getByRole("button", { name: "Choose an agent" }),
  );
  await test.user.click(
    await screen.findByRole("menuitemradio", { name: "Other" }),
  );
  test.workSessions.delivered.mockResolvedValueOnce(undefined);
  await test.user.click(screen.getByRole("button", { name: "Invite" }));
  await screen.findByRole("button", { name: "Invite an agent" });
  expect(test.workSessions.invite).toHaveBeenLastCalledWith(
    "session",
    "b".repeat(64),
  );
});

it("retains an uncertain invitation and retries the same operation", async () => {
  const test = setup(false);
  await test.invite();
  expect(
    screen.queryByRole("button", { name: "Choose another agent" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  test.workSessions.delivered.mockResolvedValueOnce(undefined);
  await test.user.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("button", { name: "Invite an agent" });
  expect(test.workSessions.invite).toHaveBeenCalledOnce();
  expect(test.workSessions.delivered).toHaveBeenNthCalledWith(
    2,
    "c".repeat(64),
  );
  expect(test.workSessions.discardFailed).not.toHaveBeenCalled();
});

it("keeps the operation locked when dismissal fails", async () => {
  const test = setup();
  test.workSessions.discardFailed.mockRejectedValueOnce(
    new Error("Could not dismiss"),
  );
  await test.invite();
  await test.user.click(
    screen.getByRole("button", { name: "Choose another agent" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("Could not dismiss"),
  );
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Change agent: Fizz" }),
  ).toBeDisabled();
});
