import { afterEach, expect, it, vi } from "vitest";
import {
  apiFailure,
  admittedApiRequest,
  ApiPaused,
  createApiAdmission,
  readApiFailure,
} from "./http-admission";

afterEach(() => vi.useRealTimers());
it("paces real starts, prioritizes foreground and never accumulates idle credits", async () => {
  vi.useFakeTimers();
  const lane = createApiAdmission();
  const calls: string[] = [];
  const work = (name: string) => async () => {
    calls.push(name);
  };
  const a = lane.run(work("first"));
  const b = lane.run(work("background"), undefined, "background");
  const c = lane.run(work("send"));
  await a;
  expect(calls).toEqual(["first"]);
  await vi.advanceTimersByTimeAsync(500);
  await c;
  expect(calls).toEqual(["first", "send"]);
  await vi.advanceTimersByTimeAsync(500);
  await b;
  await vi.advanceTimersByTimeAsync(60000);
  const d = lane.run(work("after idle"));
  const e = lane.run(work("next"));
  await d;
  expect(calls.at(-1)).toBe("after idle");
  await vi.advanceTimersByTimeAsync(499);
  expect(calls.at(-1)).toBe("after idle");
  await vi.advanceTimersByTimeAsync(1);
  await e;
  expect(vi.getTimerCount()).toBe(0);
});
it("pauses all queued consumers explicitly, honors cancellation, and never retries an admitted operation", async () => {
  vi.useFakeTimers();
  const lane = createApiAdmission();
  let release!: () => void;
  const work = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const first = lane.run(work);
  await Promise.resolve();
  const queued = lane.run(work);
  const refused = expect(queued).rejects.toBeInstanceOf(ApiPaused);
  lane.pause(3000);
  await refused;
  await expect(lane.run(work)).rejects.toBeInstanceOf(ApiPaused);
  release();
  await first;
  await vi.advanceTimersByTimeAsync(3000);
  const controller = new AbortController();
  const once = lane.run(async () => {});
  const cancelled = lane.run(work, controller.signal);
  const rejects = expect(cancelled).rejects.toMatchObject({
    name: "AbortError",
  });
  controller.abort();
  await rejects;
  await once;
  expect(work).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it("normalizes only upstream quota hints and bounds streaming error bodies", async () => {
  expect(
    apiFailure(429, { error: "rate-limited: quota exceeded; retry in 2s" }),
  ).toMatchObject({ quota: "api", retryAfterMs: 3000 });
  for (const value of [
    "Query concurrency limit",
    "Live stream capacity reached",
    "unexpected",
  ])
    expect(apiFailure(429, { error: value }).quota).toBeUndefined();
  expect(
    apiFailure(503, { error: "rate-limited: quota exceeded; retry in 2s" })
      .quota,
  ).toBeUndefined();
  const failure = await readApiFailure(
    Response.json(
      { error: "rate-limited: quota exceeded; retry in 0s" },
      { status: 429 },
    ),
  );
  expect(failure.retryAfterMs).toBe(1000);
  const cancel = vi.fn();
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(4097));
    },
    cancel,
  });
  expect(
    (await readApiFailure(new Response(body, { status: 429 }))).quota,
  ).toBeUndefined();
  expect(cancel).toHaveBeenCalledTimes(1);
});

it("the fetch boundary preserves normalized quota hints and blocks later work without resending", async () => {
  vi.useFakeTimers();
  const lane = createApiAdmission();
  const upstream = vi.fn(async () =>
    Response.json(
      { error: "rate-limited: quota exceeded; retry in 2s" },
      { status: 429 },
    ),
  );
  const response = await admittedApiRequest(lane, upstream);
  expect(response.status).toBe(429);
  expect(await response.json()).toMatchObject({
    quota: "api",
    retryAfterMs: 3000,
  });
  await expect(admittedApiRequest(lane, upstream)).rejects.toBeInstanceOf(
    ApiPaused,
  );
  expect(upstream).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(3000);
  const result = await admittedApiRequest(lane, async () => new Response("[]"));
  expect(result.ok).toBe(true);
});

it.each([
  ["rate-limited: quota exceeded", 61000],
  ["rate-limited: quota exceeded; retry in invalid", 61000],
  ["rate-limited: quota exceeded; retry in 61s", 62000],
  ["rate-limited: quota exceeded; retry in 9007199254740992s", 86401000],
])(
  "known quota with unsupported/long hint cannot drain the queue: %s",
  async (error, retryAfterMs) => {
    vi.useFakeTimers();
    const lane = createApiAdmission();
    const fetcher = vi.fn(async () =>
      Response.json({ error }, { status: 429 }),
    );
    const response = await admittedApiRequest(lane, fetcher);
    expect(await response.json()).toMatchObject({ quota: "api", retryAfterMs });
    await expect(admittedApiRequest(lane, fetcher)).rejects.toBeInstanceOf(
      ApiPaused,
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
it("a partial quota body retains its host owner until normalization installs cooldown", async () => {
  vi.useFakeTimers();
  const lane = createApiAdmission();
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const response = admittedApiRequest(
    lane,
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            body = c;
          },
        }),
        { status: 429 },
      ),
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(lane.idle()).toBe(false);
  body.enqueue(
    new TextEncoder().encode(
      JSON.stringify({ error: "rate-limited: quota exceeded; retry in 2s" }),
    ),
  );
  body.close();
  await response;
  expect(lane.idle()).toBe(false);
  await vi.advanceTimersByTimeAsync(3000);
  expect(lane.idle()).toBe(true);
});

it("optional starts neither consume nor reset ordinary pacing; both lanes retain shared cooldown", async () => {
  vi.useFakeTimers();
  const lane = createApiAdmission();
  const starts: [string, number][] = [];
  const run = (name: string, priority: "foreground" | "presence") =>
    lane.run(
      async () => {
        starts.push([name, performance.now()]);
      },
      undefined,
      priority,
    );
  await run("ordinary-1", "foreground");
  await vi.advanceTimersByTimeAsync(100);
  await run("presence-1", "presence");
  const ordinary = run("ordinary-2", "foreground");
  const presence = run("presence-2", "presence");
  await vi.advanceTimersByTimeAsync(400);
  await ordinary;
  expect(starts).toEqual([
    ["ordinary-1", 0],
    ["presence-1", 100],
    ["ordinary-2", 500],
  ]);
  const rejected = expect(presence).rejects.toBeInstanceOf(ApiPaused);
  lane.pause(4000);
  await rejected;
  await expect(run("blocked ordinary", "foreground")).rejects.toBeInstanceOf(
    ApiPaused,
  );
  await expect(run("blocked presence", "presence")).rejects.toBeInstanceOf(
    ApiPaused,
  );
  await vi.advanceTimersByTimeAsync(4000);
  await run("ordinary-3", "foreground");
  const resumed = run("presence-3", "presence");
  await vi.advanceTimersByTimeAsync(600);
  await resumed;
  expect(starts.slice(-2)).toEqual([
    ["ordinary-3", 4500],
    ["presence-3", 5100],
  ]);
});
