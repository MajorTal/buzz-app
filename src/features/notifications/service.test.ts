import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { PluginRuntime } from "../../plugins/runtime";
import type { PluginModule } from "../../plugins/api";
import { provideNavigation } from "../navigation/service";
import { NotificationsService, type Notifications } from "./service";
import { createNotificationPreferences } from "./preferences";
import type {
  NotificationPlatform,
  NotificationPermissionState,
} from "./platform";

const viewer = "a".repeat(64);
const target = {
  version: 1,
  kind: "settings",
  section: "notifications",
} as const;
const contexts: Context[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  vi.restoreAllMocks();
});
function setup() {
  const ctx = new Context();
  contexts.push(ctx);
  let module: PluginModule = { apply() {} };
  const runtime = new PluginRuntime(ctx, async () => module);
  ctx.effect(() => () => runtime.dispose());
  const values = new Map<string, string>();
  const host = {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as Window;
  const preferences = createNotificationPreferences(host);
  const navigation = provideNavigation(ctx);
  const clicks: (() => void)[] = [];
  const failures: ((error: Error) => void)[] = [];
  let permission: NotificationPermissionState = "granted";
  const platform: NotificationPlatform = {
    label: "Test",
    permission: vi.fn(async () => permission),
    requestPermission: vi.fn(async () => permission),
    show: vi.fn(async (_item, activate, failed) => {
      clicks.push(activate);
      failures.push(failed);
    }),
    dispose: vi.fn(),
  };
  const service = new NotificationsService(
    ctx,
    navigation.navigation,
    platform,
    preferences,
  );
  service.selectViewer(viewer);
  return {
    ctx,
    service,
    preferences,
    platform,
    navigation,
    clicks,
    failures,
    values,
    host,
    permission(value: NotificationPermissionState) {
      permission = value;
    },
    submit(id = "event", eligible: () => boolean | "wait" = () => true) {
      return service.admit(
        "mention",
        "Mentions",
        { sourceKey: id, target },
        () => true,
        eligible,
      );
    },
    install(value: PluginModule) {
      module = value;
      runtime.reconcile([
        {
          manifest: { id: "test.plugin", name: "Test plugin", apiVersion: 1 },
          enabled: true,
          source: "external",
          revision: "v1",
          previous: null,
          error: null,
        },
      ]);
    },
    disable() {
      runtime.reconcile([]);
    },
  };
}
async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
it("deduplicates in this running session and routes clicks through existing navigation", async () => {
  const t = setup();
  expect(await t.submit()).toBe(true);
  expect(await t.submit()).toBe(false);
  await flush();
  expect(t.platform.show).toHaveBeenCalledTimes(1);
  t.clicks[0]?.();
  expect(t.navigation.navigation.snapshot().entry.target).toEqual(target);
  expect(t.navigation.navigation.snapshot().status).toBe("opening");
});
it("more than 256 sequential alerts do not fill a persistent inbox or pause delivery", async () => {
  const t = setup();
  for (let i = 0; i < 300; i++) {
    expect(await t.submit(String(i))).toBe(true);
    await flush();
  }
  expect(t.platform.show).toHaveBeenCalledTimes(300);
  expect(t.service.snapshot().error).toBeNull();
  expect(Object.keys(t.service.snapshot())).not.toContain("records");
});
it("retains a fresh candidate for explicit permission, without prompting on arrival", async () => {
  const t = setup();
  t.permission("default");
  await t.submit();
  await flush();
  expect(t.platform.requestPermission).not.toHaveBeenCalled();
  expect(t.platform.show).not.toHaveBeenCalled();
  t.permission("granted");
  await t.service.requestPermission();
  await flush();
  expect(t.platform.show).toHaveBeenCalledTimes(1);
});
it("an off/on transition during a permission probe cancels the old candidate", async () => {
  const t = setup();
  await flush();
  let release!: (value: NotificationPermissionState) => void;
  vi.mocked(t.platform.permission).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await t.submit();
  await flush();
  expect(release).toBeTypeOf("function");
  t.service.updatePreferences({ enabled: false });
  t.service.updatePreferences({ enabled: true });
  release("granted");
  await flush();
  expect(t.platform.show).not.toHaveBeenCalled();
});
it("readiness rechecks fresh candidates; expired candidates never reappear", async () => {
  const t = setup();
  let ready = false;
  await t.submit("waiting", () => (ready ? true : "wait"));
  await flush();
  expect(t.platform.show).not.toHaveBeenCalled();
  ready = true;
  t.service.revalidate();
  await flush();
  expect(t.platform.show).toHaveBeenCalledTimes(1);
  ready = false;
  await t.submit("old", () => (ready ? true : "wait"));
  await flush();
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 121000);
  ready = true;
  t.service.revalidate();
  await flush();
  expect(t.platform.show).toHaveBeenCalledTimes(1);
});
it("submission failure is reported once; unrelated alerts are not blocked", async () => {
  const t = setup();
  vi.mocked(t.platform.show).mockRejectedValueOnce(
    new Error("OS outcome unknown"),
  );
  await t.submit();
  await flush();
  expect(t.service.snapshot().error).toBe("OS outcome unknown");
  t.service.revalidate();
  await flush();
  expect(t.platform.show).toHaveBeenCalledTimes(1);
  await t.submit("next");
  await flush();
  expect(t.platform.show).toHaveBeenCalledTimes(2);
});
it("old account and disposed-host callbacks cannot navigate", async () => {
  const t = setup();
  await t.submit();
  await flush();
  const before = t.navigation.navigation.snapshot().entry;
  t.service.selectViewer("b".repeat(64));
  t.clicks[0]?.();
  expect(t.navigation.navigation.snapshot().entry).toBe(before);
  await t.submit("other");
  await flush();
  await t.ctx.fiber.dispose();
  t.clicks[1]?.();
  expect(t.navigation.navigation.snapshot().entry).toBe(before);
});
it("installed plugins share the host policy and stale producer handles are rejected", async () => {
  const t = setup();
  let producer: ReturnType<Notifications["register"]> | undefined;
  t.install({
    inject: ["notifications"],
    apply(ctx) {
      producer = ctx.notifications.register({
        id: "updates",
        label: "Updates",
      });
    },
  });
  await vi.waitFor(() => expect(producer).toBeDefined());
  expect(await producer?.submit({ sourceKey: "one", target })).toBe(true);
  await flush();
  expect(t.platform.show).toHaveBeenCalledTimes(1);
  t.disable();
  await flush();
  expect(await producer?.submit({ sourceKey: "two", target })).toBe(false);
  t.clicks[0]?.();
  expect(t.navigation.navigation.snapshot().entry.target).toEqual(target);
});
it("off takes effect despite storage failure and account preferences stay separate", () => {
  const t = setup();
  t.service.updatePreferences({ categories: { mention: false }, sound: false });
  t.service.selectViewer("b".repeat(64));
  expect(t.service.snapshot().preferences.sound).toBe(true);
  t.service.selectViewer(viewer);
  expect(t.service.snapshot().preferences.categories.mention).toBe(false);
  vi.spyOn(t.host.localStorage, "setItem").mockImplementation(() => {
    throw new Error("disk");
  });
  expect(t.service.updatePreferences({ enabled: false })).toBe(false);
  expect(t.service.snapshot().preferences.enabled).toBe(false);
  expect(t.service.snapshot().preferencesError).toContain("could not be saved");
});

it("a slow old permission probe cannot strand an alert after Allow completes", async () => {
  const t = setup();
  await flush();
  t.permission("default");
  let release!: (permission: NotificationPermissionState) => void;
  vi.mocked(t.platform.permission).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await t.submit();
  await flush();
  t.permission("granted");
  await t.service.requestPermission();
  await flush();
  release("default");
  await flush();
  expect(t.platform.show).toHaveBeenCalledTimes(1);
});

it("late platform errors report without retry and stay fenced to their account lifetime", async () => {
  const t = setup();
  await t.submit();
  await flush();
  t.failures[0]?.(new Error("Late display failure"));
  expect(t.service.snapshot().error).toBe("Late display failure");
  t.service.revalidate();
  await flush();
  expect(t.platform.show).toHaveBeenCalledTimes(1);
  t.service.selectViewer("b".repeat(64));
  t.failures[0]?.(new Error("Old account failure"));
  expect(t.service.snapshot().error).toBeNull();
  await t.ctx.fiber.dispose();
  t.failures[0]?.(new Error("Disposed failure"));
  expect(t.service.snapshot().error).toBeNull();
});
