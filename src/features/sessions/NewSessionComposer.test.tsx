// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RelaySession } from "../relay/session";
import { writeView } from "../../shared/view-state";
import { NewSessionComposer } from "./NewSessionComposer";

afterEach(cleanup);
beforeEach(() => localStorage.clear());
const parent = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Engineering",
  channelType: "stream" as const,
  members: ["a".repeat(64)],
};
function setup(available = true) {
  const agents = {
    status: "ready",
    identities: [
      { pubkey: "a".repeat(64), name: "Member agent" },
      { pubkey: "b".repeat(64), name: "Outside agent" },
    ],
  };
  const emoji = { status: "ready", entries: [] };
  const workSessions = {
    available,
    addAgents: vi.fn(async () => {}),
    create: vi.fn<RelaySession["workSessions"]["create"]>(() => "c".repeat(64)),
    invite: vi.fn(() => "e".repeat(64)),
    delivered: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    failed: () => false,
  };
  const messages = { send: vi.fn(() => "d".repeat(64)) };
  let channelSnapshot = { channels: [{ id: "", members: parent.members }] };
  const profileSnapshot = new Map();
  const session = {
    workSessions,
    messages,
    channels: {
      list: () => {
        const id = workSessions.create.mock.calls[0]?.[0] ?? "";
        if (channelSnapshot.channels[0]?.id !== id)
          channelSnapshot = { channels: [{ id, members: parent.members }] };
        return channelSnapshot;
      },
      subscribeList: () => () => {},
    },
    profiles: {
      ensure: vi.fn(async () => {}),
      snapshot: () => profileSnapshot,
      subscribe: () => () => {},
    },
    agentLibrary: {
      snapshot: () => agents,
      subscribe: () => () => {},
      refresh: async () => {},
    },
    emoji: {
      snapshot: () => emoji,
      subscribe: () => () => {},
      ensure: async () => {},
    },
    outbox: { supports: () => true },
    media: (url: string) => url,
  } as unknown as RelaySession;
  return { session, workSessions, messages };
}
it.each([true, false])(
  "admits only explicit mentions when they override the picker (child: %s)",
  async (child) => {
    const test = setup(),
      onStarted = vi.fn(),
      user = userEvent.setup();
    writeView(
      "test",
      `${child ? `sessions:channel:${parent.id}` : "sessions"}:new-draft`,
      {
        text: "@Member agent Plan the release",
        recipients: [
          { pubkey: "a".repeat(64), name: "Member agent", start: 0, end: 13 },
        ],
      },
    );
    render(
      <NewSessionComposer
        session={test.session}
        scope="test"
        parent={child ? parent : undefined}
        onStarted={onStarted}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Choose an agent" }));
    expect(
      await screen.findByRole("menuitemradio", {
        name: /^Outside agent/,
      }),
    ).toBeVisible();
    await user.click(
      await screen.findByRole("menuitemradio", { name: /^Outside agent/ }),
    );
    expect(
      screen.getByRole("textbox", { name: "Message this session" }),
    ).toHaveTextContent("Plan the release");
    await user.click(screen.getByRole("textbox"));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    const id = test.workSessions.create.mock.calls[0]?.[0];
    expect(test.workSessions.create).toHaveBeenCalledWith(
      expect.any(String),
      "@Member agent Plan the release",
      child ? parent.id : undefined,
    );
    expect(test.workSessions.invite).not.toHaveBeenCalled();
    expect(test.workSessions.addAgents.mock.calls).toEqual(
      (child ? [parent.id, id] : [id]).map((target) => [
        target,
        ["a".repeat(64)],
        expect.any(Function),
      ]),
    );
    expect(test.messages.send).toHaveBeenCalledWith(
      id,
      "@Member agent Plan the release",
      ["a".repeat(64)],
    );
  },
);
it("keeps parent drafts separate and cannot send on an unsupported community", async () => {
  const test = setup(false),
    user = userEvent.setup();
  const view = render(
    <NewSessionComposer
      session={test.session}
      scope="test"
      parent={parent}
      onStarted={() => {}}
    />,
  );
  await user.type(screen.getByRole("textbox"), "Parent draft");
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  view.unmount();
  const solo = render(
    <NewSessionComposer
      session={test.session}
      scope="test"
      onStarted={() => {}}
    />,
  );
  expect(screen.getByRole("textbox").textContent).toBe("");
  solo.unmount();
  render(
    <NewSessionComposer
      session={test.session}
      scope="test"
      parent={parent}
      onStarted={() => {}}
    />,
  );
  expect(screen.getByRole("textbox")).toHaveTextContent("Parent draft");
  expect(test.workSessions.create).not.toHaveBeenCalled();
});

it("keeps the prompt through an uncertain delivery and retries without duplicate writes", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    user = userEvent.setup();
  test.workSessions.delivered.mockRejectedValueOnce(
    new Error("Still waiting for delivery"),
  );
  const view = render(
    <NewSessionComposer
      session={test.session}
      scope="test"
      parent={parent}
      onStarted={onStarted}
    />,
  );
  await user.type(screen.getByRole("textbox"), "Recover this prompt");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("textbox")).toHaveTextContent("Recover this prompt");
  expect(test.messages.send).not.toHaveBeenCalled();
  view.unmount();
  render(
    <NewSessionComposer
      session={test.session}
      scope="test"
      parent={parent}
      onStarted={onStarted}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  expect(test.workSessions.create).toHaveBeenCalledOnce();
  expect(test.messages.send).toHaveBeenCalledOnce();
});

