import { expect, it } from "vitest";
import { messagePreviewText } from "./message-preview-text";

it("ends the excerpt before blank lines, with an ellipsis beside the text", () => {
  expect(
    messagePreviewText("Watch at 2x if you must lol\n\n\nVideo details"),
  ).toBe("Watch at 2x if you must lol…");
  expect(messagePreviewText("First paragraph\r\n \t\r\nMore text")).toBe(
    "First paragraph…",
  );
});

it("preserves single line breaks and leaves visual wrapping to the four-line clamp", () => {
  const text = "First line\nSecond line";
  expect(messagePreviewText(text)).toBe(text);
  const longParagraph = "A long message. ".repeat(100).trim();
  expect(messagePreviewText(longParagraph)).toBe(longParagraph);
});

it("ignores surrounding blank lines without implying missing content", () => {
  expect(messagePreviewText("\n\nShort message\n \n")).toBe("Short message");
  expect(messagePreviewText("\r\n \t\n")).toBe("");
});
