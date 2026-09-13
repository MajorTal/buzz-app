import { expect, it } from "vitest";
import { isPresenceSnapshot } from "./presence-contract";
const author = "a".repeat(64);
const valid = { kinds: [20001], authors: [author], limit: 1 };
it("classifies only the exact finite, unique full-author presence snapshot", () => {
  expect(isPresenceSnapshot([valid])).toBe(true);
  const authors = Array.from({ length: 256 }, (_, i) =>
    i.toString(16).padStart(64, "0"),
  );
  expect(isPresenceSnapshot([{ kinds: [20001], authors, limit: 256 }])).toBe(
    true,
  );
  for (const value of [
    null,
    {},
    [],
    [valid, valid],
    [null],
    [[valid]],
    [{ ...valid, kinds: [20001, 9] }],
    [{ ...valid, kinds: [20001, 20001] }],
    [{ ...valid, authors: [] }],
    [{ ...valid, authors: [author, author], limit: 2 }],
    [{ ...valid, authors: ["a"] }],
    [{ ...valid, authors: [author.toUpperCase()] }],
    [{ ...valid, authors: Array(1) }],
    [{ ...valid, authors: [...authors, "f".repeat(64)], limit: 257 }],
    [{ ...valid, limit: 0 }],
    [{ ...valid, limit: 2 }],
    [{ ...valid, limit: "1" }],
    [{ ...valid, since: 0 }],
    [{ ...valid, since: undefined }],
    [Object.assign(Object.create(valid), { a: 1, b: 2, c: 3 })],
  ])
    expect(isPresenceSnapshot(value), JSON.stringify(value)).toBe(false);
});
