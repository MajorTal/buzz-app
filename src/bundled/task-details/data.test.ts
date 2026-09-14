import { expect, it, vi } from "vitest";
import { parseTask, saveTask, taskKey } from "./data";

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
it("saves one record, detects intervening edits, and propagates storage failures", () => {
  let raw: string | null = null;
  const storage = {
    getItem: () => raw,
    setItem: vi.fn((_: string, value: string) => {
      raw = value;
    }),
  } as unknown as Storage;
  const saved = saveTask(storage, "task", null, task);
  expect(parseTask(saved)).toEqual(task);
  expect(storage.setItem).toHaveBeenCalledTimes(1);
  expect(() => saveTask(storage, "task", null, task)).toThrow("another window");
  expect(() =>
    saveTask(storage, "task", saved, { ...task, title: " " }),
  ).toThrow("title");
  vi.mocked(storage.setItem).mockImplementation(() => {
    throw new Error("Quota exceeded");
  });
  expect(() => saveTask(storage, "task", saved, task)).toThrow(
    "Quota exceeded",
  );
});