it("restores the chosen agent and invites it before the first standalone message", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    user = userEvent.setup();
  const view = render(
    <NewSessionComposer
      session={test.session}
      scope="test"
      onStarted={onStarted}
    />,
  );
  await user.click(
    screen.getByRole("button", { name: /Choose an agent|Change agent:/ }),
  );
  await user.click(
    await screen.findByRole("menuitemradio", { name: /^Outside agent/ }),
  );
  await user.type(screen.getByRole("textbox"), "Help with the release");
  view.unmount();
  render(
    <NewSessionComposer
      session={test.session}
      scope="test"
      onStarted={onStarted}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Change agent: Outside agent" }),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  const id = test.workSessions.create.mock.calls[0]?.[0];
  expect(test.workSessions.invite).toHaveBeenCalledExactlyOnceWith(
    id,
    "b".repeat(64),
  );
  expect(test.workSessions.refresh).toHaveBeenCalledWith(id, {
    member: "b".repeat(64),
  });
  expect(test.messages.send).toHaveBeenCalledExactlyOnceWith(
    id,
    "Help with the release",
    ["b".repeat(64)],
  );
  expect(test.workSessions.invite.mock.invocationCallOrder[0]).toBeLessThan(
    test.messages.send.mock.invocationCallOrder[0] ?? 0,
  );
});

it("loads the new session roster profiles before sending without an explicit agent", async () => {
  const test = setup(),
    user = userEvent.setup(),
    onStarted = vi.fn();
  let finish: () => void = () => {};
  vi.mocked(test.session.profiles.ensure).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  render(
    <NewSessionComposer
      session={test.session}
      scope="test"
      parent={parent}
      onStarted={onStarted}
    />,
  );
  await user.type(screen.getByRole("textbox"), "Keep going");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() =>
    expect(test.session.profiles.ensure).toHaveBeenCalledWith(
      parent.members,
      "background",
    ),
  );
  expect(test.messages.send).not.toHaveBeenCalled();
  finish();
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  expect(test.messages.send).toHaveBeenCalledOnce();
});

