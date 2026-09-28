// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { ComposerInputElement } from "../messages/composer-dom";
import { composerDOMFixture } from "../messages/composer-testing";

import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRelaySession } from "../relay/session";
import { keypair, profile, roster, signed } from "../relay/testing";
import {
  PublishRejected,
  type OutboxStorage,
  type OutgoingEvent,
} from "../relay/outbox";
import type { ReadFilter, RelayEvent } from "../relay/events";
import type { Contribution } from "../../plugins/contributions";
import type {
  ComposerTool,
  ComposerCompletion,
  ConversationExtensions,
} from "../conversation/contracts";
import { MentionPicker } from "../../bundled/mentions/MentionPicker";
import { MentionCompletion } from "../../bundled/mentions/MentionCompletion";
import { mentionQuery } from "../../bundled/mentions/mention-query";
import { NewMessage } from "./NewMessage";
import { OutboxStatus } from "../../bundled/channels/OutboxStatus";
import { createRelayProfiler } from "../relay/profiling";
import { readView, writeView } from "../../shared/view-state";

composerDOMFixture();

const viewer = keypair(),
  other = keypair(),
  another = keypair(),
  relay = keypair();
const channel = "11111111-1111-4111-8111-111111111111";

const scope = `https://relay.example:${viewer.pubkey}`;
const owners: ReturnType<typeof createRelaySession>[] = [];
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "Audio",
    class {
      pause = vi.fn();
      play() {
        return Promise.resolve();
      }
    },
  );
});
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (Element.prototype as Partial<Element>).scrollIntoView;
});
function setup(
  metadata: { name?: string; about?: string; picture?: string } = {},
) {
  let records: readonly OutgoingEvent[] = [];
  const storage: OutboxStorage = {
    load: () => structuredClone(records),
    save: (next) => {
      records = structuredClone(next);
    },
  };
  const publish = vi.fn<
    (event: RelayEvent, signal: AbortSignal) => Promise<void>
  >(async () => {});
  const events = [
    profile(other, { name: "Avery", ...metadata }),
    profile(another, { name: "Zoe" }),
    signed(relay, {
      kind: 39000,
      tags: [
        ["d", channel],
        ["t", "dm"],
      ],
      content: JSON.stringify({ name: "Avery", channel_type: "dm" }),
    }),
    roster(relay, channel, [viewer.pubkey, other.pubkey]),
  ];
  const query = async (filters: readonly ReadFilter[]) =>
    events.filter((event) =>
      filters.some(
        (filter) =>
          (!filter.kinds || filter.kinds.includes(event.kind)) &&
          (!filter.ids || filter.ids.includes(event.id)) &&
          (!filter.authors || filter.authors.includes(event.pubkey)) &&
          (!filter["#d"] ||
            event.tags.some(
              ([tag, value]) =>
                tag === "d" &&
                value !== undefined &&
                filter["#d"]?.includes(value),
            )),
      ),
    );
  const openDirectMessage = vi.fn(async (pubkeys: readonly string[]) => {
    events[events.length - 1] = roster(relay, channel, [
      viewer.pubkey,
      ...pubkeys,
    ]);
    return channel;
  });
  const create = () => {
    const owner = createRelaySession(
      {
        viewer: viewer.pubkey,
        relayAuthor: relay.pubkey,
        media: () => undefined,
        query,
        openDirectMessage,
        writer: {
          kinds: [9],
          sign: async (event) => signed(viewer, event),
          publish,
        },
      },
      { outboxStorage: storage },
    );
    owners.push(owner);
    return owner;
  };
  const onStarted = vi.fn();
  const mount = (
    owner: ReturnType<typeof create>,
    extensions?: ConversationExtensions,
  ) =>
    render(
      <NewMessage
        session={owner.session}
        scope={scope}
        onOpened={vi.fn()}
        onStarted={onStarted}
        extensions={extensions}
      />,
    );
  const user = userEvent.setup();
  const compose = async () => {
    await user.click(await screen.findByRole("option", { name: "Avery" }));
    await user.type(screen.getByRole("textbox"), "Durable first message");
  };
  return {
    storage,
    openDirectMessage,
    publish,
    create,
    mount,
    compose,
    user,
    onStarted,
    records: () => records,
  };
}
const send = () => screen.getByRole("button", { name: "Send message" });

