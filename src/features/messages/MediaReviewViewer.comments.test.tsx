// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { composerDOMFixture } from "./composer-testing";

composerDOMFixture();
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { EventTemplate } from "nostr-tools";
import { afterEach, assert, expect, it, vi } from "vitest";
import type { RelayEvent } from "../relay/events";
import { createRelaySession } from "../relay/session";
import { keypair, message, metadata, roster, signed } from "../relay/testing";
import { MediaReviewViewer } from "./MediaReviewViewer";
import { ThreadPanel } from "./ThreadPanel";

const owners: ReturnType<typeof createRelaySession>[] = [];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
});

type MediaKind = "image" | "video";
type ReviewFixtureOptions = {
  kind: MediaKind;
  openComments?: boolean;
  replies?: (
    viewer: ReturnType<typeof keypair>,
    root: RelayEvent,
  ) => readonly RelayEvent[];
  extraRootTags?: readonly string[][];
  fromThread?: boolean;
  attachmentInReply?: boolean;
};

function mime(kind: MediaKind) {
  return kind === "video" ? "video/mp4" : "image/png";
}

async function setupReview({
  kind,
  openComments = true,
  replies: buildReplies = () => [],
  extraRootTags = [],
  fromThread = false,
  attachmentInReply = false,
}: ReviewFixtureOptions) {
  // The DOM emulator has no playback engine; keep native playback calls observable.
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  if (fromThread) {
    // jsdom has no layout observer; the real thread still owns its read lifecycle.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  }
  const viewer = keypair();
  const relay = keypair();
  const attachment = {
    url: `https://fixture.test/${kind}.${kind === "video" ? "mp4" : "png"}`,
    kind,
  };
  const root = message(viewer, "one", `${kind} root`, 1, [
    ...(attachmentInReply
      ? []
      : [["imeta", `url ${attachment.url}`, `m ${mime(kind)}`]]),
    ...extraRootTags,
  ]);
  const attachmentOwner = attachmentInReply
    ? message(viewer, "one", "Video attached inside a reply", 2, [
        ["e", root.id, "", "reply"],
        ["imeta", `url ${attachment.url}`, `m ${mime(kind)}`],
      ])
    : root;
  const replies = [
    ...(attachmentInReply ? [attachmentOwner] : []),
    ...buildReplies(viewer, root),
  ];
  const sign = vi.fn(async (template: EventTemplate) =>
    signed(viewer, template),
  );
  const publish = vi.fn(async () => {});
  const events = [root, ...replies];
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: (url) => url,
      writer: { sign, publish },
      async query(filters) {
        return filters.flatMap((filter) => {
          if (filter.kinds?.includes(39002) || filter.kinds?.includes(39000))
            return [
              roster(relay, "one", [viewer.pubkey]),
              metadata(relay, "one", "One"),
            ];
          if (filter.ids)
            return events.filter((event) => filter.ids?.includes(event.id));
          if (filter.depth_limit)
            return replies.filter(
              (event) =>
                filter.thread_cursor === undefined ||
                event.created_at > filter.thread_cursor,
            );
          return [];
        });
      },
    },
    { outboxStorage: { load: () => [], save: () => {} } },
  );
  owners.push(owner);
  await owner.session.read([
    { kinds: [39002, 39000], "#d": ["one"], limit: 10 },
  ]);
  const user = userEvent.setup();
  const openReview = vi.fn();
  function Harness() {
    const [selectedTime, setSelectedTime] = useState(72);
    const [selectedId, setSelectedId] = useState(
      fromThread ? undefined : attachmentOwner.id,
    );
    return selectedId ? (
      <MediaReviewViewer
        attachment={attachment}
        session={owner.session}
        scope={`review-${kind}`}
        channelId="one"
        channelName="One"
        messageId={selectedId}
        initialTime={selectedTime}
        hasComments={fromThread}
        close={() => setSelectedId(undefined)}
        onOpenLink={() => false}
      />
    ) : (
      <ThreadPanel
        session={owner.session}
        scope={`review-${kind}`}
        channelId="one"
        channelName="One"
        messageId={root.id}
        close={() => {}}
        onOpenLink={() => false}
        onOpenMediaReview={(id, item, seconds, hasComments) => {
          openReview(id, item, seconds, hasComments);
          setSelectedTime(seconds);
          setSelectedId(id);
        }}
      />
    );
  }
  render(<Harness />);
  if (openComments && !fromThread)
    fireEvent.click(screen.getByRole("button", { name: "Show comments" }));
  return { owner, root, sign, user, attachmentOwner, openReview };
}

