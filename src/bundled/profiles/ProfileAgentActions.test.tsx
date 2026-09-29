// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  createAgentControl,
  type ControlSnapshot,
} from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import { profileTarget } from "../../features/profiles/target";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import { createRelaySession } from "../../features/relay/session";
import { ProfilePanel } from "./ProfilePanel";

const disposers: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(native = true) {
  const fixture = controlFixture();
  const control = createAgentControl(native ? fixture.host : null);
  const owner = createRelaySession(null);
  disposers.push(control.dispose, owner.dispose);
  const listeners = new Set<() => void>();
  let snapshot: RelaySnapshot = {
    status: "ready",
    generation: 1,
    session: owner.session,
    viewer: "cd".repeat(32),
    scope: `https://relay.example.test:${"cd".repeat(32)}`,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retry() {},
    disconnect() {},
    async clearCache() {},
  };
  const panel = (pubkey = fixture.agent.pubkey) => (
    <StrictMode>
      <ProfilePanel
        relay={relay}
        control={control}
        target={profileTarget(pubkey) ?? ""}
        close={() => {}}
      />
    </StrictMode>
  );
  const switchScope = (patch: Partial<RelaySnapshot>, notify = true) => {
    snapshot = { ...snapshot, ...patch };
    if (notify) for (const listener of listeners) listener();
  };
  return { ...fixture, control, relay, panel, switchScope };
}

it("dispatches Stop, Start and Restart to the exact local native ID, never a namesake or another relay", async () => {
  const h = setup();
  h.data.agents.unshift(
    { ...h.agent, id: "other-relay", relayUrl: "wss://other.test" },
    { ...h.agent, id: "namesake", pubkey: "ef".repeat(32) },
  );
  const user = userEvent.setup();
  render(h.panel());
  await user.click(await screen.findByRole("button", { name: "Stop" }));
  await user.click(await screen.findByRole("button", { name: "Start" }));
  await user.click(screen.getByRole("button", { name: "Restart" }));
  expect(h.calls.filter((call) => call.action !== "snapshot")).toEqual([
    { action: "stop", payload: { id: h.agent.id } },
    { action: "start", payload: { id: h.agent.id } },
    { action: "restart", payload: { id: h.agent.id } },
  ]);
});

it.each([
  "public identity",
  "other relay",
  "duplicate identity",
  "browser",
  "missing scope",
])("does not expose controls for %s", async (mode) => {
  const h = setup(mode !== "browser");
  if (mode === "other relay") h.agent.relayUrl = "wss://other.test";
  if (mode === "duplicate identity")
    h.data.agents.push({ ...h.agent, id: "duplicate" });
  if (mode === "missing scope") h.switchScope({ scope: "" });
  const view = render(
    h.panel(mode === "public identity" ? "ef".repeat(32) : undefined),
  );
  await act(() => h.control.refresh());
  expect(
    screen.queryByRole("region", { name: "Local agent actions" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /^(Start|Stop|Restart|Edit)$/ }),
  ).not.toBeInTheDocument();
  expect(h.calls.every((call) => call.action === "snapshot")).toBe(true);
  view.unmount();
});

