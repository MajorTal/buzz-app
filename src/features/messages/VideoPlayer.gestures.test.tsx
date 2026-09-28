// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { StrictMode, useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { VideoPlayer } from "./VideoPlayer";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

function setup(paused = true) {
  function Player() {
    const video = useRef<HTMLVideoElement>(null);
    return (
      <VideoPlayer
        source="/clip.mp4"
        videoRef={video}
        onTime={() => {}}
        onError={() => {}}
      />
    );
  }
  const view = render(<Player />);
  const video = view.container.querySelector("video");
  if (!video) throw new Error("Missing video");
  Object.defineProperties(video, {
    paused: { configurable: true, get: () => paused },
    duration: { configurable: true, value: 100 },
  });
  vi.spyOn(video, "getBoundingClientRect").mockReturnValue({
    left: 0,
    width: 200,
  } as DOMRect);
  const play = vi.spyOn(video, "play").mockImplementation(async () => {
    paused = false;
  });
  const pause = vi.spyOn(video, "pause").mockImplementation(() => {
    paused = true;
  });
  vi.useFakeTimers();
  const down = (x = 150) =>
    fireEvent(
      video,
      Object.assign(new Event("pointerdown", { bubbles: true }), {
        button: 0,
        isPrimary: true,
        clientX: x,
      }),
    );
  return { ...view, video, play, pause, down };
}

it("toggles picture playback and leaves the separate play control immediate", () => {
  const { video, play, pause } = setup();
  fireEvent.click(video);
  expect(play).not.toHaveBeenCalled();
  expect(document.querySelector('[data-video-feedback="play"]')).not.toBeNull();
  act(() => vi.advanceTimersByTime(250));
  expect(play).toHaveBeenCalledOnce();
  expect(document.querySelector('[data-video-feedback="play"]')).not.toBeNull();
  act(() => vi.advanceTimersByTime(650));
  expect(document.querySelector("[data-video-feedback]")).toBeNull();
  fireEvent.click(video);
  expect(
    document.querySelector('[data-video-feedback="pause"]'),
  ).not.toBeNull();
  act(() => vi.advanceTimersByTime(250));
  expect(pause).toHaveBeenCalledOnce();
  expect(
    document.querySelector('[data-video-feedback="pause"]'),
  ).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Play video" }));
  expect(play).toHaveBeenCalledTimes(2);
});

it("double-clicks seek by ten seconds without toggling playback and clamp to duration", () => {
  const { video, play, pause } = setup();
  video.currentTime = 25;
  fireEvent.click(video);
  fireEvent.click(video, { detail: 2 });
  fireEvent.doubleClick(video, { clientX: 150 });
  act(() => vi.advanceTimersByTime(400));
  expect(video.currentTime).toBe(35);
  expect(
    document.querySelector('[data-video-feedback="forward"]')?.textContent,
  ).toBe("10");
  expect(play).not.toHaveBeenCalled();
  expect(pause).not.toHaveBeenCalled();
  fireEvent.doubleClick(video, { clientX: 50 });
  expect(video.currentTime).toBe(25);
  expect(
    document.querySelector('[data-video-feedback="backward"]')?.textContent,
  ).toBe("10");
  video.currentTime = 5;
  fireEvent.doubleClick(video, { clientX: 50 });
  expect(video.currentTime).toBe(0);
  video.currentTime = 95;
  fireEvent.doubleClick(video, { clientX: 150 });
  expect(video.currentTime).toBe(100);
});

it.each([true, false])(
  "holds the right side at 2x and restores previous state (paused=%s)",
  (paused) => {
    const { video, down, pause } = setup(paused);
    video.playbackRate = 1.5;
    localStorage.setItem("buzz.video.playback-speed", "1.5");
    down();
    act(() => vi.advanceTimersByTime(349));
    expect(video.playbackRate).toBe(1.5);
    act(() => vi.advanceTimersByTime(1));
    expect(video.playbackRate).toBe(2);
    expect(
      document.querySelector('[data-video-feedback="speed"]')?.textContent,
    ).toBe("2×");
    expect(video.paused).toBe(false);
    fireEvent.pointerUp(video);
    fireEvent.click(video);
    act(() => vi.advanceTimersByTime(400));
    expect(video.playbackRate).toBe(1.5);
    expect(document.querySelector("[data-video-feedback]")).toBeNull();
    expect(video.paused).toBe(paused);
    expect(pause).toHaveBeenCalledTimes(paused ? 1 : 0);
    expect(localStorage.getItem("buzz.video.playback-speed")).toBe("1.5");
  },
);

it("cancels pending and active holds on pointer exit, blur, and unmount", () => {
  const { video, down, play, unmount } = setup();
  down(50);
  act(() => vi.advanceTimersByTime(400));
  expect(play).not.toHaveBeenCalled();
  down();
  fireEvent.pointerLeave(video);
  act(() => vi.advanceTimersByTime(400));
  expect(play).not.toHaveBeenCalled();
  down();
  act(() => vi.advanceTimersByTime(350));
  fireEvent(window, new Event("blur"));
  expect(video.playbackRate).toBe(1);
  expect(video.paused).toBe(true);
  down();
  unmount();
  act(() => vi.advanceTimersByTime(400));
  expect(play).toHaveBeenCalledOnce();
});

it("preserves playback on a slower OS double-click", () => {
  const { video, down } = setup(false);
  down(50);
  fireEvent.pointerUp(video);
  fireEvent.click(video, { detail: 1 });
  act(() => vi.advanceTimersByTime(350));
  expect(video.paused).toBe(true);
  down(50);
  fireEvent.pointerUp(video);
  fireEvent.click(video, { detail: 2 });
  fireEvent.doubleClick(video, { clientX: 50 });
  expect(video.paused).toBe(false);
});

it("cancels a pending tap when beginning a hold", () => {
  const { video, down, play } = setup();
  fireEvent.click(video, { detail: 1 });
  act(() => vi.advanceTimersByTime(100));
  down();
  act(() => vi.advanceTimersByTime(250));
  expect(play).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(100));
  expect(video.playbackRate).toBe(2);
  fireEvent.pointerUp(video);
  expect(video.paused).toBe(true);
});

it("preserves autoplay during StrictMode replay but pauses the detached video", () => {
  const pause = vi
    .spyOn(HTMLMediaElement.prototype, "pause")
    .mockImplementation(() => {});
  function Player() {
    const video = useRef<HTMLVideoElement>(null);
    return (
      <VideoPlayer
        source="/clip.mp4"
        videoRef={video}
        onTime={() => {}}
        onError={() => {}}
      />
    );
  }
  const view = render(
    <StrictMode>
      <Player />
    </StrictMode>,
  );
  expect(pause).not.toHaveBeenCalled();
  view.unmount();
  expect(pause).toHaveBeenCalledOnce();
});
