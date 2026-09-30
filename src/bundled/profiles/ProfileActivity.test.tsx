// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentActivity } from "../../features/agents/activity";
import { activityTarget } from "../../features/agents/activity-target";
import { createRelaySession } from "../../features/relay/session";
import type { PanelProps } from "../../features/panels/service";
import { ProfileActivity } from "./ProfileActivity";

const agent = "a".repeat(64);
const foreign = "b".repeat(64);
const disposers: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
});
function fixture(available = true) {
  const observe = vi.fn();
  let allowed = true;
  const owner = createAgentActivity(available, observe, () => allowed);
  const base = createRelaySession(null);
  const session = { ...base.session, agentActivity: owner.queries };
  disposers.push(
    () => owner.dispose(),
    () => base.dispose(),
  );
  const context = {
    channelId: "channel-a",
    canOpen: vi.fn(() => true),
    open: vi.fn(() => true),
    push: vi.fn(() => true),
  };
  const release = owner.queries.activate();
  let serial = 0;
  function send(
    pubkey = agent,
    channelId: string | null = "channel-a",
    kind = "turn_started",
    payload: unknown = { secret: "never render raw telemetry" },
  ) {
    owner.receive(
      {
        id: (++serial).toString(16).padStart(64, "0"),
        agent: pubkey,
        createdAt: Math.floor(Date.now() / 1000),
        plaintext: JSON.stringify({
          kind,
          channelId,
          turnId: String(serial),
          timestamp: new Date().toISOString(),
          payload,
        }),
      },
      observe.mock.lastCall?.[0] as number,
    );
  }
  const listening = () =>
    owner.state({
      status: "connected",
      routes: [{ id: "observer", status: "live", replay: "unknown" }],
    });
  const view = (pubkey = agent, ctx: PanelProps["context"] = context) => (
    <StrictMode>
      <ProfileActivity session={session} pubkey={pubkey} context={ctx} />
    </StrictMode>
  );
  return {
    owner,
    session,
    context,
    observe,
    release,
    send,
    listening,
    view,
    deny() {
      allowed = false;
      owner.clear();
    },
  };
}
it("renders connecting, empty, and unavailable without inferring idle or ownership", () => {
  const f = fixture();
  const mounted = render(f.view());
  expect(screen.getByRole("status")).toHaveTextContent("Connecting");
  act(f.listening);
  expect(screen.getByRole("status")).toHaveTextContent("No activity yet");
  const unavailable = fixture(false);
  mounted.rerender(unavailable.view());
  expect(screen.getByRole("status")).toHaveTextContent("Activity unavailable");
  expect(screen.getByRole("button", { name: "View activity" })).toBeEnabled();
  expect(unavailable.observe).not.toHaveBeenCalled();
});
it("projects only this identity and channel, excludes unscoped/foreign data, and opens exact context", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-23T12:00:00Z"));
  const f = fixture();
  f.listening();
  f.send();
  vi.setSystemTime(new Date("2026-09-23T12:05:00Z"));
  f.send(agent, "channel-a", "turn_completed");
  vi.setSystemTime(new Date("2026-09-23T12:10:00Z"));
  f.send(foreign);
  f.send(agent, "channel-b");
  f.send(agent, null);
  const mounted = render(f.view());
  expect(
    screen.getByRole("heading", { name: "Latest activity" }),
  ).toBeVisible();
  expect(screen.getByRole("status").querySelector("time")).toHaveAttribute(
    "datetime",
    "2026-09-23T12:05:00.000Z",
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    new Date("2026-09-23T12:05:00Z").toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }),
  );
  expect(
    screen.queryByText(/working|unknown|ended|telemetry/i),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText(/never render raw telemetry/),
  ).not.toBeInTheDocument();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "View activity" }));
  expect(f.context.push).toHaveBeenCalledWith(
    activityTarget(agent, "channel-a"),
  );
  mounted.rerender(f.view("c".repeat(64)));
  expect(screen.getByRole("status")).toHaveTextContent("No activity yet");
  expect(
    screen.getByRole("status").querySelector("time"),
  ).not.toBeInTheDocument();
  mounted.rerender(f.view(agent, { ...f.context, channelId: "channel-b" }));
  expect(screen.getByRole("status").querySelector("time")).toHaveAttribute(
    "datetime",
    "2026-09-23T12:10:00.000Z",
  );
});
it("keeps the observed timestamp when evidence ages and reports disconnection", () => {
  vi.useFakeTimers();
  const f = fixture();
  f.listening();
  f.send();
  render(f.view());
  expect(screen.getByRole("status").querySelector("time")).toBeInTheDocument();
  const timestamp = screen.getByRole("status").querySelector("time")?.dateTime;
  act(() => vi.advanceTimersByTime(61_000));
  expect(screen.getByRole("status").querySelector("time")).toHaveAttribute(
    "datetime",
    timestamp,
  );
  act(() => f.owner.state({ status: "retrying", routes: [] }));
  expect(screen.getByRole("status")).toHaveTextContent("Activity disconnected");
  act(f.listening);
  expect(screen.getByRole("status").querySelector("time")).toHaveAttribute(
    "datetime",
    timestamp,
  );
});
it("never starts capture, releases the React subscription, and hides when the plugin is disabled", () => {
  const f = fixture();
  f.listening();
  f.send();
  const mounted = render(f.view());
  expect(f.observe).toHaveBeenCalledTimes(1);
  mounted.unmount();
  expect(f.owner.queries.snapshot().status).toBe("listening");
  expect(f.observe).toHaveBeenCalledTimes(1);
  render(f.view());
  act(f.release);
  expect(
    screen.queryByRole("region", { name: "Activity preview" }),
  ).not.toBeInTheDocument();
  act(() => {
    f.owner.queries.activate();
    f.listening();
  });
  expect(screen.getByRole("status")).toHaveTextContent("No activity yet");
});
it("does not broaden missing context or render when the destination is unavailable", () => {
  const f = fixture();
  f.send();
  const mounted = render(
    <ProfileActivity session={f.session} pubkey={agent} context={undefined} />,
  );
  expect(screen.queryByRole("region")).not.toBeInTheDocument();
  mounted.rerender(f.view(agent, { ...f.context, channelId: "" }));
  expect(screen.queryByRole("region")).not.toBeInTheDocument();
  f.context.canOpen.mockReturnValue(false);
  mounted.rerender(f.view());
  expect(screen.queryByRole("region")).not.toBeInTheDocument();
});
it("drops retained signals on access reset and rejects late deliveries", () => {
  const f = fixture();
  f.listening();
  f.send();
  render(f.view());
  expect(screen.getByRole("status").querySelector("time")).toBeInTheDocument();
  act(() => {
    f.deny();
    f.send();
    f.listening();
  });
  expect(screen.getByRole("status")).toHaveTextContent("No activity yet");
  expect(
    screen.getByRole("status").querySelector("time"),
  ).not.toBeInTheDocument();
});
it("switches snapshots synchronously without requiring a parent remount key", () => {
  const old = fixture();
  old.listening();
  old.send();
  const next = fixture();
  next.listening();
  const mounted = render(old.view());
  expect(screen.getByRole("status").querySelector("time")).toBeInTheDocument();
  mounted.rerender(next.view());
  expect(screen.getByRole("status")).toHaveTextContent("No activity yet");
  act(() => old.send());
  expect(screen.getByRole("status")).toHaveTextContent("No activity yet");
  act(() => next.send());
  expect(screen.getByRole("status").querySelector("time")).toBeInTheDocument();
});

