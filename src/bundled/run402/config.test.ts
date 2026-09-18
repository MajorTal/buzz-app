import { afterEach, expect, it, vi } from "vitest";
import { loadEmbeddingPolicy, originMatches } from "./config";

afterEach(() => vi.unstubAllGlobals());
const origin = "http://localhost:1430";
const signal = new AbortController().signal;
const config = (body: unknown, status = 200) =>
  vi.fn().mockResolvedValue(
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
    }),
  );

it("reads the host's runtime config without credentials", async () => {
  const fetch = config({
    project_id: "prj_1",
    embedding: { frame_ancestors: ["http://localhost:*"] },
  });
  vi.stubGlobal("fetch", fetch);
  const policy = await loadEmbeddingPolicy("my-app.run402.com", origin, signal);
  expect(fetch).toHaveBeenCalledWith(
    "https://my-app.run402.com/_run402/config.json",
    expect.objectContaining({ signal, credentials: "omit" }),
  );
  expect(policy).toEqual({ kind: "embeddable", projectId: "prj_1" });
});

it("is embeddable only when a declared ancestor covers the page origin", async () => {
  for (const [ancestors, kind] of [
    [["http://localhost:*", "http://127.0.0.1:*"], "embeddable"],
    [["http://127.0.0.1:*"], "not-embeddable"],
    [["https://localhost:*"], "not-embeddable"],
    [["http://localhost:1430"], "embeddable"],
    [["http://localhost:1431"], "not-embeddable"],
    [[], "not-embeddable"],
  ] as const) {
    vi.stubGlobal(
      "fetch",
      config({
        project_id: "prj_2",
        embedding: { frame_ancestors: ancestors },
      }),
    );
    expect(
      (await loadEmbeddingPolicy("my-app.run402.com", origin, signal)).kind,
      ancestors.join(" "),
    ).toBe(kind);
  }
});

it("treats a null policy as not embeddable and says which project it is", async () => {
  vi.stubGlobal("fetch", config({ project_id: "prj_3", embedding: null }));
  expect(await loadEmbeddingPolicy("plain.run402.com", origin, signal)).toEqual(
    { kind: "not-embeddable", projectId: "prj_3" },
  );
});

it("reports a host that is not a run402 project instead of failing", async () => {
  vi.stubGlobal("fetch", config(undefined, 404));
  expect(await loadEmbeddingPolicy("gone.run402.com", origin, signal)).toEqual({
    kind: "not-run402",
  });
  vi.stubGlobal("fetch", config({ hello: "world" }));
  expect(await loadEmbeddingPolicy("odd.run402.com", origin, signal)).toEqual({
    kind: "not-run402",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("<html>", { status: 200 })),
  );
  expect(await loadEmbeddingPolicy("html.run402.com", origin, signal)).toEqual({
    kind: "not-run402",
  });
});

it("rejects when the answer is unknown: server errors, network failures and timeouts", async () => {
  vi.stubGlobal("fetch", config(undefined, 503));
  await expect(
    loadEmbeddingPolicy("down.run402.com", origin, signal),
  ).rejects.toThrow("503");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
  await expect(
    loadEmbeddingPolicy("down.run402.com", origin, signal),
  ).rejects.toThrow("offline");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new DOMException("timed out", "TimeoutError")),
  );
  await expect(
    loadEmbeddingPolicy("slow.run402.com", origin, signal),
  ).rejects.toThrow("timed out");
});

it("matches CSP ancestor sources by scheme, host and exact or wildcard port", () => {
  for (const [pattern, page, expected] of [
    ["http://localhost:*", "http://localhost:1430", true],
    ["http://localhost:*", "http://localhost", true],
    ["http://127.0.0.1:*", "http://127.0.0.1:5173", true],
    ["http://localhost:1430", "http://localhost:1430", true],
    ["http://localhost:1430", "http://localhost:1431", false],
    ["http://localhost", "http://localhost:80", true],
    ["http://localhost", "http://localhost:1430", false],
    ["https://localhost:*", "http://localhost:1430", false],
    ["http://localhost:*", "http://localhost.evil.test:1430", false],
    ["http://*.localhost", "http://a.localhost", false],
    ["localhost:*", "http://localhost:1430", false],
    ["'self'", "http://localhost:1430", false],
    ["http://localhost:*", "not an origin", false],
  ] as const)
    expect(originMatches(pattern, page), `${pattern} vs ${page}`).toBe(
      expected,
    );
});