async function signedTemplate(sign: ReturnType<typeof vi.fn>) {
  await waitFor(() => expect(sign).toHaveBeenCalled());
  return sign.mock.calls.at(-1)?.[0] as EventTemplate;
}

async function typeAndSend(
  user: ReturnType<typeof userEvent.setup>,
  text: string,
) {
  await user.type(
    await screen.findByRole("textbox", { name: "Reply to thread" }),
    text,
  );
  await user.click(screen.getByRole("button", { name: "Send message" }));
}

it("publishes checked video review comments as time-prefixed kind 9 replies to the root", async () => {
  const { root, sign, user } = await setupReview({ kind: "video" });
  await screen.findByRole("dialog", { name: "Video review" });
  expect(
    await screen.findByRole("checkbox", { name: "Comment at current frame" }),
  ).toBeChecked();

  await typeAndSend(user, "adjust the cut");

  const event = await signedTemplate(sign);
  expect(event.kind).toBe(9);
  expect(event.content).toBe("⏱ 1:12 — adjust the cut");
  expect(event.tags).toEqual(
    expect.arrayContaining([
      ["h", "one"],
      ["e", root.id, "", "reply"],
    ]),
  );
});

it("publishes unchecked video review comments without a time prefix", async () => {
  const { root, sign, user } = await setupReview({ kind: "video" });
  await user.click(
    await screen.findByRole("checkbox", { name: "Comment at current frame" }),
  );

  await typeAndSend(user, "plain comment");

  const event = await signedTemplate(sign);
  expect(event.content).toBe("plain comment");
  expect(event.tags).toEqual(
    expect.arrayContaining([["e", root.id, "", "reply"]]),
  );
});

it("publishes image review comments as plain replies without a frame checkbox", async () => {
  const { root, sign, user } = await setupReview({ kind: "image" });
  await screen.findByRole("dialog", { name: "Image viewer" });
  expect(
    screen.queryByLabelText("Comment at current frame"),
  ).not.toBeInTheDocument();

  await typeAndSend(user, "image note");

  const event = await signedTemplate(sign);
  expect(event.content).toBe("image note");
  expect(event.tags).toEqual(
    expect.arrayContaining([["e", root.id, "", "reply"]]),
  );
});

it("seeks the review video from a timecode reply when the thread has one video", async () => {
  const { user } = await setupReview({
    kind: "video",
    replies: (viewer, root) => [
      message(viewer, "one", "⏱ 0:42 — jump here", 2, [
        ["e", root.id, "", "reply"],
      ]),
    ],
  });
  await screen.findByText("jump here");
  const dialog = await screen.findByRole("dialog", { name: "Video review" });
  const video = dialog.querySelector("video");
  assert.exists(video);
  const play = vi.fn(async () => {});
  // jsdom does not implement media playback, so play() needs a test stub.
  Object.defineProperty(video, "play", { configurable: true, value: play });

  await user.click(screen.getByRole("button", { name: "0:42" }));

  // jsdom media time remains at initialTime until the seek handler sets it.
  expect(video.currentTime).toBe(42);
  expect(play).toHaveBeenCalledTimes(1);
});

