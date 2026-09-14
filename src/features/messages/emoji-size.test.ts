import { expect, it } from "vitest";
import {
  isEmojiOnly,
  isUnicodeEmojiOnly,
  singleCustomEmoji,
  usesLargeEmojiPresentation,
} from "./emoji-size";

it("recognizes Unicode emoji sequences without enlarging ordinary prose", () => {
  for (const emoji of ["😀", " 👋🏽 ", "👨‍👩‍👧‍👦", "🇬🇧", "1️⃣"])
    expect(isUnicodeEmojiOnly(emoji)).toBe(true);
  for (const other of ["", "1", ":party:", "😀a", "😀 hello"])
    expect(isUnicodeEmojiOnly(other)).toBe(false);
});

it("recognizes custom emoji without treating shortcode prose as emoji", () => {
  const party = { shortcode: "party", url: "https://example.test/party.png" };
  expect(singleCustomEmoji(":PARTY: ", [party])).toBe(party);
  expect(singleCustomEmoji("hello :party:", [party])).toBeUndefined();
  expect(singleCustomEmoji(":missing:", [party])).toBeUndefined();
  expect(isEmojiOnly(":party: 😀 :PARTY:", [party])).toBe(true);
  expect(isEmojiOnly(":party: hello", [party])).toBe(false);
  expect(usesLargeEmojiPresentation(":party: 😀 :PARTY:", [party])).toBe(true);
  expect(
    usesLargeEmojiPresentation(":party: 😀 :PARTY: :party:", [party]),
  ).toBe(true);
});
