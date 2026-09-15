import { expect, it } from "vitest";
import { relativeTimestamp } from "./relative-timestamp";

const now = new Date(2026, 8, 13, 12).getTime() / 1000;
it.each([
  [-60, "just now"],
  [59, "just now"],
  [60, "1 minute ago"],
  [3599, "59 minutes ago"],
  [3600, "1 hour ago"],
  [86399, "23 hours ago"],
  [86400, "1 day ago"],
  [604799, "6 days ago"],
  [604800, "on Sep 6"],
] as const)("matches Buzz's recency boundary at %s seconds", (age, label) => {
  expect(relativeTimestamp(now - age, now)).toBe(label);
});
