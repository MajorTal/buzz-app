// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import { keypair, message, signed } from "../relay/testing";
import { MediaReviewViewer } from "./MediaReviewViewer";

const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
  vi.restoreAllMocks();
});

const videoAttachment = {
  url: "https://fixture.test/video.mp4",
  kind: "video" as const,
};

function setupReview(initialTime = 7, writable = false) {
  const viewer = keypair();
  const root = message(viewer, "one", "Video", 1, [
    ["imeta", `url ${videoAttachment.url}`, "m video/mp4"],
  ]);
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: keypair().pubkey,
    media: (url) => `media:${url}`,
    ...(writable
      ? {
          writer: {
            sign: async (template) => signed(viewer, template),
            publish: async () => {},
          },
        }
      : {}),
    async query(filters) {
      if (filters.some((filter) => filter.ids?.includes(root.id)))
        return [root];
      return [];
    },
  });
  owners.push(owner);
  const close = vi.fn();
  render(
    <MediaReviewViewer
      attachment={videoAttachment}
      session={owner.session}
      scope="video-review-test"
      channelId="one"
      channelName="One"
      messageId={root.id}
      initialTime={initialTime}
      onOpenLink={() => false}
      close={close}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Show comments" }));
  return { root, close };
}

it("opens shared video review at the requested frame and tracks playback time", async () => {
  setupReview(7);
  const video = await waitFor(() => {
    const element = document.querySelector("video");
    if (!element) throw new Error("Missing video element");
    return element;
  });

  fireEvent.loadedMetadata(video);
  expect(video.currentTime).toBe(7);
  expect(video).toHaveAttribute("autoplay");

  video.currentTime = 65;
  fireEvent.timeUpdate(video);

  expect(
    within(
      screen.getByRole("complementary", { name: "Media comments" }),
    ).getByText("01:05"),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("checkbox", { name: "Comment at current frame" }),
  ).toBeChecked();
});

it("shows unavailable treatment when shared video review playback errors", async () => {
  setupReview();
  const video = await waitFor(() => {
    const element = document.querySelector("video");
    if (!element) throw new Error("Missing video element");
    return element;
  });

  fireEvent.error(video);

  expect(await screen.findByRole("status")).toHaveTextContent(
    "Media unavailable",
  );
  expect(document.querySelector("video")).toBeNull();
});

it("keeps the same video and playback position when hiding and showing comments", async () => {
  setupReview(7);
  const seek = await screen.findByRole("slider", { name: "Video timeline" });
  const video = document.querySelector("video");
  if (!video) throw new Error("Missing video element");
  Object.defineProperty(video, "duration", { configurable: true, value: 120 });
  fireEvent.durationChange(video);
  fireEvent.change(seek, { target: { value: "45" } });
  expect(video.currentTime).toBe(45);
  expect(seek).toHaveAttribute("aria-valuetext", "00:45 / 02:00");
  const comments = screen.getByRole("complementary", {
    name: "Media comments",
  });
  const timeOption = screen.getByRole("checkbox", {
    name: "Comment at current frame",
  });
  fireEvent.click(timeOption);
  fireEvent.click(screen.getByRole("button", { name: "Hide comments" }), {
    detail: 1,
  });
  expect(screen.getByRole("dialog", { name: "Video review" })).toHaveAttribute(
    "data-comments-motion",
  );
  expect(comments).toHaveAttribute("inert");
  expect(comments).toContainElement(timeOption);
  expect(
    screen.queryByRole("complementary", { name: "Media comments" }),
  ).toBeNull();
  expect(document.querySelector("video")).toBe(video);
  expect(video.currentTime).toBe(45);
  fireEvent.click(screen.getByRole("button", { name: "Show comments" }));
  expect(
    screen.getByRole("dialog", { name: "Video review" }),
  ).not.toHaveAttribute("data-comments-motion");
  expect(comments).not.toHaveAttribute("inert");
  expect(
    screen.getByRole("checkbox", { name: "Comment at current frame" }),
  ).toBe(timeOption);
  expect(timeOption).not.toBeChecked();
  expect(
    screen.getByRole("complementary", { name: "Media comments" }),
  ).toBeVisible();
  expect(document.querySelector("video")).toBe(video);
  expect(video.currentTime).toBe(45);
});

