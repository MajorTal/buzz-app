import { expect, it } from "vitest";
import { taskReference, taskReferences } from "./reference";

it("matches plain references with exact boundaries, including sentence punctuation", () => {
  const link = taskReference("channel-123", "a".repeat(64));
  const text = `Assigned to ${link}. Please start.`;
  const [match] = taskReferences(text);
  expect(match).toEqual({
    start: 12,
    end: 12 + link.length,
    channel: "channel-123",
    root: "a".repeat(64),
  });
  expect(taskReferences(`${link}a`)).toEqual([]);
  expect(taskReferences("https://example.test/task")).toEqual([]);
  expect(taskReferences(taskReference("", "a".repeat(64)))).toEqual([]);
});
