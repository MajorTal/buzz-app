import { Context } from "@deepseek-ai/cordis";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { NotificationSettings } from "../../app/NotificationSettings";
import { PluginRuntime } from "../../plugins/runtime";
import { provideNavigation } from "../navigation/service";
import { createNotifications } from "./platform";
import { NotificationsService } from "./service";
import { messageNotificationText } from "./content";

const sdk = vi.hoisted(() => ({
  invoke: vi.fn(async () => {}),
}));
const native = vi.hoisted(() => ({ value: true }));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => native.value,
  invoke: sdk.invoke,
  Channel: class {
    constructor(public onmessage: (response: unknown) => void) {}
  },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) =>
    snapshot(),
}));
const contexts: Context[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  vi.resetAllMocks();
  native.value = true;
});
function setup() {
  const ctx = new Context();
  contexts.push(ctx);
  const runtime = new PluginRuntime(ctx, async () => ({ apply() {} }));
  ctx.effect(() => () => runtime.dispose());
  const navigation = provideNavigation(ctx).navigation;
  // Exercise the production default, not an injected adapter.
  const service = new NotificationsService(ctx, navigation);
  service.selectViewer("a".repeat(64));
  const submit = (sourceKey: string) =>
    service.admit(
      "mention",
      "Mentions",
      { sourceKey, target: { version: 1, kind: "settings" } },
      () => true,
      () => true,
    );
  return { service, submit, navigation, ctx };
}
async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

it("the default service sends desktop banners via the native bridge and shared policy", async () => {
  const { service, submit } = setup();
  await flush();
  expect(service.snapshot()).toMatchObject({
    permission: "unknown",
    systemManaged: true,
    preferences: { enabled: true },
  });
  await submit("first");
  await submit("first");
  await flush();
  expect(sdk.invoke).toHaveBeenCalledExactlyOnceWith("notification_show", {
    title: "Buzz",
    body: "New mentions",
    id: expect.any(String),
    onEvent: expect.objectContaining({ onmessage: expect.any(Function) }),
  });
  service.updatePreferences({ enabled: false });
  await submit("off");
  service.updatePreferences({ enabled: true, categories: { mention: false } });
  await submit("category-off");
  await flush();
  expect(sdk.invoke).toHaveBeenCalledTimes(1);
});

it("desktop permission remains system-managed without a permission RPC or shim", async () => {
  const { service, submit } = setup();
  await flush();
  await service.refreshPermission();
  await service.requestPermission();
  expect(service.snapshot().permission).toBe("unknown");
  expect(sdk.invoke).not.toHaveBeenCalled();
  await submit("first");
  await flush();
  expect(sdk.invoke).toHaveBeenCalledOnce();
  expect(sdk.invoke).toHaveBeenCalledWith(
    "notification_show",
    expect.anything(),
  );
});

it("observable SDK failures surface once without retry or a browser fallback", async () => {
  const { service, submit } = setup();
  sdk.invoke.mockImplementationOnce(() => {
    throw new Error("SDK unavailable");
  });
  await submit("failed");
  await flush();
  expect(service.snapshot().error).toBe("SDK unavailable");
  await submit("failed");
  await flush();
  expect(sdk.invoke).toHaveBeenCalledOnce();
  await submit("next");
  await flush();
  expect(sdk.invoke).toHaveBeenCalledTimes(2);
});

it("desktop settings explain OS sound and running-app exact clicks", async () => {
  const { service } = setup();
  await flush();
  const html = renderToStaticMarkup(
    createElement(NotificationSettings, { notifications: service }),
  );
  expect(html).toContain("Desktop alerts");
  expect(html).toContain("Mentions");
  expect(html).toContain(
    "Manage sound and permission in system notification settings",
  );
  expect(html).toContain(
    "Desktop clicks bring Buzz forward and open the message or thread while Buzz is",
  );
  expect(html).not.toContain("<span>Sound</span>");
  expect(html).not.toContain("Permission granted");
  expect(html).not.toContain("Check permission");
  expect(html).not.toContain("Allow notifications");
});

it("non-Tauri runs select the unchanged browser adapter, never the native SDK", async () => {
  native.value = false;
  const platform = createNotifications();
  expect(platform.label).toBe("Browser notifications");
  expect(await platform.permission()).toBe("unsupported");
  expect(sdk.invoke).not.toHaveBeenCalled();
});

it("the production desktop adapter forwards the message title and preview unchanged", async () => {
  const { service } = setup();
  await service.admit(
    "mention",
    "Mentions",
    { sourceKey: "rich", target: { version: 1, kind: "settings" } },
    () => true,
    () => true,
    () =>
      messageNotificationText(
        {
          channelId: "room",
          messageId: "b".repeat(64),
          authorId: "c".repeat(64),
          createdAt: 1,
          previewContent: "Hello **Wes**",
        },
        "mention",
        { id: "room", name: "Room" },
        { name: "Pinky" },
      ),
  );
  await flush();
  expect(sdk.invoke).toHaveBeenCalledExactlyOnceWith("notification_show", {
    title: "Pinky mentioned you in #Room",
    body: "Hello Wes",
    id: expect.any(String),
    onEvent: expect.objectContaining({ onmessage: expect.any(Function) }),
  });
});

