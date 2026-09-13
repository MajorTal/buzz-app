import { afterEach, assert, expect, it, vi } from "vitest";
import {
  createBrokerCommunitySetup,
  communityRequest,
  inspectProfile,
  publishProfile,
} from "./api";
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

it("broker setup registers once before info and never continues after registration retirement", async () => {
  const { account, controller, fetcher } = setup();
  let release!: (value: Response) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const bound = createBrokerCommunitySetup("https://one.example", account);
  expect(fetcher).not.toHaveBeenCalled();
  const pending = bound.info();
  expect(fetcher.mock.calls[0]?.[0]).toBe("/api/relay/register");
  controller.abort();
  release(Response.json({}));
  await expect(pending).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("broker setup routes explicit policy and claim inputs to its captured destination", async () => {
  const { account, fetcher } = setup();
  const bound = createBrokerCommunitySetup("https://one.example", account);
  fetcher
    .mockResolvedValueOnce(Response.json({}))
    .mockResolvedValueOnce(Response.json({ name: "One", policy: null }));
  await expect(bound.info()).resolves.toEqual({ name: "One", policy: null });
  await bound.acceptPolicy({
    code: "i",
    policy_version: "v1",
    age_confirmed: true,
  });
  await bound.claim({ code: "i", policy_receipt: "r" });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    "/api/relay/register",
    "/api/relay/https%3A%2F%2Fone.example/info",
    "/api/relay/https%3A%2F%2Fone.example/accept-policy",
    "/api/relay/https%3A%2F%2Fone.example/claim",
  ]);
  expect(JSON.parse(fetcher.mock.calls[2]?.[1].body as string)).toEqual({
    code: "i",
    policy_version: "v1",
    age_confirmed: true,
  });
  expect(JSON.parse(fetcher.mock.calls[3]?.[1].body as string)).toEqual({
    code: "i",
    policy_receipt: "r",
  });
});
