// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PluginRuntime } from "../plugins/runtime";
import { provideNavigation } from "../features/navigation/service";
import { createBrowserNotifications } from "../features/notifications/platform";
import { createNotificationPreferences } from "../features/notifications/preferences";
import { NotificationsService } from "../features/notifications/service";
import { NotificationSettings } from "./NotificationSettings";

const contexts: Context[] = [];
beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});
afterEach(async () => {
  cleanup();
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function setup(permission: NotificationPermission) {
  const shown: FakeNotification[] = [];
  class FakeNotification {
    static permission = permission;
    static requestPermission = vi.fn(async () => FakeNotification.permission);
    onclick: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    close = vi.fn();
    constructor() {
      shown.push(this);
    }
  }
  vi.stubGlobal("Notification", FakeNotification);
  const ctx = new Context();
  contexts.push(ctx);
  const runtime = new PluginRuntime(ctx, async () => ({ apply() {} }));
  ctx.effect(() => () => runtime.dispose());
  const service = new NotificationsService(
    ctx,
    provideNavigation(ctx).navigation,
    createBrowserNotifications(window),
    createNotificationPreferences(window),
  );
  service.selectViewer("a".repeat(64));
  await service.refreshPermission();
  render(<NotificationSettings notifications={service} />, {
    reactStrictMode: true,
  });
  return {
    service,
    shown,
    FakeNotification,
    async submit(sourceKey: string) {
      let accepted = false;
      await act(async () => {
        accepted = await service.admit(
          "mention",
          "Mentions",
          { sourceKey, target: { version: 1, kind: "settings" } },
          () => true,
        );
      });
      return accepted;
    },
  };
}

// Complete the presentation scheduler before asserting absence of delivery.
const present = () => act(() => vi.advanceTimersByTimeAsync(100));

it("Allow releases a pending alert and master toggles preserve category choices", async () => {
  const h = await setup("default");
  expect(await h.submit("pending")).toBe(true);
  await present();
  expect(h.shown).toHaveLength(0);
  expect(h.FakeNotification.requestPermission).not.toHaveBeenCalled();
  let grant!: (permission: NotificationPermission) => void;
  h.FakeNotification.requestPermission.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        grant = resolve;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Allow notifications" }));
  try {
    expect(h.FakeNotification.requestPermission).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Waiting for system permission",
    );
    expect(
      screen.getByRole("button", { name: "Allow notifications" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Check permission" }),
    ).toBeDisabled();
    await present();
    expect(h.shown).toHaveLength(0);
  } finally {
    await act(async () => {
      h.FakeNotification.permission = "granted";
      grant("granted");
    });
  }
  await present();
  expect(h.shown).toHaveLength(1);
  expect(screen.getByRole("status")).toHaveTextContent("Permission granted");
  fireEvent.click(screen.getByRole("switch", { name: "Mentions" }));
  fireEvent.click(screen.getByRole("switch", { name: "Desktop alerts" }));
  fireEvent.click(screen.getByRole("switch", { name: "Desktop alerts" }));
  expect(screen.getByRole("switch", { name: "Desktop alerts" })).toBeChecked();
  expect(screen.getByRole("switch", { name: "Mentions" })).not.toBeChecked();
  expect(await h.submit("muted")).toBe(false);
  await present();
  expect(h.shown).toHaveLength(1);
});

it("browser display errors reach mounted Settings and retire callbacks without redelivery", async () => {
  const h = await setup("granted");
  expect(await h.submit("failed")).toBe(true);
  await present();
  expect(h.shown).toHaveLength(1);
  const item = h.shown[0];
  if (!item) throw new Error("No notification was displayed");
  act(() => item.onerror?.());
  expect(screen.getByRole("alert")).toHaveTextContent(
    "The browser could not display a notification.",
  );
  expect(item.close).toHaveBeenCalledOnce();
  expect(item.onclick).toBeNull();
  expect(item.onerror).toBeNull();
  expect(item.onclose).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Check permission" }));
  expect(await h.submit("failed")).toBe(false);
  await present();
  expect(h.shown).toHaveLength(1);
});