it("opens the sole reply video from a timestamp in the thread at the requested frame", async () => {
  const { user, attachmentOwner, openReview } = await setupReview({
    kind: "video",
    fromThread: true,
    attachmentInReply: true,
    replies: (viewer, root) => [
      message(viewer, "one", "[00:42.5] Seek the reply video", 3, [
        ["e", root.id, "", "reply"],
      ]),
    ],
  });
  expect(await screen.findByText("Seek the reply video")).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "00:42.5" }));
  expect(openReview).toHaveBeenCalledExactlyOnceWith(
    attachmentOwner.id,
    expect.objectContaining({ kind: "video" }),
    42.5,
    true,
  );
  const dialog = await screen.findByRole("dialog", { name: "Video review" });
  const video = dialog.querySelector("video");
  assert.exists(video);
  fireEvent.loadedMetadata(video);
  expect(video.currentTime).toBe(42.5);
});

it("keeps thread timestamps noninteractive when a reply video conflicts with a root video", async () => {
  const { openReview } = await setupReview({
    kind: "video",
    fromThread: true,
    attachmentInReply: true,
    extraRootTags: [
      ["imeta", "url https://fixture.test/other.mp4", "m video/mp4"],
    ],
    replies: (viewer, root) => [
      message(viewer, "one", "[00:42.5] Ambiguous target", 3, [
        ["e", root.id, "", "reply"],
      ]),
    ],
  });
  expect(await screen.findByText("Ambiguous target")).toBeVisible();
  expect(screen.getByText("00:42.5").tagName).toBe("SPAN");
  expect(screen.queryByRole("button", { name: "00:42.5" })).toBeNull();
  expect(openReview).not.toHaveBeenCalled();
});

it.each([false, true])(
  "seeks the selected full-viewer video with multiple videos (thread entry: %s)",
  async (fromThread) => {
    const { user } = await setupReview({
      kind: "video",
      fromThread,
      extraRootTags: [
        ["imeta", "url https://fixture.test/other.mp4", "m video/mp4"],
      ],
      replies: (viewer, root) => [
        message(viewer, "one", "⏱ 0:42 — keep text", 2, [
          ["e", root.id, "", "reply"],
        ]),
      ],
    });
    expect(await screen.findByText("keep text")).toBeVisible();
    if (fromThread) {
      expect(screen.getByText("0:42").tagName).toBe("SPAN");
      expect(screen.queryByRole("button", { name: "0:42" })).toBeNull();
      const expand = screen.getAllByRole("button", {
        name: "Open video fullscreen",
      })[0];
      assert.exists(expand);
      await user.click(expand);
    }
    const dialog = await screen.findByRole("dialog", { name: "Video review" });
    const video = dialog.querySelector("video");
    assert.exists(video);
    Object.defineProperty(video, "duration", {
      configurable: true,
      value: 100,
    });
    fireEvent.durationChange(video);
    await user.click(within(dialog).getByRole("button", { name: "0:42" }));
    expect(video.currentTime).toBe(42);
    video.currentTime = 1;
    await user.click(
      within(dialog).getByRole("button", { name: /^Seek to 0:42,/ }),
    );
    expect(video.currentTime).toBe(42);
  },
);

it.each(["[00:42.5]", "[00:42.5]No space", "[00:42.5]\nNew line"])(
  "seeks timestamp-only and compact legacy comments: %s",
  async (content) => {
    const { user } = await setupReview({
      kind: "video",
      replies: (viewer, root) => [
        message(viewer, "one", content, 3, [["e", root.id, "", "reply"]]),
      ],
    });
    const chip = await screen.findByRole("button", { name: "00:42.5" });
    await user.click(chip);
    expect(document.querySelector("video")?.currentTime).toBe(42.5);
  },
);

