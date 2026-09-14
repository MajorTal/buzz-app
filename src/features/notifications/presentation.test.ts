import { afterEach, expect, it, vi } from "vitest";
import { afterPresentation } from "./presentation";
afterEach(() => vi.useRealTimers());
it("a throttled document cannot indefinitely hold delivery or retain frame work", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const host = {
    requestAnimationFrame: vi.fn(() => 1),
    cancelAnimationFrame: cancel,
    setTimeout,
    clearTimeout,
  } as unknown as Window;
  const complete = vi.fn();
  const pending = afterPresentation(host).then(complete);
  await vi.advanceTimersByTimeAsync(99);
  expect(complete).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  expect(complete).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledWith(1);
  expect(vi.getTimerCount()).toBe(0);
});