it("deduplicates the effective recipient before parent admission", async () => {
  const test = setup(),
    user = userEvent.setup(),
    onStarted = vi.fn();
  let release = () => {};
  test.workSessions.addAgents.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  writeView("test", `sessions:channel:${parent.id}:new-draft`, {
    text: "@Outside agent Help",
    recipients: [
      { pubkey: "b".repeat(64), name: "Outside agent", start: 0, end: 14 },
    ],
  });
  render(
    <NewSessionComposer
      session={test.session}
      scope="test"
      parent={parent}
      onStarted={onStarted}
    />,
  );
  await user.click(
    screen.getByRole("button", { name: /Choose an agent|Change agent:/ }),
  );
  await user.click(
    await screen.findByRole("menuitemradio", { name: /^Outside agent/ }),
  );
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() =>
    expect(test.workSessions.addAgents).toHaveBeenCalledWith(
      parent.id,
      ["b".repeat(64)],
      expect.any(Function),
    ),
  );
  try {
    expect(test.workSessions.create).not.toHaveBeenCalled();
    expect(test.messages.send).not.toHaveBeenCalled();
  } finally {
    release();
  }
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  expect(test.messages.send).toHaveBeenCalledWith(
    expect.any(String),
    "@Outside agent Help",
    ["b".repeat(64)],
  );
});
it("keeps an editable draft when parent admission fails and retries admission first", async () => {
  const test = setup(),
    user = userEvent.setup(),
    onStarted = vi.fn();
  test.workSessions.addAgents.mockRejectedValueOnce(
    new Error("Only channel admins can add agents"),
  );
  render(
    <NewSessionComposer
      session={test.session}
      scope="test"
      parent={parent}
      onStarted={onStarted}
    />,
  );
  await user.click(
    screen.getByRole("button", { name: /Choose an agent|Change agent:/ }),
  );
  await user.click(
    await screen.findByRole("menuitemradio", { name: /^Outside agent/ }),
  );
  await user.type(screen.getByRole("textbox"), "Help");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Only channel admins",
  );
  expect(screen.getByRole("textbox")).toHaveTextContent("Help");
  expect(screen.getByRole("textbox")).not.toBeDisabled();
  expect(test.workSessions.create).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  expect(test.workSessions.addAgents).toHaveBeenCalledTimes(3);
});

it.each(
  [true, false].flatMap((child) =>
    [true, false].map((sent) => ({ child, sent })),
  ),
)(
  "restores effective recipients without replaying an overridden invitation: child=$child, sent=$sent",
  async ({ child, sent }) => {
    const test = setup(),
      onStarted = vi.fn(),
      user = userEvent.setup();
    const key = child ? `sessions:channel:${parent.id}` : "sessions";
    const id = "22222222-2222-4222-8222-222222222222";
    const draft = {
      text: "@Member agent Continue",
      recipients: [
        { pubkey: "a".repeat(64), name: "Member agent", start: 0, end: 13 },
      ],
    };
    writeView("test", `${key}:pending`, {
      id,
      text: draft.text,
      draft,
      agent: "b".repeat(64),
      creationId: "c".repeat(64),
      invitationId: "e".repeat(64),
      ...(sent ? { messageId: "d".repeat(64) } : {}),
    });
    render(
      <NewSessionComposer
        session={test.session}
        scope="test"
        parent={child ? parent : undefined}
        onStarted={onStarted}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
    expect(test.workSessions.create).not.toHaveBeenCalled();
    expect(test.workSessions.invite).not.toHaveBeenCalled();
    expect(test.workSessions.delivered).not.toHaveBeenCalledWith(
      "e".repeat(64),
    );
    if (sent) {
      expect(test.workSessions.addAgents).not.toHaveBeenCalled();
      expect(test.messages.send).not.toHaveBeenCalled();
    } else {
      expect(test.workSessions.addAgents.mock.calls).toEqual(
        (child ? [parent.id, id] : [id]).map((target) => [
          target,
          ["a".repeat(64)],
          expect.any(Function),
        ]),
      );
      expect(test.messages.send).toHaveBeenCalledExactlyOnceWith(
        id,
        draft.text,
        ["a".repeat(64)],
      );
    }
  },
);
