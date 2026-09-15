// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import { MentionPicker } from "./MentionPicker";
import { MentionCompletion } from "./MentionCompletion";
import { createAgentLibrary } from "../../features/agents/library";
import type { CompletionResult } from "../../features/conversation/contracts";
afterEach(cleanup);
function setup(parent: boolean | null = true) {
  const key = "b".repeat(64),
    member = "a".repeat(64);
  const library = createAgentLibrary(async () => ({
    definitions: [],
    identities: [{ pubkey: key, name: "Outside agent" }],
  }));
  const list = {
    status: "ready",
    channels:
      parent === null
        ? []
        : [
            {
              id: "parent",
              channelType: parent ? "stream" : "session",
              members: [member],
            },
          ],
  };
  const profiles = new Map([[member, { name: "Member" }]]);
  const session = {
    channels: {
      list: () => list,
      subscribeList: () => () => {},
      ensureList: () => {},
    },
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: async () => {},
    },
    agentLibrary: library.queries,
    media: () => undefined,
  } as unknown as RelaySession;
  return { session, library, key };
}
it("offers outside agents in the session mention picker while ordinary channel pickers keep their roster", async () => {
  const test = setup(),
    user = userEvent.setup(),
    select = vi.fn(() => true);
  const view = render(
    <MentionPicker
      session={test.session}
      channelId="parent"
      disabled={false}
      select={select}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Mention a member" }));
  expect(
    screen.queryByRole("button", { name: `Outside agent ${test.key}` }),
  ).not.toBeInTheDocument();
  view.rerender(
    <MentionPicker
      session={test.session}
      channelId="parent"
      disabled={false}
      inviteAgents
      select={select}
    />,
  );
  await user.click(
    await screen.findByRole("button", { name: `Outside agent ${test.key}` }),
  );
  expect(select).toHaveBeenCalledWith({
    pubkey: test.key,
    name: "Outside agent",
  });
  view.unmount();
  test.library.dispose();
});
it.each([true, false, null])(
  "typed @ completion offers outside agents with correct admission: parent=%s",
  async (parent) => {
    const test = setup(parent);
    let result: CompletionResult | undefined;
    const publish = vi.fn((next: CompletionResult) => {
      result = next;
      return () => {};
    });
    const props = {
      session: test.session,
      scope: "test",
      channelId: "parent",
      observation: { revision: 1, text: "@Outside", start: 8, end: 8 },
      query: { start: 0, end: 8, query: "Outside" },
      publish,
    };
    const view = render(<MentionCompletion {...props} inviteAgents />);
    await waitFor(() =>
      expect(result?.items).toEqual([
        expect.objectContaining({
          id: test.key,
          detail: expect.stringContaining(
            parent ? "Adds to session and parent channel" : "Adds to session ·",
          ),
          edit: { mention: { pubkey: test.key, name: "Outside agent" } },
        }),
      ]),
    );
    if (parent === null) {
      expect(result?.status).toBeUndefined();
      expect(result?.retry).toBeUndefined();
    }
    view.rerender(<MentionCompletion {...props} />);
    await waitFor(() => expect(result?.items).toHaveLength(0));
    view.unmount();
    test.library.dispose();
  },
);
