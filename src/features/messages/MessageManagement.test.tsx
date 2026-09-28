// @vitest-environment jsdom
import { afterEach, assert, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { composerDOMFixture } from "./composer-testing";
import type { ComposerInputElement } from "./composer-dom";
import { MessageComposer } from "./MessageComposer";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useSyncExternalStore } from "react";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
} from "../../shared/design-system/ui/Menu";
import {
  MessageManagement,
  MessageManagementItems,
  MessageManagementStatus,
} from "./MessageManagement";
import { createRelaySession } from "../relay/session";
import { PublishRejected } from "../relay/outbox";
import {
  keypair,
  message,
  metadata,
  profile,
  roster,
  bounds,
  signed,
} from "../relay/testing";
import type { RelayEvent } from "../relay/events";

composerDOMFixture();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const owner of owners.splice(0)) owner.dispose();
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function fixture(
  own = true,
  withAttachments = false,
  originalAttachment = false,
  originalMention = false,
) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const viewer = keypair(),
    relay = keypair(),
    peer = keypair();
  const original = message(
    own ? viewer : peer,
    "room",
    originalAttachment
      ? "Original message\n\n[original.pdf](https://fixture.test/media/original.pdf)"
      : originalMention
        ? "@Honey Original message"
        : "Original message",
    1700000000,
    originalAttachment
      ? [
          [
            "imeta",
            "url https://fixture.test/media/original.pdf",
            "m application/pdf",
          ],
        ]
      : originalMention
        ? [["p", peer.pubkey]]
        : [],
  );
  const publications: {
    event: RelayEvent;
    result: ReturnType<typeof deferred<void>>;
  }[] = [];
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      ...(withAttachments
        ? {
            uploadAttachment: async (file: File) => ({
              name: file.name,
              url: `https://fixture.test/media/${"a".repeat(64)}.txt`,
              type: "text/plain",
              size: file.size,
              sha256: "a".repeat(64),
            }),
          }
        : {}),
      async query(filters) {
        const filter = filters[0];
        assert.exists(filter);
        if (filter.kinds?.includes(39000) || filter.kinds?.includes(39002))
          return [
            metadata(relay, "room", "Room"),
            roster(relay, "room", [viewer.pubkey, peer.pubkey]),
          ];
        if (filter.kinds?.includes(0))
          return originalMention ? [profile(peer, { name: "Honey" })] : [];
        if (filter.kinds?.includes(9))
          return [
            original,
            bounds(relay, "room", "head", {
              has_more: false,
              next_cursor: null,
            }),
          ];
        return [];
      },
      writer: {
        kinds: [9, 40003, 5],
        async sign(template) {
          return signed(viewer, template);
        },
        publish(event) {
          const result = deferred<void>();
          publications.push({ event, result });
          return result.promise;
        },
      },
    },
    {
      outboxStorage: { load: () => [], save() {} },
    },
  );
  owners.push(owner);
  owner.session.channels.ensureList();
  await waitFor(() =>
    expect(owner.session.channels.list().status).toBe("ready"),
  );
  owner.session.channels.ensure("room");
  await waitFor(() =>
    expect(owner.session.channels.window("room").rows).toHaveLength(1),
  );
  if (originalMention) {
    owner.session.profiles.ensure([peer.pubkey]);
    await waitFor(() =>
      expect(owner.session.profiles.snapshot().get(peer.pubkey)?.name).toBe(
        "Honey",
      ),
    );
  }
  function Surface() {
    const snapshot = useSyncExternalStore(
      (listener) => owner.session.channels.subscribeWindow("room", listener),
      () => owner.session.channels.window("room"),
    );
    return (
      <MessageManagement session={owner.session} channelId="room">
        <MessageManagementStatus />
        {snapshot.rows.map((row) => (
          <div key={row.id}>
            <p>{row.content}</p>
            <MenuRoot>
              <MenuTrigger>Message actions</MenuTrigger>
              <MenuPopup>
                <MessageManagementItems row={row} session={owner.session} />
              </MenuPopup>
            </MenuRoot>
          </div>
        ))}
        <MessageComposer
          session={owner.session}
          scope="management-test"
          channelId="room"
          channelName="Room"
        />
      </MessageManagement>
    );
  }
  render(<Surface />);
  fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
  return {
    owner,
    original,
    publications,
    publication(index: number) {
      const item = publications[index];
      assert.exists(item);
      return item;
    },
  };
}
function editor() {
  return screen.getByRole<ComposerInputElement>("textbox", {
    name: "Edit message",
  });
}
function fill(text: string) {
  const field = screen.getByRole<ComposerInputElement>("textbox");
  act(() => {
    field.focus();
    field.value = text;
    field.setSelectionRange(text.length, text.length);
  });
  fireEvent.input(field);
  fireEvent(document, new Event("selectionchange"));
}
function submit() {
  const form = editor().closest("form");
  if (!form) throw new Error("Expected the mounted composer form");
  fireEvent.submit(form);
}
async function edit() {
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Edit message" }),
  );
  await waitFor(() => expect(editor()).toHaveValue("Original message"));
  expect(editor()).toHaveFocus();
  expect(screen.queryByRole("dialog", { name: "Edit message" })).toBeNull();
}

