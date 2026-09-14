import { expect, it } from "vitest";
import { continuesMessage, startsMessageDay } from "./message-grouping";

const row = (authorId: string, createdAt: number) => ({ authorId, createdAt });
const noon = new Date(2026, 8, 11, 12).getTime() / 1000;

it("groups only adjacent same-author messages within ten minutes in timestamp order", () => {
  const first = row("alice", noon);
  expect(continuesMessage(undefined, first)).toBe(false);
  expect(continuesMessage(first, undefined)).toBe(false);
  expect(continuesMessage(first, row("alice", noon))).toBe(true);
  expect(continuesMessage(first, row("alice", noon + 600))).toBe(true);
  expect(continuesMessage(first, row("alice", noon + 601))).toBe(false);
  expect(continuesMessage(first, row("alice", noon - 1))).toBe(false);
  expect(continuesMessage(first, row("bob", noon + 1))).toBe(false);
});

it("starts a fresh group across local midnight even within the time window", () => {
  const midnight = new Date(2026, 8, 12).getTime() / 1000;
  const first = row("alice", midnight - 1),
    next = row("alice", midnight);
  expect(startsMessageDay(undefined, first)).toBe(true);
  expect(startsMessageDay(first, next)).toBe(true);
  expect(continuesMessage(first, next)).toBe(false);
});

it("breaks message groups at membership activity even from the same author", () => {
  const first = row("alice", noon);
  const activity = {
    ...row("alice", noon + 1),
    membership: {
      type: "member_joined" as const,
      actor: "alice",
      target: "alice",
    },
  };
  expect(continuesMessage(first, activity)).toBe(false);
  expect(continuesMessage(activity, row("alice", noon + 2))).toBe(false);
});
