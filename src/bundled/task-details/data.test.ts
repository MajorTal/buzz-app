import { expect, it } from "vitest";
import { parseTask, taskKey } from "./data";

const task = {
  title: "Status sounds",
  description: "Move playback",
  assignee: "Sol",
  branches: [
    { id: "a", repository: "https://github.com/block/berd", branch: "sounds" },
  ],
};
it("partitions records by account/community scope, channel, and canonical root", () => {
  const keys = [
    taskKey("a", "c", "r"),
    taskKey("b", "c", "r"),
    taskKey("a", "d", "r"),
    taskKey("a", "c", "s"),
  ];
  expect(new Set(keys).size).toBe(4);
});
it("round trips task details and starts without a fabricated task", () => {
  expect(parseTask(null).title).toBe("");
  expect(parseTask(JSON.stringify(task))).toEqual(task);
});
it("refuses malformed or oversized records", () => {
  for (const raw of [
    "{",
    "null",
    "{}",
    JSON.stringify({ ...task, branches: [null] }),
    JSON.stringify({ ...task, title: "x".repeat(16001) }),
  ])
    expect(() => parseTask(raw)).toThrow();
});
