import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { createServices, type AppServices } from "./services";

const plugin = vi.hoisted(() => ({
  cleanup: vi.fn<() => void | Promise<void>>(),
}));
// Only the installed plugin is a fixture. Exercise the real app composition,
// manager, runtime, Cordis root and community/relay services.
vi.mock("../bundled", () => ({
  bundledPlugins: [
    {
      manifest: { id: "test.page", name: "Test", apiVersion: 1 },
      module: {
        inject: ["pages"],
        apply(ctx: Context) {
          ctx.pages.register({
            id: "main",
            title: "Test",
            component: () => null,
          });
          ctx.effect(() => () => plugin.cleanup());
        },
      },
    },
  ],
}));

let services: AppServices;
let release: (() => void) | undefined;
const viewer = "a".repeat(64);
const signals: AbortSignal[] = [];
const streams: { url: string; close: ReturnType<typeof vi.fn> }[] = [];
let storageReads: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("VITE_BUZZ_LIVE", "1");
  plugin.cleanup.mockReset();
  const values = new Map<string, string>();
  storageReads = vi.fn((key: string) => values.get(key) ?? null);
  vi.stubGlobal("localStorage", {
    getItem: storageReads,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: RequestInit) => {
      if (options.signal) signals.push(options.signal);
      if (url.endsWith("/stream")) {
        const close = vi.fn();
        streams.push({ url, close });
        const body = new ReadableStream({
          start(controller) {
            options.signal?.addEventListener(
              "abort",
              () => {
                close();
                controller.error(new DOMException("Aborted", "AbortError"));
              },
              { once: true },
            );
          },
        });
        return new Response(body, {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      if (url.endsWith("/identity")) return Response.json({ viewer });
      if (url.endsWith("/register")) return Response.json({});
      if (url.endsWith("/session"))
        return Response.json({
          viewer,
          relayAuthor: "b".repeat(64),
          relayUrl: url.includes("/primary/")
            ? "https://primary.test"
            : "https://other.test",
          live: true,
        });
      // Pending reads deliberately ignore abort; shutdown must still abort their
      // signals and fence their continuations rather than wait for the transport.
      return new Promise<Response>(() => {});
    }),
  );
  services = createServices();
});
afterEach(async () => {
  release?.();
  release = undefined;
  await services.dispose().catch(() => {});
  streams.length = 0;
  signals.length = 0;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function openCommunities() {
  await vi.advanceTimersByTimeAsync(0);
  expect(services.pages.snapshot()).toHaveLength(1);
  services.communities.joined(
    { id: "primary", name: "Primary" },
    { name: "Test", picture: "" },
  );
  await vi.advanceTimersByTimeAsync(0);
  services.communities.joined(
    { id: "secondary", name: "Other" },
    { name: "Test", picture: "" },
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(services.relay.snapshot().status).toBe("ready");
  expect(streams).toHaveLength(2);
  expect(signals.length).toBeGreaterThanOrEqual(5);
  expect(signals.every((signal) => !signal.aborted)).toBe(true);
}
function expectHostStopped() {
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  for (const stream of streams) expect(stream.close).toHaveBeenCalledTimes(1);
  const added = vi.mocked(document.addEventListener).mock.calls;
  const removed = vi.mocked(document.removeEventListener).mock.calls;
  expect(added).toHaveLength(9); // Existing host listeners + one app presence source.
  expect(removed).toHaveLength(added.length);
  for (const [type, listener] of added)
    expect(
      removed.filter(
        ([event, callback]) => event === type && callback === listener,
      ),
    ).toHaveLength(1);
  expect(services.pages.snapshot()).toHaveLength(0);
}

it("disposes the real host services and plugins once", async () => {
  await openCommunities();
  const appearanceDisposal = vi.spyOn(services.appearance, "dispose");
  const disposal = services.dispose();
  expect(services.dispose()).toBe(disposal);
  await disposal;
  expectHostStopped();
  expect(appearanceDisposal).toHaveBeenCalled();
  expect(plugin.cleanup).toHaveBeenCalledTimes(1);
});

it("cancels every retained community while plugin cleanup hangs, then reports timeout", async () => {
  const cleanup = new Promise<void>((resolve) => {
    release = resolve;
  });
  plugin.cleanup.mockReturnValue(cleanup);
  await openCommunities();
  const reads = storageReads.mock.calls.length;
  let outcome: unknown = "pending";
  const disposal = services.dispose();
  void disposal.then(
    () => {
      outcome = "resolved";
    },
    (error) => {
      outcome = error;
    },
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(plugin.cleanup).toHaveBeenCalledTimes(1);
  expectHostStopped();
  expect(outcome).toBe("pending");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(outcome).toBeInstanceOf(Error);
  expect(String(outcome)).toContain("App cleanup timed out");
  expect(services.dispose()).toBe(disposal);
  release?.();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(storageReads).toHaveBeenCalledTimes(reads);
  expect(plugin.cleanup).toHaveBeenCalledTimes(1);
  expectHostStopped();
});

it("waits for genuine cleanup completion before reporting successful shutdown", async () => {
  const cleanup = new Promise<void>((resolve) => {
    release = resolve;
  });
  plugin.cleanup.mockReturnValue(cleanup);
  await openCommunities();
  let finished = false;
  const disposal = services.dispose().then(() => {
    finished = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expectHostStopped();
  expect(finished).toBe(false);
  release?.();
  await disposal;
  expect(finished).toBe(true);
});

it("still cancels the host and reports an unexpected manager-disposal failure", async () => {
  await openCommunities();
  const disposePlugins = services.plugins.dispose;
  vi.spyOn(services.plugins, "dispose").mockImplementation(async () => {
    await disposePlugins();
    throw new Error("Manager cleanup failed");
  });
  await expect(services.dispose()).rejects.toThrow("Manager cleanup failed");
  expectHostStopped();
});

it("joins cleanup already started by disabling a plugin", async () => {
  const cleanup = new Promise<void>((resolve) => {
    release = resolve;
  });
  plugin.cleanup.mockReturnValue(cleanup);
  await openCommunities();
  await services.plugins.change("disable", "test.page");
  await vi.advanceTimersByTimeAsync(0);
  expect(plugin.cleanup).toHaveBeenCalledTimes(1);
  let finished = false;
  const disposal = services.dispose().then(() => {
    finished = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expectHostStopped();
  expect(finished).toBe(false);
  release?.();
  await disposal;
  expect(finished).toBe(true);
  expect(plugin.cleanup).toHaveBeenCalledTimes(1);
});