it.each([
  { fromThread: false, attachmentInReply: false },
  { fromThread: true, attachmentInReply: false },
  { fromThread: false, attachmentInReply: true },
  { fromThread: true, attachmentInReply: true },
])(
  "resolves the same comments and reply root from $fromThread thread entry, reply attachment $attachmentInReply",
  async (entry) => {
    const { user, root, sign, attachmentOwner, openReview } = await setupReview(
      {
        kind: "video",
        ...entry,
        replies: (viewer, root) => [
          message(viewer, "one", "[00:42.5] Shared comment", 3, [
            ["e", root.id, "", "reply"],
          ]),
        ],
      },
    );
    if (entry.fromThread) {
      await user.click(
        await screen.findByRole("button", { name: "Open video fullscreen" }),
      );
      expect(openReview).toHaveBeenCalledWith(
        attachmentOwner.id,
        expect.objectContaining({ kind: "video" }),
        0,
        true,
      );
    }
    const dialog = await screen.findByRole("dialog", { name: "Video review" });
    expect(await screen.findByText("Shared comment")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "00:42.5" }));
    expect(dialog.querySelector("video")?.currentTime).toBe(42.5);
    await typeAndSend(user, "Same conversation");
    expect((await signedTemplate(sign)).tags).toContainEqual([
      "e",
      root.id,
      "",
      "reply",
    ]);
  },
);

it("shares legacy fractional timecodes between timeline markers and sidebar and stamps quick reactions", async () => {
  const { user, sign, root } = await setupReview({
    kind: "video",
    replies: (viewer, root) => [
      message(viewer, "one", "[00:42.5] A fractional timestamp comment", 2, [
        ["e", root.id, "", "reply"],
      ]),
    ],
  });
  await screen.findByText("A fractional timestamp comment");
  const video = document.querySelector("video");
  assert.exists(video);
  vi.spyOn(video, "pause").mockImplementation(() => {});
  Object.defineProperty(video, "duration", { configurable: true, value: 100 });
  fireEvent.durationChange(video);
  await user.click(screen.getByRole("button", { name: /^Seek to 00:42.5/ }));
  expect(video.currentTime).toBe(42.5);
  video.currentTime = 1;
  await user.click(screen.getByRole("button", { name: "00:42.5" }));
  expect(video.currentTime).toBe(42.5);
  await user.click(
    screen.getByRole("button", { name: "React 👍 at current frame" }),
  );
  const event = await signedTemplate(sign);
  expect(event.content).toBe("⏱ 0:42 — 👍");
  expect(event.tags).toContainEqual(["e", root.id, "", "reply"]);
  expect(
    await screen.findByRole("button", { name: /^Seek to 0:42,/ }),
  ).toBeInTheDocument();
});

it.each(["image", "video"] as const)(
  "starts an empty %s review dark with comments closed",
  async (kind) => {
    const { user } = await setupReview({ kind, openComments: false });
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(
        dialog.querySelector('[aria-label="Reply to thread"]'),
      ).not.toBeNull(),
    );
    expect(dialog).toHaveAttribute("data-color-mode", "dark");
    expect(dialog).toHaveAttribute("data-comments-hidden");
    expect(
      screen.queryByRole("complementary", { name: "Media comments" }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show comments" }));
    const composer = await screen.findByRole("textbox", {
      name: "Reply to thread",
    });
    await user.type(composer, "Keep this draft");
    await user.click(screen.getByRole("button", { name: "Hide comments" }));
    await user.click(screen.getByRole("button", { name: "Show comments" }));
    expect(screen.getByRole("textbox", { name: "Reply to thread" })).toBe(
      composer,
    );
    expect(composer).toHaveTextContent("Keep this draft");
  },
);

it("opens image comments by default when the thread contains replies", async () => {
  await setupReview({
    kind: "image",
    openComments: false,
    replies: (viewer, root) => [
      message(viewer, "one", "Photo feedback", 2, [
        ["e", root.id, "", "reply"],
      ]),
    ],
  });
  expect(await screen.findByText("Photo feedback")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Hide comments" }),
  ).toBeInTheDocument();
});
