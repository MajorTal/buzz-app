import { afterEach, expect, it, vi } from "vitest";
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

it("retains optional signing leases and optional clocks after the last stream closes", async () => {
  vi.useFakeTimers();
  const get = createHostAdmission();
  const owner = get("relay", "viewer");
  const release = owner.live.acquirePublication();
  for (let i = 0; i < 80; i++) get(`idle-${i}`, "viewer");
  expect(get("relay", "viewer")).toBe(owner);
  expect(() => owner.live.acquirePublication()).toThrow("capacity");
  owner.live.takePublish();
  release();
  release();
  get("next", "viewer");
  expect(get("relay", "viewer")).toBe(owner);
  await vi.advanceTimersByTimeAsync(5000);
  get("expired", "viewer");
  expect(get("relay", "viewer")).not.toBe(owner);
});
