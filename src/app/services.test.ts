import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { createServices, type AppServices } from "./services";
import type { IdentityBackend } from "../features/identity/contracts";
const native = vi.hoisted(() => ({
  backend: undefined as IdentityBackend | undefined,
}));
vi.mock("../features/identity/native", () => ({
  createNativeIdentityBackend: () => native.backend,
}));

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
  native.backend = undefined;
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
    services.communities.capture(),
  );
  await vi.advanceTimersByTimeAsync(0);
  services.communities.joined(
    { id: "secondary", name: "Other" },
    { name: "Test", picture: "" },
    services.communities.capture(),
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
  expect(document.addEventListener).toHaveBeenCalledTimes(3);
  expect(document.removeEventListener).toHaveBeenCalledTimes(3);
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

it("composes one native identity and never connects its separate development-broker identity", async () => {
  await services.dispose();
  vi.mocked(fetch).mockClear();
  const status = {
    state: "ready",
    pubkey: "b".repeat(64),
    generation: "2",
    revocation: "00000000-0000-4000-8000-000000000001",
    busy: false,
    reason: null,
  };
  native.backend = {
    status: vi.fn(async () => status),
    unlockSaved: vi.fn(),
    importLegacy: vi.fn(),
    signOut: vi.fn(),
  };
  services = createServices();
  const owner = services.identity;
  await vi.advanceTimersByTimeAsync(0);
  expect(owner.snapshot().identity?.pubkey).toBe(status.pubkey);
  expect(native.backend.status).toHaveBeenCalledTimes(1);
  expect(services.identity).toBe(owner);
  expect(services.communities.snapshot().viewer).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
  await services.dispose();
  expect(owner.snapshot().identity).toBeNull();
  expect(native.backend.signOut).not.toHaveBeenCalled();
  // A fresh renderer reconnects without locking/changing the native authority.
  services = createServices();
  await vi.advanceTimersByTimeAsync(0);
  expect(services.identity).not.toBe(owner);
  expect(services.identity.snapshot().identity?.pubkey).toBe(status.pubkey);
  expect(native.backend.status).toHaveBeenCalledTimes(2);
});

it("a missing initial native reply cannot trigger broker fallback or retain disposed renderer state", async () => {
  await services.dispose();
  vi.mocked(fetch).mockClear();
  let respond!: (value: unknown) => void;
  native.backend = {
    status: vi.fn(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    ),
    unlockSaved: vi.fn(),
    importLegacy: vi.fn(),
    signOut: vi.fn(),
  };
  services = createServices();
  const owner = services.identity;
  await vi.advanceTimersByTimeAsync(2_001);
  expect(owner.snapshot().identity).toBeNull();
  expect(owner.snapshot().error).toBe("unavailable");
  expect(fetch).not.toHaveBeenCalled();
  await services.dispose();
  respond({
    state: "ready",
    pubkey: viewer,
    generation: "2",
    revocation: "00000000-0000-4000-8000-000000000001",
    busy: false,
    reason: null,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(owner.snapshot().identity).toBeNull();
  expect(native.backend.signOut).not.toHaveBeenCalled();
});
