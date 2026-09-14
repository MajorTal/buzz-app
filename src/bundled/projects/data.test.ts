import { expect, it } from "vitest";
import { isProject, markProject } from "./data";
import { channelTasks, saveTask, taskKey } from "../task-details/data";

it("marks only the selected channel and account/community and reads its real task records", () => {
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  } as Storage;
  markProject(storage, "account/community", "voice");
  expect(isProject(storage, "account/community", "voice")).toBe(true);
  expect(isProject(storage, "another/community", "voice")).toBe(false);
  expect(isProject(storage, "account/community", "other")).toBe(false);
  const task = {
    title: "Silent hangup",
    description: "",
    assignee: "",
    branches: [],
  };
  saveTask(storage, taskKey("account/community", "voice", "root"), null, task);
  expect(channelTasks(storage, "account/community", "voice")).toEqual([
    { root: "root", task },
  ]);
  expect(channelTasks(storage, "another/community", "voice")).toEqual([]);
  expect(channelTasks(storage, "account/community", "other")).toEqual([]);
  storage.setItem(taskKey("account/community", "voice", "broken"), "{");
  expect(() => channelTasks(storage, "account/community", "voice")).toThrow();
});

it("propagates storage failures rather than reporting a saved project", () => {
  const storage = {
    setItem: () => {
      throw new Error("Storage denied");
    },
  } as unknown as Storage;
  expect(() => markProject(storage, "scope", "channel")).toThrow(
    "Storage denied",
  );
});