it("restores a bounded recipient and draft when unused profile metadata exceeds the view quota", async () => {
  const name = "A".repeat(600);
  const t = setup({
    name,
    about: "x".repeat(2 * 1024 * 1024),
    picture: `https://example.com/${"x".repeat(20000)}`,
  });
  const setItem = Storage.prototype.setItem;
  const rejected = vi.fn();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key,
    value,
  ) {
    if (value.length > 16000) {
      rejected();
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    }
    setItem.call(this, key, value);
  });
  const owner = t.create();
  const page = t.mount(owner);
  await t.user.click(await screen.findByRole("option", { name }));
  await t.user.type(screen.getByRole("textbox"), "Saved before sending");
  expect(readView(scope, "direct-message:recipients", [])).toEqual([
    { pubkey: other.pubkey, name: name.slice(0, 500) },
  ]);
  expect(rejected).not.toHaveBeenCalled();
  page.unmount();
  t.mount(owner);
  await waitFor(() => expect(send()).toBeEnabled());
  expect(
    screen.getByRole("button", {
      name: `Remove ${name.slice(0, 500)}`,
    }),
  ).toBeEnabled();
  expect(screen.getByRole("textbox")).toHaveTextContent("Saved before sending");
  expect(t.openDirectMessage).not.toHaveBeenCalled();
  expect(t.publish).not.toHaveBeenCalled();
});

it("locks recipient edits until outbox hydration finishes, then accepts them", async () => {
  const t = setup();
  writeView(scope, "direct-message:recipients", [
    { pubkey: other.pubkey, name: "Avery" },
  ]);
  let release: (records: readonly OutgoingEvent[]) => void = () => {};
  const hydration = new Promise<readonly OutgoingEvent[]>((resolve) => {
    release = resolve;
  });
  t.storage.load = vi.fn(() => hydration);
  const play = vi.fn(async () => {});
  vi.stubGlobal(
    "Audio",
    class {
      pause = vi.fn();
      play = play;
    },
  );
  const owner = t.create();
  // Populate the actual directory before mounting so loading people cannot hide
  // a prematurely enabled picker while the outbox is held.
  await owner.session.directMessages.people(
    "",
    1,
    new AbortController().signal,
  );
  t.mount(owner);
  try {
    expect(t.storage.load).toHaveBeenCalledOnce();
    const input = screen.getByRole("combobox");
    const remove = screen.getByRole("button", { name: "Remove Avery" });
    expect(input).toBeDisabled();
    expect(remove).toBeDisabled();
    await t.user.click(remove);
    await t.user.type(input, "Zoe{Enter}");
    expect(remove).toBeInTheDocument();
    expect(input).toHaveValue("");
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove Zoe" }),
    ).not.toBeInTheDocument();
    expect(play).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      release([]);
      await owner.session.outbox?.ready();
    });
  }
  await waitFor(() => expect(screen.getByRole("combobox")).toBeEnabled());
  expect(screen.getByRole("combobox")).toHaveFocus();
  await t.user.click(screen.getByRole("button", { name: "Remove Avery" }));
  expect(
    screen.queryByRole("button", { name: "Remove Avery" }),
  ).not.toBeInTheDocument();
  expect(play).toHaveBeenCalledOnce();
  await t.user.click(await screen.findByRole("option", { name: "Zoe" }));
  expect(screen.getByRole("button", { name: "Remove Zoe" })).toBeEnabled();
  expect(t.openDirectMessage).not.toHaveBeenCalled();
  expect(t.publish).not.toHaveBeenCalled();
});

it("recovers an uncertain first send after localStorage failure and session restart without a new event", async () => {
  const t = setup();
  t.publish.mockRejectedValueOnce(new Error("Receipt lost"));
  const first = t.create();
  const page = t.mount(first);
  await t.compose();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Quota exceeded");
  });
  await t.user.click(send());
  await screen.findByRole("alert");
  await waitFor(() =>
    expect(t.records().find((item) => item.recovery)?.delivery).toBe("unknown"),
  );
  const original = t.publish.mock.calls[0]?.[0];
  assert.exists(original);
  page.unmount();
  first.dispose();
  const second = t.create();
  const resumed = t.mount(second);
  await waitFor(() => expect(send()).toBeEnabled());
  expect(screen.getByRole("textbox")).toHaveTextContent(
    "Durable first message",
  );
  expect(screen.getByRole("button", { name: "Remove Avery" })).toBeDisabled();
  await t.user.click(screen.getByRole("button", { name: "Retry send" }));
  await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
  expect(t.publish).toHaveBeenCalledTimes(2);
  expect(t.publish.mock.calls[1]?.[0]).toEqual(original);
  expect(t.records().some((item) => item.recovery)).toBe(false);
  resumed.unmount();
  second.dispose();
  const restored = t.create();
  t.mount(restored);
  await act(async () => {
    await restored.session.outbox?.ready();
  });
  await waitFor(() => expect(screen.getByRole("combobox")).toBeEnabled());
  expect(screen.getByRole("textbox")).toHaveProperty("value", "");
  expect(
    screen.queryByRole("button", { name: "Remove Avery" }),
  ).not.toBeInTheDocument();
  expect(send()).toBeDisabled();
});