function presentation(index = 0) {
  const call = sdk.invoke.mock.calls[index] as unknown as [
    string,
    {
      id: string;
      onEvent: {
        onmessage(response: { id: string; kind: string; error?: string }): void;
      };
    },
  ];
  return call[1];
}

it("the production default returns each native click to its exact navigation callback once", async () => {
  const { service, navigation } = setup();
  const open = vi.fn();
  navigation.subscribe(() => open(navigation.snapshot().entry.target));
  for (const section of ["notifications", "appearance"] as const) {
    await service.admit(
      "mention",
      "Mentions",
      {
        sourceKey: section,
        target: { version: 1, kind: "settings", section },
      },
      () => true,
      () => true,
    );
  }
  await flush();
  const first = presentation(0),
    second = presentation(1);
  expect(first.id).not.toBe(second.id);
  first.onEvent.onmessage({ id: second.id, kind: "activated" });
  expect(open).not.toHaveBeenCalled();
  second.onEvent.onmessage({ id: second.id, kind: "activated" });
  first.onEvent.onmessage({ id: first.id, kind: "activated" });
  first.onEvent.onmessage({ id: first.id, kind: "activated" });
  expect(open.mock.calls.map(([target]) => target)).toEqual([
    { version: 1, kind: "settings", section: "appearance" },
    { version: 1, kind: "settings", section: "notifications" },
  ]);
});

it("native close/error never opens or retries; focus failure still preserves exact navigation", async () => {
  const { service, submit, navigation } = setup();
  const open = vi.fn();
  navigation.subscribe(() => open(navigation.snapshot().entry.target));
  for (const source of ["closed", "failed", "focus"]) await submit(source);
  await flush();
  const first = presentation(0),
    second = presentation(1),
    third = presentation(2);
  first.onEvent.onmessage({ id: first.id, kind: "closed" });
  second.onEvent.onmessage({
    id: second.id,
    kind: "failed",
    error: "OS submission failed",
  });
  expect(service.snapshot().error).toBe("OS submission failed");
  expect(open).not.toHaveBeenCalled();
  third.onEvent.onmessage({
    id: third.id,
    kind: "activated",
    error: "Window focus failed",
  });
  expect(open).toHaveBeenCalledOnce();
  expect(service.snapshot().error).toBe("Window focus failed");
  await service.refreshPermission();
  await flush();
  expect(sdk.invoke).toHaveBeenCalledTimes(3);
});

it("account replacement and service disposal fence previously displayed native clicks", async () => {
  const { service, submit, navigation, ctx } = setup();
  const open = vi.fn();
  navigation.subscribe(() => open(navigation.snapshot().entry.target));
  await submit("old-account");
  await flush();
  const first = presentation(0);
  service.selectViewer("b".repeat(64));
  first.onEvent.onmessage({ id: first.id, kind: "activated" });
  expect(open).not.toHaveBeenCalled();
  await submit("disposed");
  await flush();
  const second = presentation(1);
  await ctx.fiber.dispose();
  second.onEvent.onmessage({ id: second.id, kind: "activated" });
  expect(open).not.toHaveBeenCalled();
});

it("the click channel exists before native submission, including immediate activation", async () => {
  const { navigation, submit } = setup();
  const open = vi.fn();
  navigation.subscribe(() => open(navigation.snapshot().entry.target));
  sdk.invoke.mockImplementationOnce(async (...args: unknown[]) => {
    const { id, onEvent } = args[1] as ReturnType<typeof presentation>;
    onEvent.onmessage({ id, kind: "activated" });
  });
  await submit("immediate");
  await flush();
  expect(open).toHaveBeenCalledExactlyOnceWith({
    version: 1,
    kind: "settings",
  });
});

it("native presentation rejects at capacity before sending instead of evicting live targets", async () => {
  const platform = createNotifications();
  const activate = vi.fn(),
    failed = vi.fn();
  for (let i = 0; i < 128; i++)
    await platform.show(
      { id: String(i), title: "Buzz", body: "Hi", silent: true },
      activate,
      failed,
    );
  await expect(
    platform.show(
      { id: "overflow", title: "Buzz", body: "Hi", silent: true },
      activate,
      failed,
    ),
  ).rejects.toThrow("maximum 128");
  expect(sdk.invoke).toHaveBeenCalledTimes(128);
  const first = presentation(0);
  first.onEvent.onmessage({ id: first.id, kind: "activated" });
  expect(activate).toHaveBeenCalledOnce();
  await platform.show(
    { id: "next", title: "Buzz", body: "Hi", silent: true },
    activate,
    failed,
  );
  expect(sdk.invoke).toHaveBeenCalledTimes(129);
  platform.dispose();
});
