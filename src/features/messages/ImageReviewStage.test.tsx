// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Profiler, useState } from "react";
import userEvent from "@testing-library/user-event";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ImageReviewStage } from "./ImageReviewStage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function setup() {
  render(
    <ImageReviewStage
      attachments={[{ url: "https://fixture.test/photo.png", kind: "image" }]}
      selectedUrl="https://fixture.test/photo.png"
      media={(url) => url}
      select={() => {}}
      onOpenLink={() => false}
    />,
  );
  const image = screen.getByRole("img") as HTMLImageElement;
  const stage = image.parentElement;
  if (!stage) throw new Error("Missing stage");
  Object.defineProperties(image, {
    naturalWidth: { value: 1000 },
    naturalHeight: { value: 800 },
  });
  vi.spyOn(stage, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 500, 400),
  );
  return { stage, image };
}
function gesture(stage: HTMLElement, type: string, scale: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { scale, clientX: 250, clientY: 200 });
  fireEvent(stage, event);
  return event;
}
it("pinches around the cursor and pans with two-finger scroll within image bounds", () => {
  const { stage, image } = setup();
  expect(
    fireEvent.wheel(stage, {
      ctrlKey: true,
      deltaY: -Math.log(2) / 0.01,
      clientX: 300,
      clientY: 200,
    }),
  ).toBe(false);
  expect(
    screen.getByRole("button", { name: "Reset image zoom" }),
  ).toHaveTextContent("200%");
  expect(image.style.transform).toContain("translate(-50px, 0px)");
  fireEvent.wheel(stage, { deltaX: 60, deltaY: 40 });
  expect(image.style.transform).toContain("translate(-110px, -40px)");
  fireEvent.wheel(stage, { deltaX: 10000, deltaY: 10000 });
  expect(image.style.transform).toContain("translate(-250px, -200px)");
  fireEvent.click(screen.getByRole("button", { name: "Reset image zoom" }));
  expect(image.style.transform).toBe("none");
});
it("handles WebKit cumulative pinch scale without also applying wheel zoom", () => {
  const { stage, image } = setup();
  expect(gesture(stage, "gesturestart", 1).defaultPrevented).toBe(true);
  gesture(stage, "gesturechange", 2);
  fireEvent.wheel(stage, { ctrlKey: true, deltaY: -100 });
  expect(image.style.transform).toContain("scale(2)");
  gesture(stage, "gesturechange", 3);
  expect(image.style.transform).toContain("scale(3)");
  gesture(stage, "gesturechange", 8);
  expect(image.style.transform).toContain("scale(4)");
  gesture(stage, "gestureend", 8);
  fireEvent.wheel(stage, { ctrlKey: true, deltaY: Math.log(2) / 0.01 });
  expect(image.style.transform).toContain("scale(2)");
});
it("reclamps the image after resizing and leaves toolbar wheel input alone", () => {
  const { stage, image } = setup();
  fireEvent.change(screen.getByRole("slider", { name: "Image zoom" }), {
    target: { value: "2" },
  });
  fireEvent.wheel(stage, { deltaY: 1000 });
  vi.spyOn(stage, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 1000, 300),
  );
  fireEvent(window, new Event("resize"));
  expect(image.style.transform).toContain("translate(0px, -150px)");
  expect(
    fireEvent.wheel(screen.getByRole("slider", { name: "Image zoom" }), {
      deltaY: 100,
    }),
  ).toBe(true);
});
it("reveals idle controls on movement and clears its timer on unmount", () => {
  vi.useFakeTimers();
  const { stage } = setup();
  act(() => vi.advanceTimersByTime(2200));
  expect(stage).toHaveAttribute("data-controls-idle");
  fireEvent.pointerMove(stage);
  expect(stage).not.toHaveAttribute("data-controls-idle");
  fireEvent.pointerLeave(stage);
  expect(stage).toHaveAttribute("data-controls-idle");
  cleanup();
  expect(vi.getTimerCount()).toBe(0);
});

it("resets zoom for another image without replacing the toolbar", () => {
  const attachments = [
    { url: "https://fixture.test/one.png", kind: "image" as const },
    { url: "https://fixture.test/two.png", kind: "image" as const },
  ];
  const props = {
    attachments,
    media: (url: string) => url,
    select: () => {},
    onOpenLink: () => false,
  };
  const { rerender } = render(
    <ImageReviewStage {...props} selectedUrl="https://fixture.test/one.png" />,
  );
  const zoomIn = screen.getByRole("button", { name: "Zoom in" });
  fireEvent.click(zoomIn);
  zoomIn.focus();
  rerender(
    <ImageReviewStage {...props} selectedUrl="https://fixture.test/two.png" />,
  );
  expect(
    screen.getByRole("button", { name: "Reset image zoom" }),
  ).toHaveTextContent("100%");
  expect(screen.getByRole("button", { name: "Zoom in" })).toBe(zoomIn);
  expect(zoomIn).toHaveFocus();
});

