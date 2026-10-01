// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MediaAttachment } from "./MediaAttachment";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

const videoAttachment = {
  url: "https://fixture.test/video.mp4",
  kind: "video" as const,
};

function media(url: string) {
  return `media:${url}`;
}

function mockPlayback(element: HTMLVideoElement) {
  const play = vi.fn(() => {
    fireEvent.play(element);
    return Promise.resolve();
  });
  const pause = vi.fn(() => fireEvent.pause(element));
  Object.defineProperty(element, "play", { configurable: true, value: play });
  Object.defineProperty(element, "pause", { configurable: true, value: pause });
  return { play, pause };
}

it("tracks received video play, pause, time updates, and review handoff", () => {
  const onPlayback = vi.fn();
  const onOpenReview = vi.fn();
  const { container } = render(
    <MediaAttachment
      attachment={videoAttachment}
      media={media}
      onPlayback={onPlayback}
      onOpenReview={onOpenReview}
    />,
  );
  const video = container.querySelector("video");
  if (!video) throw new Error("Missing video element");
  const playback = mockPlayback(video);

  const preview = video.closest("div");
  expect(preview).not.toHaveAttribute("data-playing");

  fireEvent.click(screen.getByRole("button", { name: "Play video" }));
  expect(playback.play).toHaveBeenCalledTimes(1);
  expect(
    screen.getByRole("button", { name: "Pause video" }),
  ).toBeInTheDocument();
  expect(preview).toHaveAttribute("data-playing", "true");

  Object.defineProperty(video, "currentTime", {
    configurable: true,
    value: 42,
  });
  fireEvent.timeUpdate(video);
  expect(screen.getByText("00:42")).toBeInTheDocument();
  expect(onPlayback).toHaveBeenLastCalledWith({
    attachmentUrl: videoAttachment.url,
    seconds: 42,
  });

  fireEvent.click(
    screen.getByRole("button", { name: "Open video fullscreen" }),
  );
  expect(playback.pause).toHaveBeenCalledTimes(1);
  expect(onOpenReview).toHaveBeenCalledWith(videoAttachment, 42);

  fireEvent.pause(video);
  expect(
    screen.getByRole("button", { name: "Play video" }),
  ).toBeInTheDocument();
  expect(preview).not.toHaveAttribute("data-playing");
});

it("replays an explicit seek request for a received video", () => {
  const { container, rerender } = render(
    <MediaAttachment
      attachment={videoAttachment}
      media={media}
      seekTo={12}
      seekRequest={1}
    />,
  );
  const video = container.querySelector("video");
  if (!video) throw new Error("Missing video element");
  const playback = mockPlayback(video);

  fireEvent.loadedMetadata(video);
  expect(video.currentTime).toBe(12);
  expect(playback.play).toHaveBeenCalledTimes(1);

  video.currentTime = 3;
  rerender(
    <MediaAttachment
      attachment={videoAttachment}
      media={media}
      seekTo={12}
      seekRequest={2}
    />,
  );
  fireEvent.loadedMetadata(video);
  expect(video.currentTime).toBe(12);
  expect(playback.play).toHaveBeenCalledTimes(2);
});

it("shows unavailable treatment when received video playback errors", () => {
  const { container } = render(
    <MediaAttachment attachment={videoAttachment} media={media} />,
  );
  const video = container.querySelector("video");
  if (!video) throw new Error("Missing video element");

  fireEvent.error(video);

  expect(screen.getByRole("status")).toHaveTextContent("Video unavailable");
  expect(container.querySelector("video")).toBeNull();
});

it("offers inline seek, speed and volume controls and hands off the scrubbed position", () => {
  const onOpenReview = vi.fn();
  const { container } = render(
    <MediaAttachment
      attachment={videoAttachment}
      media={media}
      onOpenReview={onOpenReview}
    />,
  );
  const video = container.querySelector("video");
  if (!video) throw new Error("Missing video");
  mockPlayback(video);
  Object.defineProperty(video, "duration", { configurable: true, value: 90 });
  fireEvent.durationChange(video);
  fireEvent.change(screen.getByRole("slider", { name: "Video progress" }), {
    target: { value: "32" },
  });
  expect(video.currentTime).toBe(32);
  fireEvent.click(screen.getByRole("button", { name: "Playback speed: 1x" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "0.25x" }));
  expect(video.playbackRate).toBe(0.25);
  fireEvent.click(screen.getByRole("button", { name: "Video volume" }));
  expect(video.muted).toBe(false);
  expect(video.volume).toBe(1);
  fireEvent.change(screen.getByRole("slider", { name: "Video volume" }), {
    target: { value: "0.25" },
  });
  expect(video.volume).toBe(0.25);
  fireEvent.click(
    screen.getByRole("button", { name: "Open video fullscreen" }),
  );
  expect(onOpenReview).toHaveBeenCalledWith(videoAttachment, 32);
});

it("shares the saved playback speed with mounted previews and later videos", () => {
  localStorage.setItem("buzz.video.playback-speed", "1.25");
  const { container, rerender } = render(
    <>
      <MediaAttachment attachment={videoAttachment} media={media} />
      <MediaAttachment
        attachment={{
          ...videoAttachment,
          url: "https://fixture.test/second.mp4",
        }}
        media={media}
      />
    </>,
  );
  expect(
    screen.getAllByRole("button", { name: "Playback speed: 1.25x" }),
  ).toHaveLength(2);
  const firstSpeed = screen.getAllByRole("button", {
    name: "Playback speed: 1.25x",
  })[0];
  if (!firstSpeed) throw new Error("Missing speed control");
  fireEvent.click(firstSpeed);
  fireEvent.click(screen.getByRole("menuitemradio", { name: "1.75x" }));
  expect(
    [...container.querySelectorAll("video")].map((video) => video.playbackRate),
  ).toEqual([1.75, 1.75]);
  expect(
    screen.getAllByRole("button", { name: "Playback speed: 1.75x" }),
  ).toHaveLength(2);
  expect(localStorage.getItem("buzz.video.playback-speed")).toBe("1.75");
  rerender(
    <MediaAttachment key="new" attachment={videoAttachment} media={media} />,
  );
  expect(container.querySelector("video")?.playbackRate).toBe(1.75);
  expect(
    screen.getByRole("button", { name: "Playback speed: 1.75x" }),
  ).toBeInTheDocument();
});

it("uses normal speed when a saved preference is invalid", () => {
  localStorage.setItem("buzz.video.playback-speed", "NaN");
  const { container } = render(
    <MediaAttachment attachment={videoAttachment} media={media} />,
  );
  expect(container.querySelector("video")?.playbackRate).toBe(1);
});
