// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RelaySession } from "../relay/session";
import type { AgentLibrarySnapshot } from "../agents/library";
import { SessionAgentControl } from "./SessionAgentControl";

afterEach(cleanup);
it("retries the failed library and updates the picker when a second agent joins", async () => {
  const viewer = "a".repeat(64),
    agent = "b".repeat(64),
    other = "c".repeat(64);
  let roster = {
    channels: [{ id: "session", name: "Work", members: [viewer, agent] }],
  };
  const profiles = new Map([
    [viewer, { name: "Kenny" }],
    [agent, { name: "Helper" }],
    [other, { name: "Second", isAgent: true as const }],
  ]);
  let library: AgentLibrarySnapshot = {
    status: "error",
    definitions: [],
    identities: [],
  };
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const refresh = vi.fn(async () => {
    library = {
      status: "ready",
      definitions: [],
      identities: [{ pubkey: agent, name: "Helper" }],
    };
    for (const listener of listeners) listener();
  });
  const ensure = vi.fn(async () => {});
  const session = {
    viewer,
    channels: { list: () => roster, subscribeList: subscribe },
    profiles: { snapshot: () => profiles, subscribe, ensure },
    agentLibrary: { snapshot: () => library, subscribe, refresh },
  } as unknown as RelaySession;
  render(
    <SessionAgentControl
      session={session}
      channelId="session"
      value=""
      onChange={() => {}}
      disabled={false}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Choose an agent" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Retry agent list" }),
  );
  await user.keyboard("{Escape}");
  expect(refresh).toHaveBeenCalledOnce();
  expect(
    await screen.findByRole("button", { name: "Change agent: Helper" }),
  ).toBeInTheDocument();
  act(() => {
    roster = {
      channels: [
        { id: "session", name: "Work", members: [viewer, agent, other] },
      ],
    };
    for (const listener of listeners) listener();
  });
  expect(
    await screen.findByRole("button", { name: "Choose an agent" }),
  ).toBeInTheDocument();
  expect(ensure).toHaveBeenCalledWith([viewer, agent, other], "background");
});