it("loads the original animated image and releases the transform after resetting zoom", () => {
  const url = "https://fixture.test/animated.gif";
  render(
    <ImageReviewStage
      attachments={[
        { url, kind: "image", previewUrl: "https://fixture.test/still.png" },
      ]}
      selectedUrl={url}
      media={(source) => source}
      select={() => {}}
      onOpenLink={() => false}
    />,
  );
  const image = screen.getByRole("img");
  expect(image).toHaveAttribute("src", url);
  expect(image).toHaveStyle({ transform: "none" });
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  expect(image.style.transform).toContain("scale(1.25)");
  fireEvent.click(screen.getByRole("button", { name: "Reset image zoom" }));
  expect(screen.getByRole("img")).toBe(image);
  expect(image).toHaveStyle({ transform: "none" });
});

it("does not re-render the viewer for unchanged resize measurements", () => {
  const onRender = vi.fn();
  render(
    <Profiler id="image" onRender={onRender}>
      <ImageReviewStage
        attachments={[
          { url: "https://fixture.test/animated.gif", kind: "image" },
        ]}
        selectedUrl="https://fixture.test/animated.gif"
        media={(url) => url}
        select={() => {}}
        onOpenLink={() => false}
      />
    </Profiler>,
  );
  const commits = onRender.mock.calls.length;
  fireEvent(window, new Event("resize"));
  fireEvent(window, new Event("resize"));
  expect(onRender).toHaveBeenCalledTimes(commits);
});

function gallery() {
  const photos = ["one", "two", "three"].map((name) => ({
    url: `https://fixture.test/${name}.png`,
    kind: "image" as const,
  }));
  function Gallery() {
    const [selectedUrl, select] = useState(photos[0]?.url ?? "");
    return (
      <div role="dialog" aria-modal="true" aria-label="Image viewer">
        <button type="button">Close</button>
        <ImageReviewStage
          attachments={photos}
          selectedUrl={selectedUrl}
          select={select}
          media={(url) => url}
          onOpenLink={() => false}
        />
        <input aria-label="Comment" />
        <div
          contentEditable
          suppressContentEditableWarning
          data-testid="rich-comment"
        />
      </div>
    );
  }
  return render(<Gallery />);
}

