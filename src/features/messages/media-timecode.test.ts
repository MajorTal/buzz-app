import { describe, expect, it } from "vitest";
import {
  formatMediaTime,
  mediaTimeReply,
  parseMediaTimeReply,
} from "./media-timecode";

describe("media time replies", () => {
  it("formats short and hour-long positions", () => {
    expect(formatMediaTime(42.9)).toBe("0:42");
    expect(formatMediaTime(3_725)).toBe("1:02:05");
  });

  it("round-trips a reply into a typed time anchor", () => {
    const content = mediaTimeReply(42.9, "The transition feels abrupt");
    expect(content).toBe("⏱ 0:42 — The transition feels abrupt");
    expect(parseMediaTimeReply(content)).toEqual({
      anchor: { type: "time", seconds: 42 },
      label: "0:42",
      content: "The transition feels abrupt",
    });
  });

  it("leaves ordinary messages alone", () => {
    expect(parseMediaTimeReply("Meet me at 0:42")).toBeUndefined();
  });
});

it("reads fractional bracketed timestamps without changing ordinary brackets", () => {
  expect(parseMediaTimeReply("[01:02.5] Nice cut")?.anchor.seconds).toBe(62.5);
  expect(parseMediaTimeReply("[1:02:03] A long clip")?.anchor.seconds).toBe(
    3723,
  );
  expect(parseMediaTimeReply("[00:99] Invalid")).toBeUndefined();
  expect(parseMediaTimeReply("[todo] Ordinary text")).toBeUndefined();
});

it.each([
  ["[00:42.5]", "00:42.5", 42.5, ""],
  ["[00:42]No space", "00:42", 42, "No space"],
  ["  [00:42]\n**New line**", "00:42", 42, "**New line**"],
  [" ⏱️ 0:42 — Note", "0:42", 42, "Note"],
])("reads compatible timecode %s", (input, label, seconds, content) => {
  expect(parseMediaTimeReply(input)).toEqual({
    anchor: { type: "time", seconds },
    label,
    content,
  });
});

it.each([
  "[00:42](https://example.com)",
  "[00:42][reference]",
  "[00:42]: https://example.com",
  "Comment at [00:42]",
  "[0:60:00] Invalid minutes",
  "⏱ 0:99 — Invalid seconds",
  "⏱ 0:60:00 — Invalid minutes",
])("leaves non-anchors and invalid times intact: %s", (input) => {
  expect(parseMediaTimeReply(input)).toBeUndefined();
});
