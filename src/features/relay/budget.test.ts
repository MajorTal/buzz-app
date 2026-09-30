import { expect, it } from "vitest";
import { byteSize, listByteSize } from "./budget";

it("sizes a list exactly as byteSize does, including after it changes", () => {
  const items = [
    { id: "a", content: "plain", tags: [["h", "channel"]] },
    { id: "b", content: 'quote " and \\ slash', tags: [] },
    { id: "c", content: "héllo 🐝 \n", tags: [["e", "a"]] },
  ];
  for (const count of [0, 1, 2, 3, 2, 3])
    expect(listByteSize(items.slice(0, count))).toBe(
      byteSize(items.slice(0, count)),
    );
  expect(listByteSize([...items].reverse())).toBe(
    byteSize([...items].reverse()),
  );
});
