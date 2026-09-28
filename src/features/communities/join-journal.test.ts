// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createJoinJournal } from "./join-journal";
import * as destinations from "./destination";

const viewer = "a".repeat(64);
const key = `buzz-community-joins.v1:${viewer}`;
const resolveDestination = destinations.communityDestination;
function restart(aliases: Record<string, string>) {
  vi.spyOn(destinations, "communityDestination").mockImplementation((value) =>
    resolveDestination(value, aliases),
  );
  return createJoinJournal(viewer);
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});
it("partitions pending joins by identity and community and fences replaced transactions", () => {
  const journal = createJoinJournal("a".repeat(64));
  const first = journal.begin("https://one.test", {
    name: "Saved",
    picture: "",
  });
  const other = journal.begin("https://two.test");
  const replacement = journal.begin("https://one.test/");
  expect(journal.current(first)).toBe(false);
  expect(journal.current(other)).toBe(true);
  journal.finish(first);
  expect(journal.current(replacement)).toBe(true);
  expect(journal.latest()?.profile?.name).toBe("Saved");
  expect(createJoinJournal("b".repeat(64)).latest()).toBeUndefined();
  journal.finish(replacement);
  expect(journal.latest()).toEqual(other);
});
it("preserves malformed recovery data instead of overwriting it before a new claim", () => {
  const key = `buzz-community-joins.v1:${"a".repeat(64)}`;
  localStorage.setItem(key, "corrupt");
  const journal = createJoinJournal("a".repeat(64));
  expect(() => journal.begin("https://one.test")).toThrow(
    "Could not read unfinished",
  );
  expect(localStorage.getItem(key)).toBe("corrupt");
});

it("recovers the same draft when an alias is added and removed across restarts", () => {
  const initial = restart({}).begin("wss://ONE.test:443/", {
    name: "Saved draft",
    picture: "",
  });
  const aliased = restart({ primary: "https://one.test" });
  expect(aliased.latest()).toEqual(initial);
  expect(aliased.get("primary")).toEqual(initial);
  expect(aliased.current(initial)).toBe(true);
  const replacement = aliased.begin("primary");
  expect(replacement.profile).toEqual(initial.profile);
  expect(aliased.current(initial)).toBe(false);
  aliased.finish(initial);

  const unaliased = restart({});
  expect(unaliased.latest()).toEqual(replacement);
  expect(unaliased.get("https://one.test")).toEqual(replacement);
  expect(unaliased.current(replacement)).toBe(true);
  unaliased.finish(replacement);
  expect(unaliased.latest()).toBeUndefined();
});

it("normalizes existing alias records to origins on the next journal write", () => {
  const legacy = {
    id: "legacy",
    community: "primary",
    profile: { name: "Legacy draft", picture: "" },
  };
  localStorage.setItem(key, JSON.stringify([legacy]));
  const configured = restart({ primary: "https://one.test" });
  expect(configured.get("primary")).toEqual({
    ...legacy,
    community: "https://one.test",
  });
  configured.begin("https://two.test");
  expect(restart({}).get("https://one.test")?.profile).toEqual(legacy.profile);
});

it("retains unresolved legacy aliases without blocking unrelated recovery or joins", () => {
  const known = restart({}).begin("https://two.test");
  const unresolved = {
    id: "unresolved",
    community: "old-alias",
    profile: { name: "Keep me", picture: "", about: "Unfinished" },
  };
  localStorage.setItem(key, JSON.stringify([known, unresolved]));
  const journal = restart({});
  expect(journal.latest()).toEqual(known);
  expect(journal.get("https://two.test")).toEqual(known);
  const other = journal.begin("https://three.test");
  journal.finish(known);
  journal.finish(other);
  expect(journal.latest()).toBeUndefined();
  expect(JSON.parse(localStorage.getItem(key) ?? "null")).toEqual([unresolved]);

  const restored = restart({ "old-alias": "https://one.test" });
  expect(restored.latest()).toEqual({
    ...unresolved,
    community: "https://one.test",
  });
  expect(restored.begin("https://one.test").profile).toEqual(
    unresolved.profile,
  );
});

it("keeps the newest draft when a restored alias resolves to an already pending origin", () => {
  localStorage.setItem(
    key,
    JSON.stringify([
      {
        id: "legacy",
        community: "old-alias",
        profile: { name: "Old draft", picture: "" },
      },
    ]),
  );
  const newer = restart({}).begin("https://one.test", {
    name: "New draft",
    picture: "",
  });
  const restored = restart({ "old-alias": "https://one.test" });
  expect(restored.latest()).toEqual(newer);
  expect(restored.get("old-alias")).toEqual(newer);
  expect(restored.get("https://one.test")).toEqual(newer);
  const retry = restored.begin("old-alias");
  expect(retry.profile).toEqual(newer.profile);
  expect(restored.current(newer)).toBe(false);
  restored.finish(retry);
  expect(restored.latest()).toBeUndefined();
  expect(JSON.parse(localStorage.getItem(key) ?? "null")).toEqual([]);
});

it("preserves recovery records when device storage cannot be read", () => {
  const journal = restart({});
  const entry = journal.begin("https://one.test", {
    name: "Keep me",
    picture: "",
  });
  const reads = vi
    .spyOn(Storage.prototype, "getItem")
    .mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
  expect(() => journal.begin("https://two.test")).toThrow(
    "Could not read unfinished",
  );
  reads.mockRestore();
  expect(journal.latest()).toEqual(entry);
});
