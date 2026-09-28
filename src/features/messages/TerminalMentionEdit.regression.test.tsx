// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Contribution } from "../../plugins/contributions";
import { MentionCompletion } from "../../bundled/mentions/MentionCompletion";
import { mentionQuery } from "../../bundled/mentions/mention-query";
import type { ComposerCompletion } from "../conversation/contracts";
import { profileTarget } from "../profiles/target";
import { createRelaySession } from "../relay/session";
import { keypair, metadata, roster, signed } from "../relay/testing";
import { MessageComposer } from "./MessageComposer";
import { composerDOMFixture } from "./composer-testing";
import type { ComposerInputElement } from "./composer-dom";

composerDOMFixture();
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});

it("saves an unchanged edit ending in a bound mention without offering directory Retry", async () => {
  const viewer = keypair();
  const honey = keypair();
  const relay = keypair();
  const content = `Thanks [@Honey](${profileTarget(honey.pubkey)})`;
  const publish = vi.fn(async () => {});
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      scope: "https://terminal-mention.test",
      media: () => undefined,
      query: async (filters) =>
        filters.flatMap((filter) => {
          if (filter.kinds?.includes(39002))
            return [roster(relay, "channel", [viewer.pubkey, honey.pubkey])];
          if (filter.kinds?.includes(39000))
            return [metadata(relay, "channel", "General")];
          return [];
        }),
      writer: {
        kinds: [9, 40003],
        sign: async (template) => signed(viewer, template),
        publish,
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  try {
    await owner.session.read([
      { kinds: [39002], "#d": ["channel"], limit: 1 },
      { kinds: [39000], "#d": ["channel"], limit: 1 },
    ]);
    // Neither profile is in the directory; a mistaken mention query would
    // offer Retry and steal Enter before the unchanged edit can close.
    expect(owner.session.profiles.snapshot().has(honey.pubkey)).toBe(false);
    const refreshAgents = vi.fn(() => owner.session.agentChoices.refresh());
    const refreshChannels = vi.fn(() => owner.session.channels.refreshList?.());
    const session = {
      ...owner.session,
      agentChoices: { ...owner.session.agentChoices, refresh: refreshAgents },
      channels: { ...owner.session.channels, refreshList: refreshChannels },
    };
    const completion: Contribution<ComposerCompletion> = {
      id: "typeahead",
      key: "test/mentions",
      pluginId: "test",
      revision: "1",
      title: "Mention",
      match: ({ text, start }) => mentionQuery(text, start),
      component: MentionCompletion,
    };
    const completions = [completion];
    const empty: [] = [];
    render(
      <MessageComposer
        session={session}
        scope="terminal-mention-edit"
        channelId="channel"
        channelName="General"
        editMessages={[
          {
            id: "a".repeat(64),
            channelId: "channel",
            authorId: viewer.pubkey,
            createdAt: 10,
            content,
            sourceContent: content,
            edited: true,
            mentions: [honey.pubkey],
            participants: [],
            attachments: [],
            reactions: [],
            replyCount: 0,
          },
        ]}
        extensions={{
          tools: { snapshot: () => empty, subscribe: () => () => {} },
          inline: { snapshot: () => empty, subscribe: () => () => {} },
          completions: {
            snapshot: () => completions,
            subscribe: () => () => {},
          },
        }}
      />,
    );
    const input = screen.getByRole<ComposerInputElement>("textbox", {
      name: "Message #General",
    });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveAccessibleName("Edit message");
    expect(input).toHaveValue(content);
    expect(input.selectionStart).toBe(content.length);
    // Observe the settled caret, allowing the real completion provider to mount.
    fireEvent.select(input);
    expect(
      screen.queryByRole("option", { name: "Retry suggestions" }),
    ).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(input).toHaveAccessibleName("Message #General"));
    expect(publish).not.toHaveBeenCalled();
    expect(refreshAgents).not.toHaveBeenCalled();
    expect(refreshChannels).not.toHaveBeenCalled();
  } finally {
    cleanup();
    owner.dispose();
  }
});