it("controls playback, speed and sound without native controls", async () => {
  setupReview();
  await screen.findByRole("slider", { name: "Video timeline" });
  const video = document.querySelector("video");
  if (!video) throw new Error("Missing video element");
  expect(video).not.toHaveAttribute("controls");
  const play = vi.spyOn(video, "play").mockImplementation(() => {
    fireEvent.play(video);
    return Promise.resolve();
  });
  fireEvent.click(screen.getByRole("button", { name: "Play video" }));
  expect(play).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Pause video" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Playback speed: 1x" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "1.5x" }));
  expect(video.playbackRate).toBe(1.5);
  fireEvent.click(screen.getByRole("button", { name: "Video volume" }));
  expect(video.muted).toBe(false);
  expect(video.volume).toBe(1);
  fireEvent.change(screen.getByRole("slider", { name: "Video volume" }), {
    target: { value: "0.5" },
  });
  expect(video.volume).toBe(0.5);
  fireEvent.volumeChange(video);
  fireEvent.click(screen.getByRole("button", { name: "Mute video" }));
  expect(video.muted).toBe(true);
  fireEvent.volumeChange(video);
  const volume = screen.getByRole("slider", { name: "Video volume" });
  expect(volume).toHaveValue("0");
  fireEvent.click(screen.getByRole("button", { name: "Unmute video" }));
  fireEvent.volumeChange(video);
  expect(video.muted).toBe(false);
  expect(volume).toHaveValue("0.5");
  fireEvent.change(volume, { target: { value: "0" } });
  fireEvent.volumeChange(video);
  fireEvent.click(screen.getByRole("button", { name: "Unmute video" }));
  fireEvent.volumeChange(video);
  expect(video.volume).toBe(1);
  expect(volume).toHaveValue("1");
});

it("keeps play available after a rejected playback request", async () => {
  setupReview();
  await screen.findByRole("slider", { name: "Video timeline" });
  const video = document.querySelector("video");
  if (!video) throw new Error("Missing video element");
  vi.spyOn(video, "play").mockRejectedValue(new Error("NotAllowedError"));
  fireEvent.click(screen.getByRole("button", { name: "Play video" }));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Press play to try again",
  );
  expect(screen.getByRole("button", { name: "Play video" })).toBeVisible();
});

it("closes the speed menu with Escape without closing review", async () => {
  const { close } = setupReview();
  fireEvent.click(
    await screen.findByRole("button", { name: "Playback speed: 1x" }),
  );
  fireEvent.keyDown(screen.getByRole("menuitemradio", { name: "1.5x" }), {
    key: "Escape",
  });
  expect(screen.queryByRole("menu", { name: /^Playback speed:/ })).toBeNull();
  expect(close).not.toHaveBeenCalled();
});

it("keeps the focus loop out of the collapsing comments panel", async () => {
  setupReview();
  await screen.findByRole("slider", { name: "Video timeline" });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    new DOMRect(0, 0, 100, 20),
  ] as unknown as DOMRectList);
  fireEvent.click(screen.getByRole("button", { name: "Hide comments" }), {
    detail: 1,
  });
  const toggle = screen.getByRole("button", { name: "Show comments" });
  toggle.focus();
  fireEvent.keyDown(toggle, { key: "Tab", shiftKey: true });
  expect(
    screen.getByRole("button", { name: "Playback speed: 1x" }),
  ).toHaveFocus();
});

it("seeks ten seconds with arrow keys, updates the timeline, and omits gesture feedback", async () => {
  setupReview();
  const timeline = await screen.findByRole("slider", {
    name: "Video timeline",
  });
  const video = document.querySelector("video");
  if (!video) throw new Error("Missing video element");
  Object.defineProperty(video, "duration", { configurable: true, value: 100 });
  fireEvent.durationChange(video);
  const play = vi.spyOn(video, "play");
  const pause = vi.spyOn(video, "pause");
  const close = screen.getByRole("button", { name: "Close fullscreen viewer" });
  video.currentTime = 25;
  fireEvent.keyDown(close, { key: "ArrowRight" });
  expect(video.currentTime).toBe(35);
  expect(timeline).toHaveAttribute("aria-valuetext", "00:35 / 01:40");
  fireEvent.keyDown(close, { key: "ArrowRight", repeat: true });
  expect(video.currentTime).toBe(45);
  fireEvent.keyDown(close, { key: "ArrowLeft" });
  expect(video.currentTime).toBe(35);
  expect(document.querySelector("[data-video-feedback]")).toBeNull();
  expect(play).not.toHaveBeenCalled();
  expect(pause).not.toHaveBeenCalled();
  video.currentTime = 95;
  fireEvent.keyDown(close, { key: "ArrowRight" });
  expect(video.currentTime).toBe(100);
  video.currentTime = 5;
  fireEvent.keyDown(close, { key: "ArrowLeft" });
  expect(video.currentTime).toBe(0);
});

