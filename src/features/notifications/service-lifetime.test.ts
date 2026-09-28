// @vitest-environment jsdom
import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { PluginRuntime } from "../../plugins/runtime";
import { provideNavigation } from "../navigation/service";
import { NotificationsService } from "./service";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// A test file's jsdom window is torn down after its last test. A presentation
// wait that outlives its service then fires against a missing host.
it("closing the service retires its pending presentation wait", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const frames = new Set<number>();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => {
    const id = frames.size + 1;
    frames.add(id);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  const ctx = new Context();
  const runtime = new PluginRuntime(ctx, async () => ({ apply() {} }));
  ctx.effect(() => () => runtime.dispose());
  const service = new NotificationsService(
    ctx,
    provideNavigation(ctx).navigation,
    {
      label: "Test",
      permission: async () => "granted",
      requestPermission: async () => "granted",
      show: async () => {},
      dispose() {},
    },
  );
  // Selecting a viewer revalidates, which schedules one presentation wait.
  service.selectViewer("a".repeat(64));
  expect(frames.size).toBe(1);
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  await ctx.fiber.dispose();
  expect(frames.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
