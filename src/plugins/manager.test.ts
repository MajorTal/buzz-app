import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import * as React from "react";
import { createPluginManager, type PluginManager } from "./manager";
import { PagesService } from "../features/pages/service";
import type { PluginStorage } from "./storage";
import type { StorageResult } from "./types";

const ready = (enabled = true, paused = false): StorageResult => ({
  status: "ready",
  externalPluginsPaused: paused,
  catalog: {
    profile: "test",
    location: "test",
    plugins: [
      {
        manifest: { id: "example", name: "Example", apiVersion: 1 },
        source: paused ? "external" : "bundled",
        enabled,
        revision: "one",
        previous: null,
        reloadable: paused,
        error: null,
      },
    ],
  },
});
const managers: PluginManager[] = [];
const roots: Context[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  await Promise.all(roots.splice(0).map((root) => root.fiber.dispose()));
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function harness(overrides: Partial<PluginStorage> = {}, fail = false) {
  const installation: PluginStorage = {
    getCatalog: vi.fn(async () => ready()),
    changePlugin: vi.fn(async () => ready(false)),
    recoverSettings: vi.fn(async () => ready()),
    readModule: vi.fn(async () => ""),
    reloadPlugin: vi.fn(async () => ready(false)),
    ...overrides,
  };
  const root = new Context();
  roots.push(root);
  const plugins = createPluginManager(root, {
    storage: installation,
    bundled: [
      {
        manifest: { id: "example", name: "Example", apiVersion: 1 },
        module: {
          inject: ["pages"],
          apply(ctx) {
            if (fail) throw new Error("Activation failed");
            ctx.pages.register({
              id: "main",
              title: "Main",
              component: () => null,
            });
          },
        },
      },
    ],
  });
  const pages = new PagesService(root);
  managers.push(plugins);
  return { plugins, pages, installation, root };
}
function deferred() {
  let resolve!: (result: StorageResult) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<StorageResult>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

it("activates and observes CLI changes without any React subscribers", async () => {
  const { plugins, pages, installation } = harness();
  expect(plugins.startup()).toBe("loading");
  await vi.advanceTimersByTimeAsync(0);
  expect(plugins.startup()).toBe("ready");
  expect(pages.snapshot()).toHaveLength(1);
  const snapshot = plugins.snapshot();
  await vi.advanceTimersByTimeAsync(1000);
  expect(plugins.snapshot()).toBe(snapshot);
  vi.mocked(installation.getCatalog).mockResolvedValue(ready(false));
  await vi.advanceTimersByTimeAsync(1000);
  expect(pages.snapshot()).toHaveLength(0);
});
it("ignores a stale poll after a management change", async () => {
  const { plugins, pages, installation } = harness();
  await vi.advanceTimersByTimeAsync(0);
  const poll = deferred();
  vi.mocked(installation.getCatalog).mockReturnValueOnce(poll.promise);
  await vi.advanceTimersByTimeAsync(1000);
  await plugins.change("disable", "example");
  poll.resolve(ready());
  await vi.advanceTimersByTimeAsync(0);
  expect(pages.snapshot()).toHaveLength(0);
  expect(plugins.snapshot().configuration).toEqual(ready(false));
});
it("keeps the last usable configuration on refresh failure", async () => {
  const { plugins, pages, installation } = harness();
  await vi.advanceTimersByTimeAsync(0);
  vi.mocked(installation.getCatalog).mockRejectedValue(
    new Error("Storage offline"),
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(plugins.startup()).toBe("ready");
  expect(pages.snapshot()).toHaveLength(1);
  expect(plugins.snapshot().refreshError).toContain("Storage offline");
});
it("bounds startup reads, permits recovery, and ignores the late read", async () => {
  const initial = deferred();
  const { plugins } = harness({ getCatalog: () => initial.promise });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(plugins.startup()).toBe("recovery");
  await plugins.recover();
  initial.resolve(ready(false));
  await vi.advanceTimersByTimeAsync(0);
  expect(plugins.snapshot().configuration).toEqual(ready());
});
it("prevents overlapping edits and exposes their failure without dropping configuration", async () => {
  const change = vi.fn(async () => {
    throw new Error("Write failed");
  });
  const { plugins } = harness({ changePlugin: change });
  await vi.advanceTimersByTimeAsync(0);
  const first = plugins.change("disable", "example");
  await plugins.change("enable", "example");
  await first;
  expect(change).toHaveBeenCalledTimes(1);
  expect(plugins.snapshot().error).toContain("Write failed");
  expect(plugins.startup()).toBe("ready");
  expect(plugins.snapshot().busy).toBe(false);
  plugins.dismissError();
  expect(plugins.snapshot().error).toBeNull();
});
it.each(["resolve", "reject"] as const)(
  "does not replace a timed-out catalog read until it actually %ss",
  async (settlement) => {
    const pending = deferred();
    const getCatalog = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(ready());
    const { plugins } = harness({ getCatalog });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(plugins.startup()).toBe("recovery");
    await vi.advanceTimersByTimeAsync(33_000);
    expect(await plugins.retry()).toBe(false);
    expect(plugins.snapshot().error).toContain("still in progress");
    expect(getCatalog).toHaveBeenCalledTimes(1);
    if (settlement === "resolve") pending.resolve(ready(false));
    else pending.reject(new Error("Late native failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(plugins.startup()).toBe("recovery");
    await vi.advanceTimersByTimeAsync(1000);
    expect(getCatalog).toHaveBeenCalledTimes(2);
    expect(plugins.snapshot().configuration).toEqual(ready());
  },
);
it.each(["resolve", "reject"] as const)(
  "keeps a timed-out edit busy until it actually %ss, then refreshes",
  async (settlement) => {
    const pending = deferred();
    const changePlugin = vi.fn(() => pending.promise);
    const { plugins, installation } = harness({ changePlugin });
    await vi.advanceTimersByTimeAsync(0);
    const update = plugins.change("disable", "example");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await update).toBe(false);
    expect(plugins.snapshot().error).toContain("10 seconds");
    expect(plugins.snapshot().busy).toBe(true);
    expect(await plugins.change("enable", "example")).toBe(false);
    expect(await plugins.recover()).toBe(false);
    await vi.advanceTimersByTimeAsync(33_000);
    expect(changePlugin).toHaveBeenCalledTimes(1);
    expect(installation.recoverSettings).not.toHaveBeenCalled();
    expect(installation.getCatalog).toHaveBeenCalledTimes(1);
    if (settlement === "resolve") pending.resolve(ready(false));
    else pending.reject(new Error("Late write failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(plugins.snapshot().busy).toBe(false);
    // Neither late success nor failure may replace the displayed configuration.
    expect(plugins.snapshot().configuration).toEqual(ready());
    vi.mocked(installation.getCatalog).mockResolvedValue(ready(false));
    await vi.advanceTimersByTimeAsync(1000);
    expect(plugins.snapshot().configuration).toEqual(ready(false));
    expect(installation.getCatalog).toHaveBeenCalledTimes(2);
  },
);
it("does not publish a timed-out edit's settlement after disposal", async () => {
  const pending = deferred();
  const { plugins, installation } = harness({
    changePlugin: () => pending.promise,
  });
  await vi.advanceTimersByTimeAsync(0);
  const update = plugins.change("disable", "example");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await update).toBe(false);
  const listener = vi.fn();
  plugins.subscribe(listener);
  await plugins.dispose();
  pending.reject(new Error("Late write failure"));
  await vi.advanceTimersByTimeAsync(33_000);
  expect(listener).not.toHaveBeenCalled();
  expect(installation.getCatalog).toHaveBeenCalledTimes(1);
});
it("keeps an edit busy through configuration publication", async () => {
  const { plugins, installation } = harness();
  await vi.advanceTimersByTimeAsync(0);
  let reentered = false;
  plugins.subscribe(() => {
    if (!plugins.snapshot().busy && !reentered) {
      reentered = true;
      expect(plugins.snapshot().configuration).toEqual(ready(false));
      void plugins.change("enable", "example");
    }
  });
  expect(await plugins.change("disable", "example")).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(reentered).toBe(true);
  expect(installation.changePlugin).toHaveBeenCalledTimes(2);
});
it("keeps safe-mode configuration enabled while skipping external activation", async () => {
  const { plugins, pages } = harness({
    getCatalog: async () => ready(true, true),
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(plugins.startup()).toBe("ready");
  expect(plugins.snapshot().configuration).toEqual(ready(true, true));
  expect(pages.snapshot()).toHaveLength(0);
});
it("exposes activation failure separately from stored configuration", async () => {
  const { plugins, pages } = harness({}, true);
  await vi.advanceTimersByTimeAsync(0);
  expect(plugins.snapshot().configuration).toEqual(ready());
  expect(plugins.snapshot().activation.example?.error).toContain(
    "Activation failed",
  );
  expect(pages.snapshot()).toHaveLength(0);
});
it("stops polling and ignores pending reads on disposal", async () => {
  const pending = deferred();
  const { plugins, installation, pages } = harness({
    getCatalog: vi.fn(() => pending.promise),
  });
  const listener = vi.fn();
  plugins.subscribe(listener);
  await plugins.dispose();
  pending.resolve(ready());
  await vi.advanceTimersByTimeAsync(20_000);
  expect(listener).not.toHaveBeenCalled();
  expect(installation.getCatalog).toHaveBeenCalledTimes(1);
  expect(pages.snapshot()).toHaveLength(0);
});

it("disposing plugins leaves app-owned Cordis services alive", async () => {
  const { plugins, pages, root } = harness();
  const sharedCleanup = vi.fn();
  root.effect(() => sharedCleanup);
  await vi.advanceTimersByTimeAsync(0);
  expect(pages.snapshot()).toHaveLength(1);
  await plugins.dispose();
  expect(pages.snapshot()).toHaveLength(0);
  expect(sharedCleanup).not.toHaveBeenCalled();
  await root.fiber.dispose();
  expect(sharedCleanup).toHaveBeenCalledTimes(1);
});

it("provides the host React instance through Cordis", async () => {
  const { root } = harness();
  let received: unknown;
  const consumer = root.plugin({
    inject: ["react"],
    apply(ctx) {
      received = ctx.react;
    },
  });
  await consumer.await();
  expect(received).toBe(React);
});

it("defaults to platform storage using the bundled manifests", async () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  const root = new Context();
  roots.push(root);
  const plugins = createPluginManager(root, {
    bundled: [
      {
        manifest: { id: "example", name: "Example", apiVersion: 1 },
        module: { apply() {} },
      },
    ],
  });
  managers.push(plugins);
  await vi.advanceTimersByTimeAsync(0);
  expect(plugins.snapshot().configuration).toMatchObject({
    status: "ready",
    catalog: { plugins: [{ manifest: { id: "example" }, enabled: true }] },
  });
  expect(plugins.snapshot().activation.example?.status).toBe("active");
  await plugins.change("disable", "example");
  expect(plugins.snapshot().activation.example).toBeUndefined();
  expect(values.get("buzzodz.plugins.v1")).toContain('"example":false');
});

it("installs a selected preview through the management boundary, rejecting overlap and stale polls", async () => {
  const install = deferred();
  const imports = {
    folder: vi.fn(async () => null),
    git: vi.fn(async () => null),
    discard: vi.fn(async () => {}),
    install: vi.fn(() => install.promise),
  };
  const { plugins, installation } = harness({ imports });
  await vi.advanceTimersByTimeAsync(0);
  expect(plugins.imports).toBe(imports);
  const poll = deferred();
  vi.mocked(installation.getCatalog).mockReturnValueOnce(poll.promise);
  await vi.advanceTimersByTimeAsync(1000);
  const first = plugins.installImport("preview", "nested/dist");
  expect(await plugins.installImport("other", "wrong")).toBe(false);
  expect(imports.install).toHaveBeenCalledExactlyOnceWith(
    "preview",
    "nested/dist",
  );
  install.resolve(ready(false));
  expect(await first).toBe(true);
  poll.resolve(ready());
  await vi.advanceTimersByTimeAsync(0);
  expect(plugins.snapshot().configuration).toEqual(ready(false));
});

it("reloads through the management boundary, rejecting overlap and stale polls", async () => {
  const reload = deferred();
  const { plugins, installation } = harness({
    reloadPlugin: vi.fn(() => reload.promise),
  });
  await vi.advanceTimersByTimeAsync(0);
  const poll = deferred();
  vi.mocked(installation.getCatalog).mockReturnValueOnce(poll.promise);
  await vi.advanceTimersByTimeAsync(1000);
  const first = plugins.reload("example");
  expect(await plugins.reload("other")).toBe(false);
  expect(installation.reloadPlugin).toHaveBeenCalledExactlyOnceWith("example");
  reload.resolve(ready(false));
  expect(await first).toBe(true);
  poll.resolve(ready());
  await vi.advanceTimersByTimeAsync(0);
  expect(plugins.snapshot().configuration).toEqual(ready(false));
});