it("removing a failed operation in Diagnostics unlocks the preserved draft on reopening", async () => {
  const t = setup();
  t.publish.mockRejectedValueOnce(new PublishRejected("Not sent"));
  const owner = t.create();
  const outbox = owner.session.outbox;
  assert.exists(outbox);
  const page = t.mount(owner);
  await t.compose();
  await t.user.click(send());
  await screen.findByRole("alert");
  await waitFor(() => expect(outbox.snapshot()[0]?.delivery).toBe("failed"));
  page.unmount();
  const diagnostics = render(
    <OutboxStatus outbox={outbox} profiling={createRelayProfiler()} />,
  );
  await t.user.click(
    screen.getByRole("button", { name: "Remove from outbox" }),
  );
  await waitFor(() =>
    expect(t.records().some((item) => item.recovery)).toBe(false),
  );
  diagnostics.unmount();
  t.mount(owner);
  await waitFor(() => expect(send()).toBeEnabled());
  expect(screen.getByRole("textbox")).toHaveTextContent(
    "Durable first message",
  );
  expect(screen.getByRole("button", { name: "Remove Avery" })).toBeEnabled();
  await t.user.click(send());
  await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
  expect(t.publish).toHaveBeenCalledTimes(2);
});

it("never publishes if the durable recovery write fails", async () => {
  const t = setup();
  t.storage.save = async () => {
    throw new Error("Disk full");
  };
  const owner = t.create();
  t.mount(owner);
  await t.compose();
  await t.user.click(send());
  await screen.findByRole("alert");
  expect(t.publish).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox")).toHaveTextContent(
    "Durable first message",
  );
});

it.each([false, true])(
  "preserves post-failure edits across restart, empty=%s",
  async (empty) => {
    const t = setup();
    t.publish.mockRejectedValueOnce(new PublishRejected("Not sent"));
    const owner = t.create();
    const page = t.mount(owner);
    await t.compose();
    await t.user.click(send());
    await screen.findByRole("alert");
    await t.user.clear(screen.getByRole("textbox"));
    if (!empty)
      await t.user.type(screen.getByRole("textbox"), "Corrected message");
    await t.user.click(screen.getByRole("button", { name: "Remove Avery" }));
    if (!empty)
      await t.user.click(await screen.findByRole("option", { name: "Zoe" }));
    page.unmount();
    owner.dispose();
    const restored = t.create();
    t.mount(restored);
    await act(async () => {
      await restored.session.outbox?.ready();
    });
    await waitFor(() =>
      expect(screen.getByRole("textbox")).toHaveProperty(
        "value",
        empty ? "" : "Corrected message",
      ),
    );
    expect(
      screen.queryByRole("button", { name: "Remove Avery" }),
    ).not.toBeInTheDocument();
    if (empty) expect(send()).toBeDisabled();
    else {
      expect(screen.getByRole("button", { name: "Remove Zoe" })).toBeVisible();
      await t.user.click(send());
      await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
      expect(t.publish.mock.calls[1]?.[0].content).toBe("Corrected message");
    }
  },
);

it("retains recovery if saved-view cleanup fails, then retires without republishing", async () => {
  const t = setup();
  const owner = t.create();
  const page = t.mount(owner);
  await t.compose();
  const remove = vi
    .spyOn(Storage.prototype, "removeItem")
    .mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
  await t.user.click(send());
  await screen.findByRole("alert");
  expect(t.records().some((item) => item.recovery)).toBe(true);
  page.unmount();
  const resumed = t.mount(owner);
  await screen.findByRole("button", { name: "Retry send" });
  remove.mockRestore();
  await t.user.click(screen.getByRole("button", { name: "Retry send" }));
  await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
  expect(t.publish).toHaveBeenCalledOnce();
  resumed.unmount();
  t.mount(owner);
  await waitFor(() =>
    expect(screen.getByRole("textbox")).toHaveProperty("value", ""),
  );
  expect(send()).toBeDisabled();
});

