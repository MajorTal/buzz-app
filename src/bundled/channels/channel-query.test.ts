import { expect, it } from "vitest";
import { channelQuery } from "./channel-query";

it.each([
  "#",
  "#wes-crew",
  "Hello #WE",
  "(#we",
  "[#we",
  "line\n#we",
  "#日本語",
])("matches a prose trigger: %s", (text) => {
  const start = text.lastIndexOf("#");
  expect(channelQuery(text, text.length)).toEqual({
    start,
    end: text.length,
    query: text.slice(start + 1),
  });
});
it.each([
  "ordinary typing",
  "word#we",
  "https://example.test/#we",
  "\\#we",
  "##we",
  "#we ",
  "#we#other",
  "#we`",
  `word${"x".repeat(160)}#we`,
])("rejects a non-trigger: %s", (text) => {
  expect(channelQuery(text, text.length)).toBeNull();
});
it("uses the caret, rejects invalid offsets, and bounds the query", () => {
  expect(channelQuery("#we later", 3)).toEqual({
    start: 0,
    end: 3,
    query: "we",
  });
  for (const caret of [-1, 1.5, 100, Number.NaN])
    expect(channelQuery("#we", caret)).toBeNull();
  const text = `#${"a".repeat(160)}`;
  expect(channelQuery(text, text.length)).toBeNull();
});