it("renders live text safely and clears content on profile changes and access loss", () => {
  const f = fixture();
  f.listening();
  const mounted = render(f.view());
  const update = (value: unknown) => ({
    method: "session/update",
    params: { update: value },
  });
  act(() =>
    f.send(
      agent,
      "channel-a",
      "acp_read",
      update({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "<img src=x onerror=alert(1)> Checking the tests.",
        },
      }),
    ),
  );
  expect(
    screen.getByRole("list", { name: "Recent activity" }),
  ).toHaveTextContent("Checking the tests.");
  expect(mounted.container.querySelector("img")).toBeNull();
  mounted.rerender(f.view(foreign));
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
  mounted.rerender(f.view());
  expect(screen.getByRole("list")).toHaveTextContent("Checking the tests.");
  act(f.deny);
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
});

it("renders separate unkeyed segments and a safe tool from a deeply nested batch", () => {
  const f = fixture();
  f.listening();
  render(f.view());
  let rawOutput: unknown = "excluded result";
  for (let i = 0; i < 1500; i++) rawOutput = [rawOutput];
  const event = (update: unknown) => ({
    kind: "acp_read",
    channelId: "channel-a",
    sessionId: "session",
    turnId: "turn",
    payload: { method: "session/update", params: { update } },
  });
  const chunk = (text: string) =>
    event({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    });
  act(() =>
    f.send(agent, null, "batch", {
      events: [
        chunk("Before tool."),
        event({
          sessionUpdate: "tool_call",
          toolCallId: "tool",
          title: "Safe title",
          status: "completed",
          rawOutput,
        }),
        chunk("After tool."),
      ],
    }),
  );
  expect(
    screen.getAllByRole("listitem").map((item) => item.textContent),
  ).toEqual([
    "AssistantBefore tool.",
    "Tool completedSafe title",
    "AssistantAfter tool.",
  ]);
  expect(f.owner.queries.snapshot().records).toHaveLength(1);
  act(f.deny);
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
});
