import { afterEach, expect, it, vi } from "vitest";
import { createFileStore } from "./file-store";

const response = (records: object) =>
  new Response(JSON.stringify(records), {
    headers: { "content-type": "application/json" },
  });
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function setup() {
  vi.useFakeTimers();
  vi.stubGlobal("localStorage", { getItem: () => "true" });
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
it("shares reads, retries a failed poll, and stops after the last subscriber", async () => {
  const fetcher = setup();
  fetcher
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(response({ a: { value: "task", revision: "1" } }));
  const store = createFileStore("scope");
  const stop = store.subscribe(vi.fn());
  const stopOther = store.subscribe(vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(store.snapshot().error).toContain("offline");
  await vi.advanceTimersByTimeAsync(6000);
  expect(store.snapshot().records?.a?.value).toBe("task");
  stop();
  stopOther();
  await vi.advanceTimersByTimeAsync(60000);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("ignores malformed legacy addresses without blocking valid migration", async () => {
  const fetcher = setup().mockImplementation(async () => response({}));
  vi.stubGlobal("localStorage", {
    "buzz.local-task.v1:broken": "bad",
    'buzz.local-task.v1:["scope","channel","root"]': "good",
    getItem: () => null,
    setItem: vi.fn(),
  });
  const store = createFileStore("scope");
  const stop = store.subscribe(vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  expect(JSON.parse(fetcher.mock.calls[0]?.[1].body).records).toEqual({
    'buzz.local-task.v1:["scope","channel","root"]': "good",
  });
  expect(store.snapshot().error).toBe("");
  stop();
});
it("does not let a stale poll overwrite a save", async () => {
  const fetcher = setup();
  let resolve!: (value: Response) => void;
  fetcher.mockReturnValueOnce(
    new Promise<Response>((done) => {
      resolve = done;
    }),
  );
  const store = createFileStore("scope");
  const stop = store.subscribe(vi.fn());
  fetcher.mockResolvedValueOnce(
    response({ a: { value: "new", revision: "2" } }),
  );
  await store.save("a", "new", "1");
  resolve(response({ a: { value: "old", revision: "1" } }));
  await vi.advanceTimersByTimeAsync(0);
  expect(store.snapshot().records?.a?.value).toBe("new");
  stop();
});
it("merges concurrent saves without restoring unrelated stale records", async () => {
  const fetcher = setup();
  const store = createFileStore("scope");
  let resolve!: (value: Response) => void;
  fetcher.mockReturnValueOnce(
    new Promise<Response>((done) => {
      resolve = done;
    }),
  );
  const first = store.save("a", "A", null);
  fetcher.mockResolvedValueOnce(
    response({
      a: { value: "A", revision: "1" },
      b: { value: "B", revision: "2" },
    }),
  );
  await store.save("b", "B", null);
  resolve(response({ a: { value: "A", revision: "1" } }));
  await first;
  expect(store.snapshot().records).toEqual({
    a: { value: "A", revision: "1" },
    b: { value: "B", revision: "2" },
  });
});