it("edits in the composer, retains a rejected change and retries the same operation", async () => {
  const h = await fixture();
  await edit();
  fill("Corrected message");
  submit();
  await waitFor(() => expect(h.publications).toHaveLength(1));
  expect(editor()).toHaveAttribute("contenteditable", "false");
  await act(async () =>
    h.publication(0).result.reject(new PublishRejected("Edit refused")),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Edit refused");
  expect(editor()).toHaveValue("Corrected message");
  fireEvent.click(screen.getByRole("button", { name: "Retry edit" }));
  await waitFor(() => expect(h.publications).toHaveLength(2));
  expect(h.publication(1).event.id).toBe(h.publication(0).event.id);
  await act(async () => h.publication(1).result.resolve());
  await waitFor(() => expect(screen.queryByText("Editing message")).toBeNull());
  expect(h.owner.session.channels.window("room").rows[0]?.content).toBe(
    "Corrected message",
  );
});

it("does not expose edit or delete for another person's message", async () => {
  await fixture(false);
  await screen.findByRole("menu");
  expect(screen.queryByRole("menuitem", { name: "Edit message" })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "Delete message" })).toBeNull();
});

it("restores the unsent draft on cancel without publishing and keeps menu focus in the composer", async () => {
  const h = await fixture();
  // Closing the initial menu returns focus before writing a draft.
  fireEvent.keyDown(screen.getByRole("menuitem", { name: "Edit message" }), {
    key: "Escape",
  });
  fill("Unsent draft");
  fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
  await edit();
  fill("Temporary correction");
  fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));
  expect(screen.queryByText("Editing message")).toBeNull();
  expect(screen.getByRole("textbox")).toHaveValue("Unsent draft");
  expect(screen.getByRole("textbox")).toHaveFocus();
  expect(h.publications).toHaveLength(0);
});

it("closes an unchanged bound-mention edit without publishing and restores the unsent draft", async () => {
  const h = await fixture(true, false, false, true);
  // Dismiss the initial menu before entering an unsent draft.
  fireEvent.keyDown(screen.getByRole("menuitem", { name: "Edit message" }), {
    key: "Escape",
  });
  fill("Unsent draft");
  fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Edit message" }),
  );
  await waitFor(() => expect(editor().value).toContain("[@Honey](nostr:npub1"));
  expect(editor()).toHaveFocus();
  const seeded = editor().value;
  expect(seeded).toContain("Original message");
  submit();
  await waitFor(() => expect(screen.queryByText("Editing message")).toBeNull());
  expect(screen.getByRole("textbox")).toHaveValue("Unsent draft");
  expect(screen.getByRole("textbox")).toHaveFocus();
  expect(h.owner.session.channels.window("room").rows[0]?.content).toBe(
    "@Honey Original message",
  );
  expect(h.publications).toHaveLength(0);
});