it("leaves editing, native sliders, speed menus, and modified arrow keys alone", async () => {
  setupReview(7, true);
  const timeline = await screen.findByRole("slider", {
    name: "Video timeline",
  });
  const video = document.querySelector("video");
  if (!video) throw new Error("Missing video element");
  video.currentTime = 25;
  fireEvent.click(screen.getByRole("button", { name: "Video volume" }));
  const composer = screen.getByRole("textbox", { name: "Reply to thread" });
  for (const target of [
    composer,
    timeline,
    screen.getByRole("slider", { name: "Video volume" }),
  ]) {
    expect(fireEvent.keyDown(target, { key: "ArrowRight" })).toBe(true);
    expect(video.currentTime).toBe(25);
  }
  const close = screen.getByRole("button", { name: "Close fullscreen viewer" });
  for (const modifier of [
    "altKey",
    "ctrlKey",
    "metaKey",
    "shiftKey",
    "isComposing",
  ]) {
    expect(
      fireEvent.keyDown(close, { key: "ArrowRight", [modifier]: true }),
    ).toBe(true);
    expect(video.currentTime).toBe(25);
  }
  fireEvent.click(screen.getByRole("button", { name: "Playback speed: 1x" }));
  const speedMenu = screen.getByRole("menu", { name: /^Playback speed:/ });
  expect(
    fireEvent.keyDown(
      within(speedMenu).getByRole("menuitemradio", { name: "2x" }),
      {
        key: "ArrowLeft",
      },
    ),
  ).toBe(true);
  expect(video.currentTime).toBe(25);
});

it("focuses the viewer on open and toggles playback once per Space press without an overlay", async () => {
  const { close } = setupReview();
  await screen.findByRole("slider", { name: "Video timeline" });
  const dialog = screen.getByRole("dialog", { name: "Video review" });
  expect(dialog).toHaveFocus();
  const video = document.querySelector("video");
  if (!video) throw new Error("Missing video element");
  let paused = true;
  Object.defineProperty(video, "paused", {
    configurable: true,
    get: () => paused,
  });
  const play = vi.spyOn(video, "play").mockImplementation(async () => {
    paused = false;
    fireEvent.play(video);
  });
  const pause = vi.spyOn(video, "pause").mockImplementation(() => {
    paused = true;
    fireEvent.pause(video);
  });
  expect(fireEvent.keyDown(dialog, { key: " " })).toBe(false);
  expect(play).toHaveBeenCalledOnce();
  expect(
    screen.getByRole("button", { name: "Pause video" }),
  ).toBeInTheDocument();
  expect(fireEvent.keyDown(dialog, { key: " ", repeat: true })).toBe(false);
  expect(pause).not.toHaveBeenCalled();
  fireEvent.keyUp(dialog, { key: " " });
  fireEvent.keyDown(dialog, { key: " " });
  expect(pause).toHaveBeenCalledOnce();
  expect(
    screen.getByRole("button", { name: "Play video" }),
  ).toBeInTheDocument();
  expect(close).not.toHaveBeenCalled();
  expect(document.querySelector("[data-video-feedback]")).toBeNull();
});

it("preserves Space in the composer and on focused controls", async () => {
  setupReview(7, true);
  await screen.findByRole("slider", { name: "Video timeline" });
  const video = document.querySelector("video");
  if (!video) throw new Error("Missing video element");
  const play = vi.spyOn(video, "play");
  const pause = vi.spyOn(video, "pause");
  fireEvent.click(screen.getByRole("button", { name: "Video volume" }));
  for (const target of [
    screen.getByRole("textbox", { name: "Reply to thread" }),
    screen.getByRole("button", { name: "Close fullscreen viewer" }),
    screen.getByRole("button", { name: "Play video" }),
    screen.getByRole("slider", { name: "Video volume" }),
  ]) {
    expect(fireEvent.keyDown(target, { key: " " })).toBe(true);
  }
  expect(play).not.toHaveBeenCalled();
  expect(pause).not.toHaveBeenCalled();
});
