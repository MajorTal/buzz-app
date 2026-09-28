// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useRef, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import { keypair, message } from "../relay/testing";
import { AttachmentImage } from "./AttachmentImage";
import { MediaAttachment } from "./MediaAttachment";
import { MediaReviewViewer } from "./MediaReviewViewer";

const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "animate");
});

function setup(
  kind: "image" | "video",
  reduced = false,
  hasComments = false,
  imageReady = true,
) {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
    imageReady,
  );
  const cancel = vi.fn();
  const animate = vi.fn(
    (_frames: Keyframe[], _options: KeyframeAnimationOptions) => ({
      cancel,
      onfinish: null as (() => void) | null,
    }),
  );
  Object.defineProperty(HTMLElement.prototype, "animate", {
    value: animate,
    configurable: true,
  });
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: reduced,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this.hasAttribute("data-media-preview")
        ? new DOMRect(100, 200, 320, 180)
        : new DOMRect(20, 20, 1000, 700);
    },
  );
  const viewer = keypair();
  const attachment = { url: `https://fixture.test/${kind}`, kind };
  const root = message(viewer, "one", "Media", 1, [
    [
      "imeta",
      `url ${attachment.url}`,
      `m ${kind === "image" ? "image/png" : "video/mp4"}`,
    ],
  ]);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: keypair().pubkey,
    media: (url) => url,
    async query(filters) {
      if (filters.some((filter) => filter.ids?.includes(root.id))) {
        await gate;
        return [root];
      }
      return [];
    },
  });
  owners.push(owner);
  function Harness() {
    const [open, setOpen] = useState(false);
    const opener = useRef<HTMLElement | null>(null);
    return (
      <>
        {kind === "image" ? (
          <AttachmentImage
            attachment={attachment}
            url={attachment.url}
            source={attachment.url}
            onOpenLink={() => false}
            onOpenReview={() => {
              opener.current = document.activeElement as HTMLElement;
              setOpen(true);
            }}
          />
        ) : (
          <MediaAttachment
            attachment={attachment}
            media={owner.session.media}
            onOpenReview={() => {
              opener.current = document.activeElement as HTMLElement;
              setOpen(true);
            }}
          />
        )}
        {open && (
          <MediaReviewViewer
            attachment={attachment}
            session={owner.session}
            scope="motion-test"
            channelId="one"
            channelName="One"
            messageId={root.id}
            initialTime={0}
            hasComments={hasComments}
            restoreFocus={opener}
            close={() => setOpen(false)}
            onOpenLink={() => false}
          />
        )}
      </>
    );
  }
  render(<Harness />);
  return { animate, cancel, release };
}

it.each(["image", "video"] as const)(
  "grows %s from its clicked preview once across deferred thread loading",
  async (kind) => {
    const { animate, cancel, release } = setup(kind);
    fireEvent.click(
      screen.getByRole(kind === "image" ? "link" : "button", {
        name:
          kind === "image" ? "Open image attachment" : "Open video fullscreen",
      }),
      { detail: 1 },
    );
    const dialog = screen.getByRole("dialog");
    const media = dialog.querySelector("[data-review-media]");
    expect(media).not.toBeNull();
    expect(animate.mock.contexts[0]).toBe(media);
    const animationCount = animate.mock.calls.length;
    expect(animationCount).toBeGreaterThan(3);
    expect(animate.mock.calls[1]?.[1]).toMatchObject({
      delay: 80,
      fill: "backwards",
    });
    expect(animate.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          transform: "translate(-260px, -80px) scale(0.32)",
        }),
      ]),
    );
    try {
      await act(async () => release());
      await waitFor(() =>
        expect(screen.queryByText("Loading media…")).toBeNull(),
      );
      expect(screen.getByRole("dialog")).toBe(dialog);
      expect(dialog.querySelector("[data-review-media]")).toBe(media);
      expect(animate).toHaveBeenCalledTimes(animationCount);
      fireEvent.click(
        screen.getByRole("button", { name: "Close fullscreen viewer" }),
      );
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(cancel).toHaveBeenCalledTimes(animationCount);
    } finally {
      release();
    }
  },
);