it("navigates the gallery with buttons and left/right keys, resetting zoom and stopping at the ends", () => {
  gallery();
  expect(screen.getByRole("button", { name: "Previous image" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Next image" }));
  expect(screen.getByRole("img")).toHaveAttribute(
    "src",
    "https://fixture.test/two.png",
  );
  expect(screen.getByText("2 / 3")).toHaveAttribute("aria-live", "polite");
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  const close = screen.getByRole("button", { name: "Close" });
  close.focus();
  fireEvent.keyDown(close, { key: "ArrowRight" });
  expect(screen.getByRole("img")).toHaveAttribute(
    "src",
    "https://fixture.test/three.png",
  );
  expect(
    screen.getByRole("button", { name: "Reset image zoom" }),
  ).toHaveTextContent("100%");
  expect(screen.getByRole("button", { name: "Next image" })).toBeDisabled();
  fireEvent.keyDown(close, { key: "ArrowRight" });
  expect(screen.getByText("3 / 3")).toBeVisible();
  fireEvent.keyDown(close, { key: "ArrowLeft" });
  expect(screen.getByText("2 / 3")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Previous image" }));
  expect(screen.getByText("1 / 3")).toBeVisible();
});

it.each(["{Enter}", " "])(
  "keeps enabled gallery buttons focused for repeated %s activation and falls back at endpoints",
  async (key) => {
    const user = userEvent.setup();
    gallery();
    const next = screen.getByRole("button", { name: "Next image" });
    const previous = screen.getByRole("button", { name: "Previous image" });
    const stage = screen.getByRole("group", { name: "Image gallery" });
    next.focus();
    await user.keyboard(key);
    expect(screen.getByText("2 / 3")).toBeVisible();
    expect(next).toHaveFocus();
    await user.keyboard(key);
    expect(screen.getByText("3 / 3")).toBeVisible();
    expect(next).toBeDisabled();
    expect(stage).toHaveFocus();

    previous.focus();
    await user.keyboard(key);
    expect(screen.getByText("2 / 3")).toBeVisible();
    expect(previous).toHaveFocus();
    await user.keyboard(key);
    expect(screen.getByText("1 / 3")).toBeVisible();
    expect(previous).toBeDisabled();
    expect(stage).toHaveFocus();
  },
);

it("leaves arrow keys to the comment editor, zoom slider, modifiers, and other overlays", () => {
  gallery();
  for (const target of [
    screen.getByRole("textbox", { name: "Comment" }),
    screen.getByTestId("rich-comment"),
    screen.getByRole("slider", { name: "Image zoom" }),
  ]) {
    expect(fireEvent.keyDown(target, { key: "ArrowRight" })).toBe(true);
  }
  const close = screen.getByRole("button", { name: "Close" });
  expect(fireEvent.keyDown(close, { key: "ArrowRight", metaKey: true })).toBe(
    true,
  );
  render(<button type="button">Other overlay</button>);
  expect(
    fireEvent.keyDown(screen.getByRole("button", { name: "Other overlay" }), {
      key: "ArrowRight",
    }),
  ).toBe(true);
  expect(screen.getByText("1 / 3")).toBeVisible();
  fireEvent.keyDown(document.body, { key: "ArrowRight" });
  expect(screen.getByText("2 / 3")).toBeVisible();
});

it("slides the retained picture left for next and right for previous, waiting for the incoming image", () => {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
    false,
  );
  const animate = vi.fn(
    (_frames: Keyframe[], _options: KeyframeAnimationOptions) => ({
      cancel: vi.fn(),
      onfinish: null as (() => void) | null,
    }),
  );
  Object.defineProperty(HTMLElement.prototype, "animate", {
    value: animate,
    configurable: true,
  });
  try {
    gallery();
    const first = screen.getByRole("img");
    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    const second = screen.getByRole("img");
    expect(first).toBeInTheDocument();
    expect(first).toHaveAttribute("data-gallery-departing");
    expect(screen.getByRole("group", { name: "Image gallery" })).toHaveFocus();
    expect(second.parentElement).toHaveAttribute("data-gallery-loading");
    expect(animate).not.toHaveBeenCalled();
    fireEvent.load(second);
    expect(animate.mock.calls[0]?.[0][1]).toMatchObject({
      translate: "-40px 0px",
    });
    expect(animate.mock.calls[1]?.[0][0]).toMatchObject({
      translate: "40px 0px",
    });
    act(() => animate.mock.results[1]?.value.onfinish?.());
    expect(first).not.toBeInTheDocument();
    expect(second.parentElement).not.toHaveAttribute("data-gallery-loading");
    fireEvent.keyDown(screen.getByRole("group", { name: "Image gallery" }), {
      key: "ArrowLeft",
    });
    const returned = screen.getByRole("img");
    fireEvent.load(returned);
    expect(animate.mock.calls[2]?.[0][1]).toMatchObject({
      translate: "40px 0px",
    });
    expect(animate.mock.calls[3]?.[0][0]).toMatchObject({
      translate: "-40px 0px",
    });
    cleanup();
    expect(animate.mock.results[3]?.value.cancel).toHaveBeenCalled();
  } finally {
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
  }
});

it("keeps the last decoded image during rapid gallery changes and cancels pending motion on unmount", () => {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
    false,
  );
  const animate = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "animate", {
    value: animate,
    configurable: true,
  });
  try {
    const mounted = gallery();
    const first = screen.getByRole("img");
    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    expect(first).toBeInTheDocument();
    expect(document.querySelectorAll("[data-gallery-departing]")).toHaveLength(
      1,
    );
    const pending = screen.getByRole("img");
    expect(pending).toHaveAttribute("src", "https://fixture.test/three.png");
    mounted.unmount();
    fireEvent.load(pending);
    expect(animate).not.toHaveBeenCalled();
  } finally {
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
  }
});

it("changes gallery photos immediately when reduced motion is requested", () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true })),
  );
  const animate = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "animate", {
    value: animate,
    configurable: true,
  });
  try {
    gallery();
    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    expect(screen.getByRole("img")).toHaveAttribute(
      "src",
      "https://fixture.test/two.png",
    );
    expect(document.querySelector("[data-gallery-departing]")).toBeNull();
    expect(animate).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
  }
});
