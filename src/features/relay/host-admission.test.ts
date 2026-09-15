import { assert, afterEach, expect, it, vi } from "vitest";
import { createHostAdmission } from "./host-admission";
afterEach(() => vi.useRealTimers());
it("owner retention is bounded without evicting active streams or cooldown, with independent quota families", async () => {
  vi.useFakeTimers();
  const get = createHostAdmission();
  const first = get("relay", "viewer");
  first.streams++;
  first.live.pause(60);
  await first.api.run(async () => {}); // WS cooldown never blocks API calls.
  for (let i = 0; i < 63; i++) get(`relay-${i}`, "viewer").api.pause(1000);
  expect(() => get("overflow", "viewer")).toThrow("capacity");
  expect(get("relay", "viewer")).toBe(first);
  first.streams--;
  await vi.advanceTimersByTimeAsync(1100);
  get("reclaimed", "viewer");
  expect(get("relay", "viewer")).toBe(first); // Unexpired cooldown survives no owners.
  expect(first.live.delay()).toBeGreaterThan(59000);
  await vi.advanceTimersByTimeAsync(61000);
  get("next", "viewer");
  expect(get("relay", "viewer")).not.toBe(first);
});

it("asynchronous preparation pins its principal until dispatch ownership is released", async () => {
  const get = createHostAdmission();
  const owner = get("relay", "viewer");
  let release!: () => void;
  const preparing = owner.api.prepare(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  for (let i = 0; i < 80; i++) get(`idle-${i}`, "viewer");
  expect(get("relay", "viewer")).toBe(owner);
  expect(owner.api.idle()).toBe(false);
  release();
  await preparing;
  expect(owner.api.idle()).toBe(true);
});

it("optional flights and start gates survive eviction without consuming ordinary admission", async () => {
  vi.useFakeTimers();
  const get = createHostAdmission(),
    owner = get("relay", "viewer");
  const http = owner.api.tryPresence(),
    ws = owner.live.tryPresence();
  expect(http).toBeTypeOf("function");
  expect(ws).toBeTypeOf("function");
  owner.live.presenceSent();
  expect(owner.api.tryPresence()).toBeUndefined();
  expect(owner.live.tryPresence()).toBeUndefined();
  const ordinary = vi.fn(async () => {});
  await owner.api.run(ordinary);
  expect(ordinary).toHaveBeenCalledOnce();
  expect(owner.live.delay()).toBe(0);
  for (let i = 0; i < 80; i++) get(`other-${i}`, "viewer");
  expect(get("relay", "viewer")).toBe(owner);
  assert.exists(http);
  assert.exists(ws);
  http();
  ws();
  await vi.advanceTimersByTimeAsync(4999);
  get("another", "viewer");
  expect(get("relay", "viewer")).toBe(owner);
  await vi.advanceTimersByTimeAsync(1);
  get("evict", "viewer");
  expect(get("relay", "viewer")).not.toBe(owner);
});