it("opens immediately for keyboard activation", () => {
  const { animate, release } = setup("image");
  try {
    fireEvent.click(
      screen.getByRole("link", { name: "Open image attachment" }),
      { detail: 0 },
    );
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(animate).not.toHaveBeenCalled();
  } finally {
    release();
  }
});
it("opens immediately with reduced motion", () => {
  const { animate, release } = setup("video", true);
  try {
    fireEvent.click(
      screen.getByRole("button", { name: "Open video fullscreen" }),
      { detail: 1 },
    );
    expect(animate).not.toHaveBeenCalled();
  } finally {
    release();
  }
});
it("settles the entrance immediately when the user interacts", () => {
  const { animate, cancel, release } = setup("image");
  try {
    fireEvent.click(
      screen.getByRole("link", { name: "Open image attachment" }),
      { detail: 1 },
    );
    fireEvent.pointerDown(screen.getByRole("dialog"));
    expect(cancel).toHaveBeenCalledTimes(animate.mock.calls.length);
  } finally {
    release();
  }
});

it.each(["image", "video"] as const)(
  "dismisses %s from the backdrop and restores focus without dismissing inside interactions",
  async (kind) => {
    const { animate, release } = setup(kind);
    const opener = screen.getByRole(kind === "image" ? "link" : "button", {
      name:
        kind === "image" ? "Open image attachment" : "Open video fullscreen",
    });
    fireEvent.click(opener, { detail: 1 });
    const dialog = screen.getByRole("dialog");
    const backdrop = dialog.parentElement;
    if (!backdrop) throw new Error("Missing backdrop");
    try {
      // Finishing a drag outside must not count as a backdrop click.
      fireEvent.mouseDown(dialog, { button: 0 });
      fireEvent.mouseUp(backdrop, { button: 0 });
      fireEvent.click(backdrop);
      expect(screen.getByRole("dialog")).toBe(dialog);
      fireEvent.mouseDown(backdrop, { button: 2 });
      expect(screen.getByRole("dialog")).toBe(dialog);
      const exitStart = animate.mock.calls.length;
      fireEvent.mouseDown(backdrop, { button: 0 });
      expect(dialog).toHaveAttribute("data-review-closing");
      act(() => animate.mock.results[exitStart]?.value.onfinish?.());
      expect(screen.queryByRole("dialog")).toBeNull();
      await waitFor(() => expect(opener).toHaveFocus());
    } finally {
      await act(async () => release());
    }
  },
);

it("fits a portrait photo without stretching it", async () => {
  const { animate, release } = setup("image");
  const thumbnail = document.querySelector("img") as HTMLImageElement;
  Object.defineProperties(thumbnail, {
    naturalWidth: { value: 400 },
    naturalHeight: { value: 800 },
  });
  fireEvent.click(screen.getByRole("link", { name: "Open image attachment" }), {
    detail: 1,
  });
  const dialog = screen.getByRole("dialog");
  expect(dialog).toHaveAttribute("data-review-opening");
  expect(animate.mock.calls[0]?.[0][0]).toMatchObject({
    transform: "translate(-260px, -80px) scale(0.2571428571428571)",
  });
  // Media is present before the delayed thread read is released.
  expect(dialog.querySelector("img")?.getAttribute("src")).toBe(
    "https://fixture.test/image",
  );
  act(() => animate.mock.results[0]?.value.onfinish?.());
  expect(dialog).not.toHaveAttribute("data-review-opening");
  await act(async () => release());
});

it("returns to the current thumbnail position and keeps focus trapped until arrival", () => {
  const { animate, release } = setup("image");
  const opener = screen.getByRole("link", { name: "Open image attachment" });
  fireEvent.click(opener, { detail: 1 });
  act(() => animate.mock.results[0]?.value.onfinish?.());
  const preview = opener.closest("[data-media-preview]");
  expect(preview).toHaveStyle({ opacity: "0" });
  Object.defineProperty(preview, "getBoundingClientRect", {
    value: () => new DOMRect(200, 100, 320, 180),
    configurable: true,
  });
  const exitStart = animate.mock.calls.length;
  fireEvent.click(
    screen.getByRole("button", { name: "Close fullscreen viewer" }),
    { detail: 1 },
  );
  expect(screen.getByRole("dialog")).toHaveAttribute("data-review-closing");
  expect(animate.mock.calls[exitStart]?.[0][1]).toMatchObject({
    transform: "translate(-160px, -180px) scale(0.32)",
  });
  act(() => animate.mock.results[exitStart]?.value.onfinish?.());
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(preview).not.toHaveStyle({ opacity: "0" });
  release();
});

