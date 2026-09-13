import { afterEach, assert, expect, it, vi } from "vitest";
import { communityRequest, inspectProfile, publishProfile } from "./api";
import type { CommunityAccount } from "./service";
import { keypair, signed } from "../relay/testing";
const key = keypair();
function setup() {
  const controller = new AbortController();
  const account: CommunityAccount = {
    viewer: key.pubkey,
    epoch: 1,
    signal: controller.signal,
  };
  const signals: AbortSignal[] = [];
  const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
    if (options.signal) signals.push(options.signal);
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetcher);
  return { controller, account, fetcher, signals };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("rejects every broker operation before dispatch when its account is retired", async () => {
  const { account, controller, fetcher } = setup();
  controller.abort();
  await expect(
    communityRequest("https://one.example", "info", undefined, account),
  ).rejects.toThrow();
  await expect(
    inspectProfile("https://one.example", account),
  ).rejects.toThrow();
  await expect(
    publishProfile(
      "https://one.example",
      { name: "A", picture: "" },
      {},
      account,
    ),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it("cancels a pending mutation and rejects its late success without retrying", async () => {
  const { account, controller, fetcher } = setup();
  let release!: (response: Response) => void;
  fetcher.mockImplementationOnce(async (_url, init) => {
    assert.exists(init.signal);
    expect(init.signal.aborted).toBe(false);
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const operation = publishProfile(
    "https://one.example",
    { name: "A", picture: "" },
    {},
    account,
  );
  const signal = fetcher.mock.calls[0]?.[1].signal;
  controller.abort();
  expect(signal?.aborted).toBe(true);
  release(Response.json({ accepted: true, event_id: "1".repeat(64) }));
  await expect(operation).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("does not query a different viewer returned by the broker session", async () => {
  const { account, fetcher } = setup();
  fetcher
    .mockResolvedValueOnce(Response.json({}))
    .mockResolvedValueOnce(
      Response.json({ viewer: "b".repeat(64), relayAuthor: "c".repeat(64) }),
    );
  await expect(inspectProfile("https://one.example", account)).rejects.toThrow(
    "captured account",
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("binds profile registration/session/query to the same account and accepts verified absence", async () => {
  const { account, fetcher, signals, controller } = setup();
  fetcher
    .mockResolvedValueOnce(Response.json({}))
    .mockResolvedValueOnce(
      Response.json({ viewer: key.pubkey, relayAuthor: "c".repeat(64) }),
    )
    .mockResolvedValueOnce(Response.json([]));
  await expect(
    inspectProfile("https://one.example", account),
  ).resolves.toMatchObject({ exists: false });
  for (const [, init] of fetcher.mock.calls) {
    assert.exists(init.signal);
    signals.push(init.signal);
  }
  controller.abort();
  expect(signals.every((signal) => signal.aborted)).toBe(true);
});
it("preserves profile fields and never interprets malformed signed profile content as absence", async () => {
  const { account, fetcher } = setup();
  const mockSession = () =>
    fetcher
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(
        Response.json({ viewer: key.pubkey, relayAuthor: "c".repeat(64) }),
      );
  mockSession().mockResolvedValueOnce(
    Response.json([
      signed(key, {
        kind: 0,
        tags: [],
        content: JSON.stringify({ name: "Original", about: "keep" }),
      }),
    ]),
  );
  await expect(
    inspectProfile("https://one.example", account),
  ).resolves.toMatchObject({
    exists: true,
    existing: { about: "keep" },
    profile: { name: "Original" },
  });
  mockSession().mockResolvedValueOnce(
    Response.json([signed(key, { kind: 0, tags: [], content: "{" })]),
  );
  await expect(
    inspectProfile("https://one.example", account),
  ).rejects.toThrow();
});
