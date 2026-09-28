import { afterEach, expect, it, vi } from "vitest";
import {
  DEFAULT_CATEGORY_SOUNDS,
  RECOMMENDED_SOUND_BY_CATEGORY,
  SOUND_NAMES,
  isSoundName,
  playNotificationSound,
  resolveCategorySound,
} from "./sound";
import { NOTIFICATION_CATEGORIES } from "./preferences";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("every category has a default and a recommended sound from the bundled set", () => {
  for (const category of NOTIFICATION_CATEGORIES) {
    expect(isSoundName(DEFAULT_CATEGORY_SOUNDS[category])).toBe(true);
    expect(isSoundName(RECOMMENDED_SOUND_BY_CATEGORY[category])).toBe(true);
    expect(resolveCategorySound(DEFAULT_CATEGORY_SOUNDS, category)).toBe(
      "flutter",
    );
  }
  expect(isSoundName("klaxon")).toBe(false);
});

it("plugin categories resolve to the default sound", () => {
  const sounds = { ...DEFAULT_CATEGORY_SOUNDS, mention: "ping" } as const;
  expect(resolveCategorySound(sounds, "mention")).toBe("ping");
  expect(resolveCategorySound(sounds, "updates")).toBe("flutter");
});

it("playback without an Audio constructor reports null, never throws", () => {
  // Bare Node has no Audio global; delivery sound stays best-effort.
  expect(playNotificationSound("doong")).toBeNull();
});

it("playback restarts a cached bundled clip", () => {
  const instances: Array<{ src: string; currentTime: number; play: unknown }> =
    [];
  const play = vi.fn(async () => {});
  vi.stubGlobal(
    "Audio",
    class {
      currentTime = 5;
      play = play;
      constructor(public src: string) {
        instances.push(this);
      }
    },
  );
  const first = playNotificationSound("ping");
  expect(instances[0]?.src).toBe("/sounds/ping.mp3");
  expect(first).toBe(instances[0]);
  expect(first?.currentTime).toBe(0);
  playNotificationSound("ping");
  expect(instances).toHaveLength(1);
  expect(play).toHaveBeenCalledTimes(2);
  for (const name of SOUND_NAMES) playNotificationSound(name);
  // "ping" is already cached from above, so it stays first and is not recreated.
  expect(instances.map((audio) => audio.src)).toEqual(
    ["ping", ...SOUND_NAMES.filter((name) => name !== "ping")].map(
      (name) => `/sounds/${name}.mp3`,
    ),
  );
});
