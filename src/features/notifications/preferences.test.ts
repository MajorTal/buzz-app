import { expect, it } from "vitest";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  parsePreferences,
} from "./preferences";

const stored = {
  enabled: true,
  notifyWhileViewing: false,
  sound: true,
  categories: { mention: true, direct: true, thread: false },
};

it("values saved before per-category sounds restore with the defaults", () => {
  expect(parsePreferences(stored).sounds).toEqual(
    DEFAULT_NOTIFICATION_PREFERENCES.sounds,
  );
});

it("saved sound choices round-trip and unknown names reject the payload", () => {
  const sounds = { mention: "ping", direct: "unison", thread: "doop" };
  expect(
    parsePreferences(JSON.parse(JSON.stringify({ ...stored, sounds }))).sounds,
  ).toEqual(sounds);
  expect(() => parsePreferences({ ...stored, sounds: "ping" })).toThrow(
    "Invalid notification sounds",
  );
  expect(() =>
    parsePreferences({ ...stored, sounds: { mention: "klaxon" } }),
  ).toThrow("Invalid notification sounds");
});