it("reconciles a remount while acknowledgement is held without reviving the delivered draft", async () => {
  const t = setup();
  const save = t.storage.save;
  let release: () => void = () => {};
  let held = false;
  t.storage.save = async (records) => {
    if (
      !held &&
      records.some((item) => item.delivery === "accepted" && !item.recovery)
    ) {
      held = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    await save(records);
  };
  const owner = t.create();
  const page = t.mount(owner);
  await t.compose();
  await t.user.click(send());
  await waitFor(() => expect(held).toBe(true));
  page.unmount();
  const resumed = t.mount(owner);
  try {
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Remove Avery" }),
      ).toBeDisabled(),
    );
    expect(screen.getByRole("textbox")).toHaveTextContent(
      "Durable first message",
    );
  } finally {
    release();
  }
  await waitFor(() =>
    expect(t.records().some((item) => item.recovery)).toBe(false),
  );
  await waitFor(() =>
    expect(screen.getByRole("textbox")).toHaveProperty("value", ""),
  );
  expect(
    screen.queryByRole("button", { name: "Remove Avery" }),
  ).not.toBeInTheDocument();
  expect(send()).toBeDisabled();
  expect(t.onStarted).not.toHaveBeenCalled();
  expect(t.publish).toHaveBeenCalledOnce();
  resumed.unmount();
  owner.dispose();
  const restored = t.create();
  t.mount(restored);
  await act(async () => {
    await restored.session.outbox?.ready();
  });
  await waitFor(() =>
    expect(screen.getByRole("textbox")).toHaveProperty("value", ""),
  );
  expect(send()).toBeDisabled();
});

const tools: readonly Contribution<ComposerTool>[] = [
  {
    id: "picker",
    key: "mentions/picker",
    pluginId: "mentions",
    revision: "1",
    title: "Mentions",
    component: ({ insertMention, ...props }) => (
      <MentionPicker {...props} select={insertMention} />
    ),
  },
];
const completions: readonly Contribution<ComposerCompletion>[] = [
  {
    id: "typeahead",
    key: "mentions/typeahead",
    pluginId: "mentions",
    revision: "1",
    title: "Mention",
    match: ({ text, start }) => mentionQuery(text, start),
    component: MentionCompletion,
  },
];
const noSubscribe = () => () => {};
const extensions: ConversationExtensions = {
  tools: { snapshot: () => tools, subscribe: noSubscribe },
  completions: { snapshot: () => completions, subscribe: noSubscribe },
  inline: { snapshot: () => [], subscribe: noSubscribe },
};

it.each(["picker", "completion"])(
  "offers selected recipients through %s and validates removed mentions on first send",
  async (path) => {
    const t = setup();
    const owner = t.create();
    t.mount(owner, extensions);
    await t.user.click(await screen.findByRole("option", { name: "Avery" }));
    await t.user.click(screen.getByRole("option", { name: "Zoe" }));
    const composer = () =>
      screen.getByRole<ComposerInputElement>("textbox", { name: /^Message / });
    const choices = async () => {
      if (path === "picker") {
        await t.user.click(
          screen.getByRole("button", { name: "Mention a member" }),
        );
        return within(
          screen.getByRole("dialog", { name: "Mention a member or agent" }),
        );
      }
      // jsdom has no caret hit testing; append after the existing mention.
      act(() => {
        const input = composer();
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      });
      await t.user.keyboard("@");
      return within(
        await screen.findByRole("listbox", { name: "Mention suggestions" }),
      );
    };
    const choiceRole = path === "picker" ? "button" : "option";
    const first = await choices();
    expect(
      first.getByRole(choiceRole, {
        name: new RegExp(`Avery.*${other.pubkey}`),
      }),
    ).toBeVisible();
    await t.user.click(
      first.getByRole(choiceRole, {
        name: new RegExp(`Zoe.*${another.pubkey}`),
      }),
    );
    expect(composer()).toHaveTextContent("@Zoe");
    expect(t.openDirectMessage).not.toHaveBeenCalled();
    expect(owner.session.channels.list().channels).toHaveLength(0);
    // The provisional names are sufficient without warming the global profile cache.
    expect(owner.session.profiles.snapshot().size).toBe(0);
    await t.user.click(screen.getByRole("button", { name: "Remove Zoe" }));
    const second = await choices();
    expect(
      second.getByRole(choiceRole, {
        name: new RegExp(`Avery.*${other.pubkey}`),
      }),
    ).toBeVisible();
    expect(
      second.queryByRole(choiceRole, { name: new RegExp(another.pubkey) }),
    ).not.toBeInTheDocument();
    // Dismiss the suggestions without replacing the existing mention in jsdom.
    await t.user.keyboard("{Escape}");
    expect(composer()).toHaveTextContent("@Zoe");
    expect(t.openDirectMessage).not.toHaveBeenCalled();
    await t.user.click(send());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "no longer a channel member",
    );
    expect(t.publish).not.toHaveBeenCalled();
    expect(composer()).toHaveTextContent("@Zoe");
    await t.user.clear(composer());
    const last = await choices();
    await t.user.click(
      last.getByRole(choiceRole, {
        name: new RegExp(`Avery.*${other.pubkey}`),
      }),
    );
    await t.user.click(send());
    await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
    const sent = t.publish.mock.calls[0]?.[0];
    expect(sent?.content).toBe("@Avery");
    expect(sent?.tags.filter(([name]) => name === "p")).toEqual([
      ["p", other.pubkey],
    ]);
  },
);
