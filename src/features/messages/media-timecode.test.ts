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
