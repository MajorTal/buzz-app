import assert from "node:assert/strict";
import { test } from "vitest";

import {
  formatDurationSeconds,
  parseDurationSeconds,
} from "./workflowDuration.ts";

test("parseDurationSeconds accepts compact and combined whole-second durations", () => {
  assert.equal(parseDurationSeconds("5s"), 5);
  assert.equal(parseDurationSeconds("90m"), 5_400);
  assert.equal(parseDurationSeconds("1h 2s"), 3_602);
  assert.equal(parseDurationSeconds("1H2M3S"), 3_723);
  assert.equal(parseDurationSeconds("2d"), 172_800);
  assert.equal(parseDurationSeconds("2w 3d 4h 5m 6s"), 1_483_506);
  assert.equal(parseDurationSeconds("42"), 42);
  assert.equal(parseDurationSeconds("0s"), 0);
});

test("parseDurationSeconds rejects empty, malformed, and fractional values", () => {
  assert.equal(parseDurationSeconds(""), null);
  assert.equal(parseDurationSeconds("1.5m"), null);
  assert.equal(parseDurationSeconds("1m later"), null);
});

test("formatDurationSeconds produces compact labels with significant units", () => {
  assert.equal(formatDurationSeconds(0), "0s");
  assert.equal(formatDurationSeconds(5), "5s");
  assert.equal(formatDurationSeconds(62), "1m 2s");
  assert.equal(formatDurationSeconds(3_602), "1h 2s");
  assert.equal(formatDurationSeconds(7_323), "2h 2m 3s");
  assert.equal(formatDurationSeconds(172_800), "2d");
  assert.equal(formatDurationSeconds(1_483_506), "2w 3d 4h 5m 6s");
});
