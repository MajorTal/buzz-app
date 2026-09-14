import { expect, it, vi } from "vitest";
import { followSavedCommunity } from "./follow";

const viewer = "ab".repeat(32);
const key = `buzz-client.v1:${viewer}`;

function host() {
  const store = new Map<string, string>();
  const listeners = new Set<(event: StorageEvent) => void>();
  return {
    addEventListener: (_: string, fn: EventListenerOrEventListenerObject) =>
      listeners.add(fn as (event: StorageEvent) => void),
    removeEventListener: (_: string, fn: EventListenerOrEventListenerObject) =>
      listeners.delete(fn as (event: StorageEvent) => void),
    localStorage: {
      getItem: (name: string) => store.get(name) ?? null,
    } as Storage,
    write(name: string, value: string | null) {
      if (value === null) store.delete(name);
      else store.set(name, value);
      for (const fn of listeners) fn({ key: name } as unknown as StorageEvent);
    },
    size: () => listeners.size,
  };
}

it("reports canonical saved selections for this viewer only", () => {
  const h = host();
  const onChange = vi.fn();
  const stop = followSavedCommunity(viewer, onChange, h);
  h.write(
    key,
    JSON.stringify({ selected: "wss://relay.example.com/", memberships: [] }),
  );
  h.write(key, JSON.stringify({ selected: null }));
  h.write("buzz-client.v1:other", JSON.stringify({ selected: "wss://x.test" }));
  h.write(key, "not json");
  h.write(key, JSON.stringify({ selected: 42 }));
  // Canonical ids are the relay's https origin, whatever scheme was saved.
  expect(onChange.mock.calls).toEqual([["https://relay.example.com"], [null]]);
  stop();
  h.write(key, JSON.stringify({ selected: null }));
  expect(onChange).toHaveBeenCalledTimes(2);
  expect(h.size()).toBe(0);
});