it("fades out a zoomed photo without returning the crop to the thumbnail", () => {
  const { animate, release } = setup("image");
  fireEvent.click(screen.getByRole("link", { name: "Open image attachment" }), {
    detail: 1,
  });
  act(() => animate.mock.results[0]?.value.onfinish?.());
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  const exitStart = animate.mock.calls.length;
  fireEvent.click(
    screen.getByRole("button", { name: "Close fullscreen viewer" }),
    { detail: 1 },
  );
  expect(animate.mock.calls[exitStart]?.[0]).toEqual([
    { opacity: 1 },
    { opacity: 0 },
  ]);
  // Escape remains immediate, even during a pending pointer dismissal.
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(animate.mock.results[exitStart]?.value.onfinish).toBeNull();
  release();
});

it("finishes a pending return immediately if the viewport changes", () => {
  const { release } = setup("image");
  fireEvent.click(screen.getByRole("link", { name: "Open image attachment" }), {
    detail: 1,
  });
  fireEvent.mouseDown(screen.getByRole("dialog").parentElement as HTMLElement, {
    button: 0,
  });
  expect(screen.getByRole("dialog")).toHaveAttribute("data-review-closing");
  fireEvent(window, new Event("resize"));
  expect(screen.queryByRole("dialog")).toBeNull();
  release();
});