it("offers deletion for an empty edit, permits cancel and then confirms deletion", async () => {
  const h = await fixture();
  await edit();
  fill("");
  submit();
  const confirmation = await screen.findByRole("alertdialog", {
    name: "Delete message?",
  });
  expect(h.publications).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(confirmation).not.toBeInTheDocument());
  expect(editor()).toHaveValue("");
  expect(h.publications).toHaveLength(0);
  submit();
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  await waitFor(() => expect(h.publications).toHaveLength(1));
  expect(h.publication(0).event.kind).toBe(5);
  await act(async () => h.publication(0).result.resolve());
  await waitFor(() => expect(screen.queryByText("Editing message")).toBeNull());
});

it("hides unsent attachments during edit and restores them after cancel and save", async () => {
  const h = await fixture(true, true);
  fireEvent.keyDown(screen.getByRole("menuitem", { name: "Edit message" }), {
    key: "Escape",
  });
  // Uploads belong to the unsent draft, not to the message opened for editing.
  const file = new File(["draft"], "draft-notes.txt", { type: "text/plain" });
  fireEvent.change(screen.getByLabelText("Choose attachments"), {
    target: { files: [file] },
  });
  expect(
    await screen.findByRole("region", { name: "Attachments" }),
  ).toHaveTextContent("draft-notes.txt");
  fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
  await edit();
  expect(screen.queryByRole("region", { name: "Attachments" })).toBeNull();
  fill("");
  submit();
  expect(
    await screen.findByRole("alertdialog", { name: "Delete message?" }),
  ).toBeVisible();
  expect(screen.queryByRole("region", { name: "Attachments" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));
  expect(screen.getByRole("region", { name: "Attachments" })).toHaveTextContent(
    "draft-notes.txt",
  );
  expect(h.publications).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
  await edit();
  fill("Corrected without the unsent file");
  submit();
  await waitFor(() => expect(h.publications).toHaveLength(1));
  expect(h.publication(0).event.kind).toBe(40003);
  expect(h.publication(0).event.content).toBe(
    "Corrected without the unsent file",
  );
  await act(async () => h.publication(0).result.resolve());
  await waitFor(() => expect(screen.queryByText("Editing message")).toBeNull());
  expect(screen.getByRole("region", { name: "Attachments" })).toHaveTextContent(
    "draft-notes.txt",
  );
});

it("rejects an empty edit of a message with original attachments without deleting it", async () => {
  const h = await fixture(true, false, true);
  expect(
    h.owner.session.channels.window("room").rows[0]?.attachments.length,
  ).toBeGreaterThan(0);
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Edit message" }),
  );
  expect(
    await screen.findByRole("textbox", { name: "Edit message" }),
  ).toHaveFocus();
  fill("");
  submit();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Keep attachment links unchanged. To remove this message, use Delete message.",
  );
  expect(
    screen.queryByRole("alertdialog", { name: "Delete message?" }),
  ).toBeNull();
  expect(h.owner.session.channels.window("room").rows).toHaveLength(1);
  expect(h.publications).toHaveLength(0);
});

it("keeps deletion recovery outside the optimistically removed row", async () => {
  const h = await fixture();
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Delete message" }),
  );
  await screen.findByRole("alertdialog", { name: "Delete message?" });
  expect(h.publications).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(h.publications).toHaveLength(1));
  expect(h.owner.session.channels.window("room").rows).toHaveLength(0);
  await act(async () =>
    h.publication(0).result.reject(new PublishRejected("Deletion refused")),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Deletion refused",
  );
  expect(h.owner.session.channels.window("room").rows).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(h.publications).toHaveLength(2));
  expect(h.publication(1).event.id).toBe(h.publication(0).event.id);
  await act(async () => h.publication(1).result.resolve());
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
});

it("cancelling deletion never publishes", async () => {
  const h = await fixture();
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Delete message" }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(h.publications).toHaveLength(0);
  expect(h.owner.session.channels.window("room").rows).toHaveLength(1);
});

it("recovers an uncertain deletion after the row and dialog disappear", async () => {
  const h = await fixture();
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Delete message" }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  await waitFor(() => expect(h.publications).toHaveLength(1));
  await act(async () =>
    h.publication(0).result.reject(new Error("Connection lost")),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(screen.queryByRole("button", { name: "Message actions" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry message update" }));
  await waitFor(() => expect(h.publications).toHaveLength(2));
  expect(h.publication(1).event.id).toBe(h.publication(0).event.id);
  await act(async () => h.publication(1).result.resolve());
});