it("blocks runtime-unavailable and transitioning launches but preserves recovery Stop", async () => {
  const h = setup();
  h.data.runtimeAvailable = false;
  h.data.runtimeMessage = "Runtime resources are missing.";
  render(h.panel());
  expect(
    await screen.findByText("Runtime resources are missing."),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Restart" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(screen.getByRole("button", { name: "Stop" })).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
  h.data.runtimeAvailable = true;
  h.agent.status = "starting";
  await act(() => h.control.refresh());
  expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
  expect(screen.getByRole("button", { name: "Restart" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(
    screen.getByText("Waiting for the process transition."),
  ).toBeInTheDocument();
});

it("disables duplicate pending commands, reports failure, and requires explicit status recovery", async () => {
  const h = setup();
  const pending = deferred<ControlSnapshot>();
  const action = vi
    .spyOn(h.host, "action")
    .mockImplementationOnce(() => pending.promise);
  const user = userEvent.setup();
  render(h.panel());
  await user.click(await screen.findByRole("button", { name: "Stop" }));
  try {
    expect(screen.getByRole("button", { name: "Stop" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("button", { name: "Restart" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(
      screen.getByText("Waiting for the host to confirm…"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(action).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () =>
      pending.reject("The host could not stop the process."),
    );
  }
  expect(
    screen.getByText(/The host could not stop the process/),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Showing the last host snapshot/),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Stop" })).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(screen.getByRole("button", { name: "Restart" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await user.click(screen.getByRole("button", { name: "Retry status" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Restart" })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    ),
  );
  await user.click(screen.getByRole("button", { name: "Restart" }));
  expect(action).toHaveBeenLastCalledWith(h.agent.id, "restart");
  expect(
    within(
      screen.getByRole("region", { name: "Local agent actions" }),
    ).queryByRole("alert"),
  ).not.toBeInTheDocument();
});

it("allows recovery Stop during a pending Start and ignores its late failure", async () => {
  const h = setup();
  h.agent.enabled = false;
  h.agent.status = "stopped";
  const pending = deferred<ControlSnapshot>();
  const action = vi
    .spyOn(h.host, "action")
    .mockImplementationOnce(() => pending.promise);
  const user = userEvent.setup();
  render(h.panel());
  await user.click(await screen.findByRole("button", { name: "Start" }));
  try {
    expect(screen.getByRole("button", { name: "Start" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("button", { name: "Restart" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("button", { name: "Stop" })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(action).toHaveBeenLastCalledWith(h.agent.id, "stop");
    expect(screen.getByRole("button", { name: "Restart" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  } finally {
    await act(async () => pending.reject("Retired launch failed."));
  }
  expect(
    within(
      screen.getByRole("region", { name: "Local agent actions" }),
    ).queryByRole("alert"),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Start" })).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

it.each(["periodic", "explicit"])(
  "recovers an initial read failure through %s read-only refresh",
  async (recovery) => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const h = setup();
    const read = vi
      .spyOn(h.host, "snapshot")
      .mockRejectedValueOnce("No host status");
    const user = userEvent.setup();
    render(h.panel());
    await screen.findByRole("button", { name: "Retry status" });
    expect(
      screen.queryByRole("button", { name: "Stop" }),
    ).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(4999));
    expect(read).toHaveBeenCalledTimes(1);
    if (recovery === "periodic") {
      await act(() => vi.advanceTimersByTimeAsync(1));
    } else {
      await user.click(screen.getByRole("button", { name: "Retry status" }));
    }
    expect(
      await screen.findByRole("button", { name: "Stop" }),
    ).not.toHaveAttribute("aria-disabled", "true");
    expect(read).toHaveBeenCalledTimes(2);
    expect(h.calls.every((call) => call.action === "snapshot")).toBe(true);
  },
);

it("fences retired relay clicks and tracks profile, community, reconnect and disconnect changes", async () => {
  const h = setup();
  const user = userEvent.setup();
  const view = render(h.panel());
  const stop = await screen.findByRole("button", { name: "Stop" });
  // Retire synchronously before React hears the subscription notification.
  h.switchScope({ scope: `https://other.test:${"cd".repeat(32)}` }, false);
  await user.click(stop);
  expect(h.calls.filter((call) => call.action !== "snapshot")).toEqual([]);
  act(() => h.switchScope({}));
  expect(
    screen.queryByRole("button", { name: "Stop" }),
  ).not.toBeInTheDocument();
  act(() =>
    h.switchScope({
      scope: `https://relay.example.test:${"cd".repeat(32)}`,
      generation: 2,
    }),
  );
  expect(
    await screen.findByRole("button", { name: "Stop" }),
  ).not.toHaveAttribute("aria-disabled", "true");
  view.rerender(h.panel("ef".repeat(32)));
  expect(
    screen.queryByRole("button", { name: "Stop" }),
  ).not.toBeInTheDocument();
  view.rerender(h.panel());
  expect(
    await screen.findByRole("button", { name: "Stop" }),
  ).not.toHaveAttribute("aria-disabled", "true");
  act(() => h.switchScope({ status: "disconnected" }));
  expect(
    screen.queryByRole("button", { name: "Stop" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByText("Connect to a community to view this profile."),
  ).toBeInTheDocument();
});

it("does not leak late completion into a replacement identity or dispose native execution on unmount", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const h = setup();
  const pending = deferred<ControlSnapshot>();
  vi.spyOn(h.host, "action").mockImplementationOnce(() => pending.promise);
  const read = vi.spyOn(h.host, "snapshot");
  const dispose = vi.spyOn(h.control, "dispose");
  const user = userEvent.setup();
  const view = render(h.panel());
  await user.click(await screen.findByRole("button", { name: "Restart" }));
  try {
    view.rerender(h.panel("ef".repeat(32)));
    expect(
      screen.queryByRole("button", { name: "Stop" }),
    ).not.toBeInTheDocument();
  } finally {
    await act(async () => pending.resolve(structuredClone(h.data)));
  }
  expect(
    screen.queryByRole("region", { name: "Local agent actions" }),
  ).not.toBeInTheDocument();
  view.unmount();
  const reads = read.mock.calls.length;
  await act(() => vi.advanceTimersByTimeAsync(15000));
  expect(read).toHaveBeenCalledTimes(reads);
  expect(dispose).not.toHaveBeenCalled();
  expect(h.control.snapshot().status).toBe("ready");
});

it("polls only while visible and ready, and releases the timer on unmount", async () => {
  vi.useFakeTimers();
  const h = setup();
  const read = vi.spyOn(h.host, "snapshot");
  const visibility = vi.spyOn(document, "visibilityState", "get");
  try {
    const view = render(h.panel());
    await act(() => h.control.refresh());
    expect(read).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(read).toHaveBeenCalledTimes(2);
    visibility.mockReturnValue("hidden");
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(read).toHaveBeenCalledTimes(2);
    visibility.mockReturnValue("visible");
    view.unmount();
    await act(() => vi.advanceTimersByTimeAsync(10000));
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    visibility.mockRestore();
  }
});

it("keeps unrelated command failures off a known non-owned profile", async () => {
  const h = setup();
  const view = render(h.panel("ef".repeat(32)));
  await act(() => h.control.refresh());
  vi.spyOn(h.host, "action").mockRejectedValueOnce("Unrelated launch failed.");
  await act(async () => {
    await h.control.action(h.agent.id, "start").catch(() => {});
  });
  expect(h.control.snapshot().status).toBe("error");
  expect(
    screen.queryByRole("region", { name: "Local agent actions" }),
  ).not.toBeInTheDocument();
  view.rerender(h.panel());
  expect(screen.getByText(/Unrelated launch failed/)).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Retry status" }),
  ).not.toHaveAttribute("aria-disabled", "true");
});

it.each([false, true])(
  "preserves Start focus on success without stealing moved focus (moved=%s)",
  async (moveFocus) => {
    const h = setup();
    h.agent.status = "stopped";
    h.agent.enabled = false;
    const pending = deferred<ControlSnapshot>();
    vi.spyOn(h.host, "action").mockImplementationOnce(() => pending.promise);
    const user = userEvent.setup();
    render(h.panel());
    const start = await screen.findByRole("button", { name: "Start" });
    start.focus();
    await user.keyboard("{Enter}");
    try {
      expect(h.control.snapshot().busy).toBe(true);
      expect(start).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(h.host.action).toHaveBeenCalledTimes(1);
      if (moveFocus) screen.getByRole("button", { name: "Copy npub" }).focus();
    } finally {
      await act(async () =>
        pending.resolve({
          ...h.data,
          agents: [{ ...h.agent, status: "running", enabled: true }],
        }),
      );
    }
    expect(
      screen.queryByRole("button", { name: "Start" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: moveFocus ? "Copy npub" : "Stop" }),
    ).toHaveFocus();
  },
);
