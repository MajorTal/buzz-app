import { assert, afterEach, expect, it, vi } from "vitest";
import { createMediaPreparation, saveData, wasIntended } from "./media";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

class FakeImage {
  static created: FakeImage[] = [];
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 100;
  naturalHeight = 100;
  src = "";
  referrerPolicy = "";
  decode = vi.fn(async () => {});
  constructor() {
    FakeImage.created.push(this);
  }
}

function stubImages() {
  FakeImage.created = [];
  vi.stubGlobal("Image", FakeImage);
  return FakeImage.created;
}

const flushDecode = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

it("warms requests without retaining decoded bytes, and releases active image timers on dispose", async () => {
  vi.useFakeTimers();
  const created = stubImages();
  const media = createMediaPreparation();
  media.prepare(["a", "b", "c", "d"]);
  expect(media.stats()).toMatchObject({ active: 2, queued: 2 });
  const first = created[0];
  assert.exists(first);
  assert.exists(first.onload);
  first.onload();
  await flushDecode();
  expect(first.decode).toHaveBeenCalled();
  // The freed slot immediately promotes the next queued speculation.
  expect(media.stats()).toMatchObject({ active: 2, queued: 1, decoded: 1 });
  const second = created[1];
  assert.exists(second);
  second.naturalWidth = 21000;
  assert.exists(second.onload);
  second.onload();
  // Oversized originals are not explicitly decoded just to prepare an avatar.
  expect(second.decode).not.toHaveBeenCalled();
  media.dispose();
  expect(media.stats()).toEqual({
    active: 0,
    queued: 0,
    prefetched: 0,
    decoded: 1,
  });
  expect(vi.getTimerCount()).toBe(0);
});

it("skips urls already in flight", () => {
  stubImages();
  const media = createMediaPreparation();
  media.prepare(["a"]);
  media.prepare(["a", "a"]);
  expect(FakeImage.created).toHaveLength(1);
});

it("prefetch warming appends across channels instead of replacing the queue", () => {
  stubImages();
  const media = createMediaPreparation();
  media.prepare(["focus-1", "focus-2"]);
  // prepare() immediately activates two; a warm pass appends behind them.
  media.warm(["warm-1", "warm-2", "warm-3"]);
  expect(media.stats()).toMatchObject({ queued: 3, prefetched: 3 });
  // A focused prepare intent replaces queued speculation.
  media.prepare(["focus-3"]);
  expect(media.stats()).toMatchObject({ queued: 1, prefetched: 3 });
  expect(wasIntended("warm-1")).toBe(true);
});

it("Save-Data disables warming but nothing else", () => {
  stubImages();
  vi.stubGlobal("navigator", { connection: { saveData: true } });
  expect(saveData()).toBe(true);
  const media = createMediaPreparation();
  media.prepare(["a", "b"]);
  media.warm(["c"]);
  expect(media.stats()).toEqual({
    active: 0,
    queued: 0,
    prefetched: 0,
    decoded: 0,
  });
  expect(FakeImage.created).toHaveLength(0);

  vi.stubGlobal("navigator", { connection: { saveData: false } });
  media.prepare(["a"]);
  expect(FakeImage.created).toHaveLength(1);

  vi.stubGlobal("navigator", {});
  expect(saveData()).toBe(false);
});