it("closes immediately for reduced motion even with pointer activation", () => {
  const { animate, release } = setup("image", true);
  fireEvent.click(screen.getByRole("link", { name: "Open image attachment" }), {
    detail: 1,
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Close fullscreen viewer" }),
    { detail: 1 },
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(animate).not.toHaveBeenCalled();
  release();
});

it.each(["image", "video"] as const)(
  "reserves the comments layout for %s before thread loading or motion finishes",
  (kind) => {
    const { release } = setup(kind, false, true);
    fireEvent.click(
      screen.getByRole(kind === "image" ? "link" : "button", {
        name:
          kind === "image" ? "Open image attachment" : "Open video fullscreen",
      }),
      { detail: 1 },
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("data-review-opening");
    expect(dialog).not.toHaveAttribute("data-comments-hidden");
    expect(dialog).not.toHaveAttribute("data-comments-motion");
    expect(screen.getByRole("button", { name: "Hide comments" })).toBeVisible();
    release();
  },
);

it.each(["image", "video"] as const)(
  "starts %s without the sidebar when there are no comments",
  (kind) => {
    const { release } = setup(kind);
    fireEvent.click(
      screen.getByRole(kind === "image" ? "link" : "button", {
        name:
          kind === "image" ? "Open image attachment" : "Open video fullscreen",
      }),
      { detail: 1 },
    );
    expect(screen.getByRole("dialog")).toHaveAttribute("data-comments-hidden");
    release();
  },
);

it.each([false, true])(
  "keeps the chat photo visible until ready and returns with matching corners (smooth: %s)",
  (smooth) => {
    const { animate, release } = setup("image", false, false, false);
    const opener = screen.getByRole("link", { name: "Open image attachment" });
    if (smooth) opener.dataset.smoothCorners = "";
    opener.style.borderTopLeftRadius = "12px";
    opener.style.borderTopRightRadius = "12px";
    opener.style.borderBottomRightRadius = "12px";
    opener.style.borderBottomLeftRadius = "12px";
    fireEvent.click(opener, { detail: 1 });
    const dialog = screen.getByRole("dialog");
    const image = dialog.querySelector("img") as HTMLImageElement;
    expect(dialog).toHaveAttribute("data-review-pending");
    expect(opener).not.toHaveStyle({ opacity: "0" });
    expect(animate).not.toHaveBeenCalled();
    fireEvent.load(image);
    expect(dialog).not.toHaveAttribute("data-review-pending");
    expect(dialog).toHaveAttribute("data-review-opening");
    expect(opener).toHaveStyle({ opacity: "0" });
    const firstFrame = animate.mock.calls[0]?.[0][0];
    expect(firstFrame?.clipPath).toContain(
      smooth ? "a 37.5 37.5" : "round 37.5px 37.5px 37.5px 37.5px",
    );
    act(() => animate.mock.results[0]?.value.onfinish?.());
    const exitStart = animate.mock.calls.length;
    fireEvent.click(
      screen.getByRole("button", { name: "Close fullscreen viewer" }),
      { detail: 1 },
    );
    expect(animate.mock.calls[exitStart]?.[0][1]?.clipPath).toBe(
      firstFrame?.clipPath,
    );
    act(() => animate.mock.results[exitStart]?.value.onfinish?.());
    expect(image.style.visibility).toBe("hidden");
    expect(opener).not.toHaveStyle({ opacity: "0" });
    expect(screen.queryByRole("dialog")).toBeNull();
    release();
  },
);

it("does not start a late image entrance after the viewer has been dismissed", () => {
  const { animate, release } = setup("image", false, false, false);
  fireEvent.click(screen.getByRole("link", { name: "Open image attachment" }), {
    detail: 1,
  });
  const image = screen
    .getByRole("dialog")
    .querySelector("img") as HTMLImageElement;
  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.load(image);
  expect(animate).not.toHaveBeenCalled();
  release();
});

it.each(["image", "video"] as const)(
  "moves the live %s once when comments resize the layout",
  (kind) => {
    const { animate, release } = setup(kind, false, true);
    fireEvent.click(
      screen.getByRole(kind === "image" ? "link" : "button", {
        name:
          kind === "image" ? "Open image attachment" : "Open video fullscreen",
      }),
      { detail: 1 },
    );
    act(() => animate.mock.results[0]?.value.onfinish?.());
    const dialog = screen.getByRole("dialog");
    const media = dialog.querySelector("[data-review-media]") as HTMLElement;
    Object.defineProperties(media, {
      getBoundingClientRect: {
        value: () =>
          new DOMRect(
            20,
            20,
            dialog.hasAttribute("data-comments-hidden") ? 1000 : 800,
            500,
          ),
      },
      ...(kind === "image"
        ? { naturalWidth: { value: 1600 }, naturalHeight: { value: 800 } }
        : { videoWidth: { value: 1600 }, videoHeight: { value: 800 } }),
    });
    const start = animate.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Hide comments" }), {
      detail: 1,
    });
    expect(dialog.querySelector("[data-review-media]")).toBe(media);
    expect(animate).toHaveBeenCalledTimes(start + 1);
    expect(animate.mock.contexts[start]).toBe(media);
    expect(animate.mock.calls[start]?.[0][0]).toMatchObject({
      transform: "translate(-100px, 0px) scale(0.8)",
    });
    expect(animate.mock.calls[start]?.[1]).toMatchObject({ duration: 200 });
    expect(animate.mock.calls[start]?.[1]).not.toHaveProperty("fill");
    expect(dialog).toHaveAttribute("data-review-resizing");
    // A zoom or seek interaction must retire the temporary layout transform.
    fireEvent.pointerDown(media);
    expect(dialog).not.toHaveAttribute("data-review-resizing");
    fireEvent.click(screen.getByRole("button", { name: "Show comments" }), {
      detail: 1,
    });
    expect(dialog).toHaveAttribute("data-review-resizing");
    act(() => animate.mock.results[start + 1]?.value.onfinish?.());
    expect(dialog).not.toHaveAttribute("data-review-resizing");
    release();
  },
);

it.each([false, true])(
  "keeps keyboard/reduced-motion sidebar changes instant (reduced: %s)",
  (reduced) => {
    const { animate, release } = setup("image", reduced, true);
    fireEvent.click(
      screen.getByRole("link", { name: "Open image attachment" }),
      { detail: 0 },
    );
    fireEvent.click(screen.getByRole("button", { name: "Hide comments" }), {
      detail: reduced ? 1 : 0,
    });
    expect(screen.getByRole("dialog")).toHaveAttribute("data-comments-hidden");
    expect(animate).not.toHaveBeenCalled();
    release();
  },
);

it("preserves the photo zoom when the comments layout changes", () => {
  const { animate, release } = setup("image", false, true);
  fireEvent.click(screen.getByRole("link", { name: "Open image attachment" }), {
    detail: 0,
  });
  const media = screen.getByRole("dialog").querySelector("[data-review-media]");
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  const transform = media?.getAttribute("style");
  fireEvent.click(screen.getByRole("button", { name: "Hide comments" }), {
    detail: 1,
  });
  expect(media?.getAttribute("style")).toBe(transform);
  expect(animate).not.toHaveBeenCalled();
  release();
});

it("keeps an unfinished entrance intact until the close action reverses it and hides the shell before retirement", () => {
  const { animate, cancel, release } = setup("image");
  fireEvent.click(screen.getByRole("link", { name: "Open image attachment" }), {
    detail: 1,
  });
  const dialog = screen.getByRole("dialog");
  const backdrop = dialog.parentElement;
  const media = dialog.querySelector("[data-review-media]") as HTMLElement;
  media.style.transform = "matrix(0.6, 0, 0, 0.6, -100, -50)";
  media.style.clipPath = "inset(12px round 8px)";
  const close = screen.getByRole("button", { name: "Close fullscreen viewer" });
  fireEvent.pointerDown(close);
  expect(dialog).toHaveAttribute("data-review-opening");
  expect(cancel).not.toHaveBeenCalled();
  const exitStart = animate.mock.calls.length;
  fireEvent.click(close, { detail: 1 });
  expect(animate.mock.calls[exitStart]?.[0][0]).toMatchObject({
    transform: "matrix(0.6, 0, 0, 0.6, -100, -50)",
    clipPath: "inset(12px round 8px)",
  });
  act(() => animate.mock.results[exitStart]?.value.onfinish?.());
  expect(backdrop).toHaveStyle({ visibility: "hidden" });
  expect(screen.queryByRole("dialog")).toBeNull();
  release();
});

it("starts image navigation on the viewer rather than the close button", () => {
  const { release } = setup("image");
  fireEvent.click(screen.getByRole("link", { name: "Open image attachment" }), {
    detail: 1,
  });
  expect(screen.getByRole("dialog")).toHaveFocus();
  expect(
    screen.getByRole("button", { name: "Close fullscreen viewer" }),
  ).not.toHaveFocus();
  release();
});

it("keeps Tab and Shift+Tab in the dialog when initial focus is its noninteractive frame", () => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue({
    length: 1,
  } as DOMRectList);
  const { release } = setup("image");
  fireEvent.click(screen.getByRole("link", { name: "Open image attachment" }), {
    detail: 1,
  });
  const dialog = screen.getByRole("dialog");
  fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
  expect(
    screen.getByRole("link", { name: "Open image in browser" }),
  ).toHaveFocus();
  dialog.focus();
  fireEvent.keyDown(dialog, { key: "Tab" });
  expect(screen.getByRole("button", { name: "Show comments" })).toHaveFocus();
  release();
});

