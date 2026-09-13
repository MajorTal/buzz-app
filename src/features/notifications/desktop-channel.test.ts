import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createNotifications } from "./platform";

// Real Tauri Channel/serialization and production adapter. Only the WebView's
// callback registry and native command boundary are replaced (no OS banners).
type WireMessage =
  | { message: { id: string; kind: string; error?: string }; index: number }
  | { end: true; index: number };
const callbacks = new Map<number, (message: WireMessage) => void>();
let sequence = 0;
const calls: { id: string; onEvent: string; title: string; body: string }[] =
  [];
const invoke = vi.fn(async (_command: string, args: unknown) => {
  calls.push(JSON.parse(JSON.stringify(args)));
});
beforeEach(() => {
  vi.stubGlobal("isTauri", true);
  vi.stubGlobal("window", {
    __TAURI_INTERNALS__: {
      transformCallback(callback: (message: WireMessage) => void) {
        const id = ++sequence;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback(id: number) {
        callbacks.delete(id);
      },
      invoke,
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  callbacks.clear();
  calls.length = 0;
});
const item = () => ({
  id: crypto.randomUUID(),
  title: "Buzz",
  body: "Hello",
  silent: true,
});
function callback(index = 0) {
  const call = calls[index];
  if (!call) throw new Error("No native presentation");
  expect(call.onEvent).toMatch(/^__CHANNEL__:\d+$/);
  const id = Number(call.onEvent.split(":")[1]);
  const send = callbacks.get(id);
  if (!send) throw new Error("Native callback was not registered before send");
  return { call, id, send };
}

it("reports system-managed permission without a window.Notification shim or native calls", async () => {
  const platform = createNotifications();
  expect(platform.systemManaged).toBe(true);
  expect(await platform.permission()).toBe("unknown");
  expect(await platform.requestPermission()).toBe("unknown");
  expect(invoke).not.toHaveBeenCalled();
  expect(callbacks.size).toBe(0);
  platform.dispose();
});

it("serializes each pre-registered channel and releases it after ordered native completion", async () => {
  const platform = createNotifications();
  const first = vi.fn(),
    second = vi.fn(),
    failed = vi.fn();
  await platform.show(item(), first, failed);
  await platform.show(item(), second, failed);
  expect(invoke.mock.calls.map(([command]) => command)).toEqual([
    "notification_show",
    "notification_show",
  ]);
  const a = callback(0),
    b = callback(1);
  expect(a.id).not.toBe(b.id);
  expect(Object.keys(a.call).sort()).toEqual([
    "body",
    "id",
    "onEvent",
    "title",
  ]);
  // Tauri may deliver end ahead of a payload: Channel must hold it until index 0.
  b.send({ end: true, index: 1 });
  expect(callbacks.has(b.id)).toBe(true);
  b.send({ message: { id: b.call.id, kind: "activated" }, index: 0 });
  expect(second).toHaveBeenCalledOnce();
  expect(first).not.toHaveBeenCalled();
  expect(callbacks.has(b.id)).toBe(false);
  a.send({ message: { id: a.call.id, kind: "closed" }, index: 0 });
  a.send({ end: true, index: 1 });
  expect(first).not.toHaveBeenCalled();
  expect(failed).not.toHaveBeenCalled();
  expect(callbacks.size).toBe(0);
  platform.dispose();
});

it("accepts a native activation before the command promise resolves", async () => {
  const platform = createNotifications();
  const activate = vi.fn();
  invoke.mockImplementationOnce(async (_command, args) => {
    calls.push(JSON.parse(JSON.stringify(args)));
    const { call, send } = callback();
    send({ message: { id: call.id, kind: "activated" }, index: 0 });
    send({ end: true, index: 1 });
  });
  await platform.show(item(), activate, vi.fn());
  expect(activate).toHaveBeenCalledOnce();
  expect(callbacks.size).toBe(0);
  platform.dispose();
});

it("disposal fences the real transport while a late native end still releases registration", async () => {
  const platform = createNotifications();
  const activate = vi.fn(),
    failed = vi.fn();
  await platform.show(item(), activate, failed);
  const { call, send } = callback();
  platform.dispose();
  send({
    message: { id: call.id, kind: "activated", error: "late" },
    index: 0,
  });
  send({ end: true, index: 1 });
  expect(activate).not.toHaveBeenCalled();
  expect(failed).not.toHaveBeenCalled();
  expect(callbacks.size).toBe(0);
});

it("native admission rejection ends its channel without navigation or a send retry", async () => {
  const platform = createNotifications();
  const activate = vi.fn();
  invoke.mockImplementationOnce(async (_command, args) => {
    calls.push(JSON.parse(JSON.stringify(args)));
    callback().send({ end: true, index: 0 });
    throw new Error("Too many active desktop notifications (maximum 128)");
  });
  await expect(platform.show(item(), activate, vi.fn())).rejects.toThrow(
    "maximum 128",
  );
  expect(callbacks.size).toBe(0);
  expect(activate).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledOnce();
  platform.dispose();
});
