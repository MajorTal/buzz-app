// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { RelayEvent } from "../../features/relay/events";
import type { RelayData } from "../../features/relay/service";
import type { AttachmentUpload } from "../../features/relay/attachments";
import { createRelaySession } from "../../features/relay/session";
import { UPLOAD_FAILURES, UploadError } from "../../features/relay/attachments";
import { PublishRejected } from "../../features/relay/outbox";
import { keypair, signed } from "../../features/relay/testing";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { CustomEmojiSettings } from "./CustomEmojiSettings";

const viewer = keypair(),
  relayKey = keypair();
const origin = "https://relay.test";
const owners: { dispose(): void }[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
});
/** One relay store shared across sessions so remounts prove persistence. */
function relayStore() {
  const stored: RelayEvent[] = [];
  const matches = (
    event: RelayEvent,
    filter: { kinds?: readonly number[]; authors?: readonly string[] },
  ) =>
    (!filter.kinds || filter.kinds.includes(event.kind)) &&
    (!filter.authors || filter.authors.includes(event.pubkey));
  const failures: Error[] = [];
  return {
    stored,
    /** Queue a relay rejection for the next publish. */
    rejectNext(error: Error) {
      failures.push(error);
    },
    connect(
      upload: AttachmentUpload | null = vi.fn(),
      kinds?: readonly number[],
    ) {
      const owner = createRelaySession(
        {
          viewer: viewer.pubkey,
          relayAuthor: relayKey.pubkey,
          scope: origin,
          media: (url) => url,
          async query(filters) {
            return stored.filter((event) =>
              filters.some((filter) => matches(event, filter)),
            );
          },
          ...(upload ? { uploadAttachment: upload } : {}),
          writer: {
            ...(kinds ? { kinds } : {}),
            sign: async (template) => signed(viewer, template),
            async publish(event) {
              const failure = failures.shift();
              if (failure) throw failure;
              // NIP-33: the relay keeps only the latest set per coordinate.
              stored.splice(0, stored.length, event);
            },
          },
        },
        { outboxStorage: { load: () => [], save() {} } },
      );
      owners.push(owner);
      const value = {
        status: "ready",
        generation: 1,
        scope: `${origin}:${viewer.pubkey}`,
        viewer: viewer.pubkey,
        session: owner.session,
      };
      const relay = {
        snapshot: () => value,
        subscribe: () => () => {},
      } as unknown as RelayData;
      return render(<CustomEmojiSettings relay={relay} active={() => true} />, {
        wrapper: ToastProvider,
      });
    },
  };
}
const png = (name: string) => new File(["img"], name, { type: "image/png" });
const uploaded = (file: File) => ({
  name: file.name,
  url: `${origin}/media/${"a".repeat(64)}.png`,
  type: "image/png",
  size: file.size,
  sha256: "a".repeat(64),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("uploads, suggests a name, saves to the viewer's set and survives a reload", async () => {
  const user = userEvent.setup();
  const store = relayStore();
  const upload = vi.fn(async (file: File) => uploaded(file));
  const view = store.connect(upload);
  expect(
    await screen.findByText("You haven't added any emoji yet. Add one above."),
  ).toBeVisible();
  expect(
    screen.getByText(
      "Choose an image first; Buzz will suggest a name from the filename.",
    ),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Save emoji" })).toBeDisabled();
  await user.upload(
    screen.getByLabelText("Upload image"),
    png("Party Parrot.png"),
  );
  expect(
    await screen.findByRole("img", { name: "Selected custom emoji preview" }),
  ).toHaveAttribute("src", `${origin}/media/${"a".repeat(64)}.png`);
  expect(screen.getByRole("textbox")).toHaveValue("party_parrot");
  expect(
    screen.getByRole("button", { name: "Choose different image" }),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Save emoji" }));
  expect(await screen.findByText("Added :party_parrot:")).toBeVisible();
  expect(screen.getByText("My emoji (1)")).toBeVisible();
  expect(screen.getByRole("img", { name: ":party_parrot:" })).toBeVisible();
  expect(screen.getByRole("textbox")).toHaveValue("");
  expect(store.stored[0]?.tags).toEqual([
    ["d", "buzz:custom-emoji"],
    ["emoji", "party_parrot", `${origin}/media/${"a".repeat(64)}.png`],
  ]);
  view.unmount();
  store.connect(upload);
  expect(await screen.findByText("My emoji (1)")).toBeVisible();
  await user.type(screen.getByRole("textbox"), "party_parrot");
  await user.upload(screen.getByLabelText("Upload image"), png("other.png"));
  expect(
    await screen.findByText(
      "You already have :party_parrot: — saving will replace its image.",
    ),
  ).toBeVisible();
});

it("preserves name edits and disables Clear until a pending upload settles", async () => {
  const user = userEvent.setup();
  const store = relayStore();
  const pending = deferred<ReturnType<typeof uploaded>>();
  store.connect(vi.fn(() => pending.promise));
  await screen.findByText("You haven't added any emoji yet. Add one above.");

  await user.upload(
    screen.getByLabelText("Upload image"),
    png("suggested.png"),
  );
  await user.type(screen.getByRole("textbox"), "custom_name");
  const clear = screen.getByRole("button", { name: "Clear" });
  expect(clear).toBeDisabled();

  pending.resolve(uploaded(png("suggested.png")));
  await screen.findByRole("img", { name: "Selected custom emoji preview" });
  expect(screen.getByRole("textbox")).toHaveValue("custom_name");
  expect(clear).toBeEnabled();

  await user.click(clear);
  expect(screen.getByRole("textbox")).toHaveValue("");
  expect(
    screen.queryByRole("img", { name: "Selected custom emoji preview" }),
  ).toBeNull();
});

it("shows reference copy for invalid names, non-images and upload failures", async () => {
  const user = userEvent.setup();
  const store = relayStore();
  const upload = vi
    .fn<(file: File) => Promise<ReturnType<typeof uploaded>>>()
    .mockRejectedValueOnce(new UploadError("rejected"))
    .mockImplementationOnce(async (file) => ({
      ...uploaded(file),
      type: "application/pdf",
    }))
    .mockImplementation(async (file) => uploaded(file));
  store.connect(upload);
  await screen.findByText("You haven't added any emoji yet. Add one above.");
  await user.upload(screen.getByLabelText("Upload image"), png("one.png"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The server could not accept this file. Its format or metadata may not be supported.",
  );
  await user.upload(screen.getByLabelText("Upload image"), png("two.png"));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Choose an image file for custom emoji.",
    ),
  );
  expect(
    screen.queryByRole("img", { name: "Selected custom emoji preview" }),
  ).toBeNull();
  await user.upload(screen.getByLabelText("Upload image"), png("three.png"));
  await screen.findByRole("img", { name: "Selected custom emoji preview" });
  await user.clear(screen.getByRole("textbox"));
  await user.type(screen.getByRole("textbox"), "bad name");
  expect(
    screen.getByText("Use only letters, numbers, hyphen, or underscore."),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Save emoji" })).toBeDisabled();
  expect(store.stored).toEqual([]);
});

it("shows the failed save, keeps the draft and saves on retry", async () => {
  const user = userEvent.setup();
  const store = relayStore();
  store.connect(vi.fn(async (file: File) => uploaded(file)));
  await screen.findByText("You haven't added any emoji yet. Add one above.");
  await user.upload(screen.getByLabelText("Upload image"), png("wave.png"));
  await screen.findByRole("img", { name: "Selected custom emoji preview" });
  store.rejectNext(new PublishRejected("blocked: no"));
  const save = screen.getByRole("button", { name: "Save emoji" });
  await user.click(save);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Failed to add emoji.",
  );
  expect(save).toBeEnabled();
  expect(screen.getByRole("textbox")).toHaveValue("wave");
  expect(store.stored).toEqual([]);
  await user.click(save);
  expect(await screen.findByText("Added :wave:")).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(store.stored[0]?.tags).toContainEqual([
    "emoji",
    "wave",
    `${origin}/media/${"a".repeat(64)}.png`,
  ]);
});

it("shows the viewer's emoji but hides authoring without upload or kind-30030 writing", async () => {
  const store = relayStore();
  store.stored.push(
    signed(viewer, {
      kind: 30030,
      created_at: 1,
      content: "",
      tags: [
        ["d", "buzz:custom-emoji"],
        ["emoji", "mine", `${origin}/media/mine.png`],
      ],
    }),
  );
  const settled = async () => {
    expect(await screen.findByText("My emoji (1)")).toBeVisible();
    expect(screen.getByRole("img", { name: ":mine:" })).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/Add one above/)).toBeNull();
  };
  const view = store.connect(vi.fn(), [9]);
  await settled();
  expect(screen.queryByText("Add emoji")).toBeNull();
  expect(screen.queryByText(UPLOAD_FAILURES.unavailable)).toBeNull();
  view.unmount();
  store.connect(null);
  await settled();
  expect(screen.queryByLabelText("Upload image")).toBeNull();
  expect(screen.queryByText(UPLOAD_FAILURES.unavailable)).toBeNull();
});