it("stops video playback at dismissal and fades reactions with the other controls", async () => {
  const { animate, release } = setup("video");
  fireEvent.click(
    screen.getByRole("button", { name: "Open video fullscreen" }),
    { detail: 1 },
  );
  await act(async () => release());
  const dialog = screen.getByRole("dialog");
  const video = dialog.querySelector("video");
  if (!video) throw new Error("Missing review video");
  const pause = vi.spyOn(video, "pause").mockImplementation(() => {});
  const play = vi.spyOn(video, "play").mockResolvedValue(undefined);
  const reactions = screen.getByRole("group", {
    name: "React at current frame",
  }).parentElement;
  vi.useFakeTimers();
  try {
    fireEvent.click(video);
    act(() => vi.advanceTimersByTime(100));
    const exitStart = animate.mock.calls.length;
    fireEvent.click(
      screen.getByRole("button", { name: "Close fullscreen viewer" }),
      { detail: 1 },
    );
    expect(pause).toHaveBeenCalledOnce();
    expect(dialog).toHaveAttribute("data-review-closing");
    const reactionFade = animate.mock.contexts.findIndex(
      (element, index) => index >= exitStart && element === reactions,
    );
    expect(reactionFade).toBeGreaterThanOrEqual(exitStart);
    expect(animate.mock.calls[reactionFade]?.[0]).toEqual([
      { opacity: "1" },
      { opacity: 0 },
    ]);
    expect(animate.mock.calls[reactionFade]?.[1]).toMatchObject({
      duration: 100,
      easing: "ease-out",
      fill: "forwards",
    });
    fireEvent.keyDown(dialog, { key: " " });
    act(() => vi.advanceTimersByTime(250));
    expect(play).not.toHaveBeenCalled();
    // Native play promises may complete after the exit has started.
    fireEvent.play(video);
    expect(pause).toHaveBeenCalledTimes(2);
    act(() => animate.mock.results[exitStart]?.value.onfinish?.());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(pause).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});

it.each(["escape", "backdrop"])(
  "stops video playback when closing via %s",
  (method) => {
    const { release } = setup("video");
    try {
      fireEvent.click(
        screen.getByRole("button", { name: "Open video fullscreen" }),
        { detail: 1 },
      );
      const dialog = screen.getByRole("dialog");
      const video = dialog.querySelector("video");
      if (!video) throw new Error("Missing review video");
      const pause = vi.spyOn(video, "pause").mockImplementation(() => {});
      if (method === "escape") fireEvent.keyDown(document, { key: "Escape" });
      else
        fireEvent.mouseDown(dialog.parentElement as HTMLElement, { button: 0 });
      expect(pause).toHaveBeenCalled();
    } finally {
      release();
    }
  },
);
