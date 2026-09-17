import { assert, expect, it, vi } from "vitest";
import { createSidebarPreferencesStore } from "./sidebar-preferences-store";
import type {
  SidebarPreferences,
  SidebarSortMode,
} from "./sidebar-preferences";
import { flush } from "./testing";

type Sort = Readonly<Record<string, SidebarSortMode>>;
const data: SidebarPreferences = {
  sections: [{ id: "work", name: "Work", order: 0 }],
  assignments: { alpha: "work" },
  starred: ["beta"],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup() {
  const pending: ReturnType<typeof deferred<Sort>>[] = [];
  const read = vi.fn(async (): Promise<SidebarPreferences> => data);
  const write = vi.fn(async () => ({
    ...data,
    assignments: { alpha: "later" },
  }));
  const star = vi.fn(async () => ["alpha", "beta"]);
  const sort = vi.fn(() => {
    const job = deferred<Sort>();
    pending.push(job);
    return job.promise;
  });
  const owner = createSidebarPreferencesStore(read, true, write, star, sort);
  return { owner, preferences: owner.queries, pending, read, sort };
}

it("independent optimistic choices survive older success and failure in queue order", async () => {
  const { owner, preferences, pending, sort } = setup();
  try {
    await preferences.ensure();
    const first = preferences.setSort("channels", "recent", ["work"]);
    const firstFailed = expect(first).rejects.toThrow("offline");
    const second = preferences.setSort("section:work", "recent", ["work"]);
    expect(preferences.snapshot().data).toEqual({
      ...data,
      sort: { channels: "recent", "section:work": "recent" },
    });
    await flush();
    expect(sort).toHaveBeenCalledTimes(1);
    take(pending).reject(new Error("offline"));
    await firstFailed;
    await flush();
    expect(preferences.snapshot().data?.sort).toEqual({
      "section:work": "recent",
    });
    take(pending).resolve({ "section:work": "recent" });
    await second;
    expect(preferences.snapshot().data).toEqual({
      ...data,
      sort: { "section:work": "recent" },
    });
  } finally {
    owner.dispose();
  }
});

it("an older confirmation never overwrites a newer A–Z intent for the same section", async () => {
  const { owner, preferences, pending } = setup();
  try {
    await preferences.ensure();
    const first = preferences.setSort("channels", "recent", []);
    const second = preferences.setSort("channels", "alpha", []);
    expect(preferences.snapshot().data?.sort).toEqual({});
    await flush();
    take(pending).resolve({ channels: "recent" });
    await first;
    await flush();
    expect(preferences.snapshot().data?.sort).toEqual({});
    take(pending).resolve({});
    await second;
    expect(preferences.snapshot().data?.sort).toEqual({});
  } finally {
    owner.dispose();
  }
});

it("refresh during a pending intent updates unrelated data without hiding that intent", async () => {
  const { owner, preferences, pending, read } = setup();
  try {
    await preferences.ensure();
    const writing = preferences.setSort("channels", "recent", []);
    const failed = expect(writing).rejects.toThrow("offline");
    await flush();
    read.mockResolvedValueOnce({
      ...data,
      starred: ["alpha"],
      sort: { forums: "recent" },
    });
    await preferences.refresh();
    expect(preferences.snapshot().data).toEqual({
      ...data,
      starred: ["alpha"],
      sort: { channels: "recent", forums: "recent" },
    });
    take(pending).reject(new Error("offline"));
    await failed;
    expect(preferences.snapshot().data).toEqual({
      ...data,
      starred: ["alpha"],
      sort: { forums: "recent" },
    });
  } finally {
    owner.dispose();
  }
});

it("group and Star confirmations retain a queued optimistic sort and vice versa", async () => {
  const { owner, preferences, pending } = setup();
  try {
    await preferences.ensure();
    const assigning = preferences.assign("alpha", "later");
    const starring = preferences.setStar("alpha", true);
    const sorting = preferences.setSort("channels", "recent", ["work"]);
    await assigning;
    await starring;
    expect(preferences.snapshot().data).toEqual({
      ...data,
      assignments: { alpha: "later" },
      starred: ["alpha", "beta"],
      sort: { channels: "recent" },
    });
    await flush();
    take(pending).resolve({ channels: "recent" });
    await sorting;
    expect(preferences.snapshot().data).toEqual({
      ...data,
      assignments: { alpha: "later" },
      starred: ["alpha", "beta"],
      sort: { channels: "recent" },
    });
  } finally {
    owner.dispose();
  }
});

it.each(["clear", "dispose"] as const)(
  "%s aborts active sorting and prevents queued writes/late repopulation",
  async (action) => {
    const { owner, preferences, pending, sort } = setup();
    await preferences.ensure();
    const first = preferences.setSort("channels", "recent", []);
    const second = preferences.setSort("forums", "recent", []);
    const failed = [
      expect(first).rejects.toThrow("unavailable"),
      expect(second).rejects.toThrow("unavailable"),
    ];
    await flush();
    owner[action]();
    take(pending).resolve({ channels: "recent" });
    await Promise.all(failed);
    expect(sort).toHaveBeenCalledTimes(1);
    expect(
      (
        sort.mock.calls[0] as unknown as [string, string, string[], AbortSignal]
      )[3].aborted,
    ).toBe(true);
    expect(preferences.snapshot().data).toBeUndefined();
    owner.dispose();
  },
);

it("caller cancellation rolls back only its own intent and skips its queued publication", async () => {
  const { owner, preferences, pending, sort } = setup();
  try {
    await preferences.ensure();
    const first = preferences.setSort("channels", "recent", []);
    const controller = new AbortController();
    const second = preferences.setSort(
      "forums",
      "recent",
      [],
      controller.signal,
    );
    const failed = expect(second).rejects.toThrow();
    controller.abort();
    await flush();
    take(pending).resolve({ channels: "recent" });
    await first;
    await failed;
    expect(sort).toHaveBeenCalledTimes(1);
    expect(preferences.snapshot().data?.sort).toEqual({ channels: "recent" });
  } finally {
    owner.dispose();
  }
});

function take<T>(pending: T[]): T {
  const next = pending.shift();
  assert.exists(next, "Expected a pending operation");
  return next;
}
