import { Context } from "@deepseek-ai/cordis";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NotificationSettings } from "../../app/NotificationSettings";
import { PluginRuntime } from "../../plugins/runtime";
import { provideNavigation } from "../navigation/service";
import { createNotifications } from "./platform";
import { NotificationsService } from "./service";
import { messageNotificationText } from "./content";

const sdk = vi.hoisted(() => ({
  show: vi.fn(async (..._args: unknown[]) => {}),
  permission: vi.fn(async (_args: unknown) => "enabled"),
  indicator: vi.fn(async (_args: unknown) => {}),
}));
const native = vi.hoisted(() => ({ value: true }));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => native.value,
  invoke: (command: string, args: unknown) => {
    if (command === "notification_show") return sdk.show(command, args);
    if (command === "dock_permission") return sdk.permission(args);
    if (command === "unread_indicator_set") return sdk.indicator(args);
    throw new Error(`Unexpected native command: ${command}`);
  },
  Channel: class {
    constructor(public onmessage: (response: unknown) => void) {}
  },
}));
beforeEach(() => vi.stubGlobal("navigator", { platform: "MacIntel" }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) =>
    snapshot(),
}));
const contexts: Context[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
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
  expect(sdk.show).toHaveBeenCalledExactlyOnceWith("notification_show", {
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
  expect(sdk.show).toHaveBeenCalledTimes(1);
});

it("banner permission stays system-managed while Dock permission is queried separately", async () => {
  const { service, submit } = setup();
  await flush();
  await service.refreshPermission();
  await service.requestPermission();
  expect(service.snapshot().permission).toBe("unknown");
  expect(sdk.show).not.toHaveBeenCalled();
  expect(sdk.permission).toHaveBeenCalledExactlyOnceWith({ request: false });
  expect(service.indicator.snapshot().permission).toBe("enabled");
  expect(sdk.indicator).toHaveBeenCalledExactlyOnceWith({ unread: false });
  await submit("first");
  await flush();
  expect(sdk.show).toHaveBeenCalledOnce();
  expect(sdk.show).toHaveBeenCalledWith("notification_show", expect.anything());
});

it("observable SDK failures surface once without retry or a browser fallback", async () => {
  const { service, submit } = setup();
  sdk.show.mockImplementationOnce(() => {
    throw new Error("SDK unavailable");
  });
  await submit("failed");
  await flush();
  expect(service.snapshot().error).toBe("SDK unavailable");
  await submit("failed");
  await flush();
  expect(sdk.show).toHaveBeenCalledOnce();
  await submit("next");
  await flush();
  expect(sdk.show).toHaveBeenCalledTimes(2);
});

it("desktop settings expose app-owned sound with the reference desktop copy", async () => {
  const { service } = setup();
  await flush();
  const html = renderToStaticMarkup(
    createElement(NotificationSettings, { notifications: service }),
  );
  expect(html).toContain("Desktop alerts");
  expect(html).toContain("Mentions");
  expect(html).toContain("Fine-tune what gets through below.");
  expect(html).toContain(
    "Native desktop alerts are enabled for the categories you have armed below.",
  );
  // Sound is app-owned on desktop: the switch and per-event sound rows render.
  expect(html).toContain("Alert with a sound for the events below.");
  expect(html).toContain("Direct messages");
  expect(html).toContain("@Mentions");
  expect(html).toContain("Thread replies");
  expect(html).toContain("Preview flutter");
  expect(html).not.toContain("Permission granted");
  expect(html).not.toContain("Check permission");
  expect(html).not.toContain("Allow notifications");
  // Disabling desktop alerts swaps in the reference's disabled description.
  service.updatePreferences({ enabled: false });
  const disabled = renderToStaticMarkup(
    createElement(NotificationSettings, {
      notifications: service,
      // Keep this a pure copy render: `active` gates only preview and toasts,
      // and this harness has no Toast.Provider.
      active: false,
    }),
  );
  expect(disabled).toContain(
    "Request OS permission and surface new mentions or needs-action items outside the app.",
  );
  expect(disabled).not.toContain(
    "Native desktop alerts are enabled for the categories you have armed below.",
  );
});

it("non-Tauri runs select the unchanged browser adapter, never the native SDK", async () => {
  native.value = false;
  const platform = createNotifications();
  expect(platform.label).toBe("Browser notifications");
  expect(await platform.permission()).toBe("unsupported");
  expect(sdk.show).not.toHaveBeenCalled();
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
  expect(sdk.show).toHaveBeenCalledExactlyOnceWith("notification_show", {
    title: "Pinky mentioned you in #Room",
    body: "Hello Wes",
    id: expect.any(String),
    onEvent: expect.objectContaining({ onmessage: expect.any(Function) }),
  });
});

function presentation(index = 0) {
  const call = sdk.show.mock.calls[index] as unknown as [
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
  expect(sdk.show).toHaveBeenCalledTimes(3);
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
  sdk.show.mockImplementationOnce(async (...args: unknown[]) => {
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
      { id: String(i), title: "Buzz", body: "Hi" },
      activate,
      failed,
    );
  await expect(
    platform.show(
      { id: "overflow", title: "Buzz", body: "Hi" },
      activate,
      failed,
    ),
  ).rejects.toThrow("maximum 128");
  expect(sdk.show).toHaveBeenCalledTimes(128);
  const first = presentation(0);
  first.onEvent.onmessage({ id: first.id, kind: "activated" });
  expect(activate).toHaveBeenCalledOnce();
  await platform.show(
    { id: "next", title: "Buzz", body: "Hi" },
    activate,
    failed,
  );
  expect(sdk.show).toHaveBeenCalledTimes(129);
  platform.dispose();
});

it.each(["Win32", "Linux x86_64"])(
  "%s has no Dock IPC or Settings and keeps existing banners",
  async (platform) => {
    vi.stubGlobal("navigator", { platform });
    const { service, submit, ctx } = setup();
    await service.indicator.refresh();
    expect(service.indicator.available).toBe(false);
    expect(
      renderToStaticMarkup(
        createElement(NotificationSettings, { notifications: service }),
      ),
    ).not.toContain("Dock unread badge");
    service.indicator.setUnread(true);
    await flush();
    await service.indicator.request();
    expect(sdk.permission).not.toHaveBeenCalled();
    await submit("banner");
    await flush();
    expect(sdk.show).toHaveBeenCalledOnce();
    await ctx.fiber.dispose();
    expect(sdk.indicator).not.toHaveBeenCalled();
    expect(sdk.permission).not.toHaveBeenCalled();
  },
);

it("browser runs create no shell indicator", async () => {
  native.value = false;
  const { service, ctx } = setup();
  service.indicator.setUnread(true);
  await service.indicator.refresh();
  await ctx.fiber.dispose();
  expect(service.indicator.available).toBe(false);
  expect(sdk.permission).not.toHaveBeenCalled();
  expect(sdk.indicator).not.toHaveBeenCalled();
});

it("the macOS default binds explicit permission and ordered unread/clear commands", async () => {
  sdk.permission.mockResolvedValueOnce("default");
  const { service, ctx } = setup();
  service.indicator.setUnread(true);
  await service.indicator.refresh();
  expect(sdk.indicator.mock.calls).toEqual([[{ unread: false }]]);
  await service.indicator.request();
  expect(sdk.permission.mock.calls).toEqual([
    [{ request: false }],
    [{ request: true }],
  ]);
  expect(sdk.indicator).toHaveBeenLastCalledWith({ unread: true });
  service.updatePreferences({ enabled: false });
  expect(sdk.indicator).toHaveBeenLastCalledWith({ unread: true });
  await ctx.fiber.dispose();
  expect(sdk.indicator).toHaveBeenLastCalledWith({ unread: false });
});
