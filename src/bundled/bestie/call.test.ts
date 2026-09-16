import { afterEach, expect, test, vi } from "vitest";
import { createBestieCall } from "./call";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import type { Voice, VoiceUI, openVoice } from "./media/voice.mjs";

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});
function fixture(customOpen?: typeof openVoice) {
  const viewer = "ab".repeat(32);
  let snapshot: RelaySnapshot = {
    status: "ready",
    generation: 1,
    scope: `https://one.example:${viewer}`,
    viewer,
    session: {} as RelaySnapshot["session"],
  };
  const listeners = new Set<() => void>();
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    retry() {},
    disconnect() {},
    async clearCache() {},
  };
  let ui: VoiceUI | undefined,
    options: Parameters<typeof openVoice>[2] | undefined;
  const voice: Voice = {
    stop: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    decide: vi.fn(async () => {}),
    setMuted: vi.fn(),
  };
  const open = vi.fn<typeof openVoice>(
    customOpen ??
      (async (_token, callbacks, settings) => {
        ui = callbacks;
        options = settings;
        settings.created?.(voice);
        callbacks.event("ready", {});
        return voice;
      }),
  );
  const call = createBestieCall(relay, async () => open);
  disposals.push(call.dispose);
  return {
    call,
    open,
    voice,
    callbacks: () => {
      if (!ui) throw Error("Call not opened");
      return ui;
    },
    options: () => {
      if (!options) throw Error("Call not opened");
      return options;
    },
    change(patch: Partial<RelaySnapshot>) {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) listener();
    },
    community(name: string) {
      this.change({
        scope: `https://${name}.example:${viewer}`,
        session: {} as RelaySnapshot["session"],
      });
    },
  };
}
const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

test("one plugin call uses captured community and negotiated audio client", async () => {
  const f = fixture();
  await Promise.all([f.call.start(), f.call.start()]);
  expect(f.open).toHaveBeenCalledTimes(1);
  expect(f.options().eventsUrl).toBe(
    "/api/relay/https%3A%2F%2Fone.example/bestie?op=events&approval=auto",
  );
  expect(f.call.snapshot().phase).toBe("listening");
  f.call.mute();
  expect(f.voice.setMuted).toHaveBeenCalledWith(true);
});
test("automatic approval is the default and the chosen policy is fixed during a call", async () => {
  const f = fixture();
  expect(f.call.snapshot().approval).toBe("auto");
  f.call.setApproval("invalid");
  expect(f.call.snapshot().approval).toBe("auto");
  f.call.setApproval("ask");
  await f.call.start();
  expect(f.options().eventsUrl).toContain("approval=ask");
  f.call.setApproval("auto");
  expect(f.call.snapshot().approval).toBe("ask");
  await f.call.end();
  f.call.setApproval("auto");
  expect(f.call.snapshot().approval).toBe("auto");
});
test("immediate panel relocation preserves one call; closing releases it", async () => {
  const f = fixture();
  const release = f.call.attach();
  await f.call.start();
  release();
  const moved = f.call.attach();
  await flush();
  expect(f.voice.stop).not.toHaveBeenCalled();
  moved();
  await flush();
  expect(f.options().signal.aborted).toBe(true);
  expect(f.voice.stop).toHaveBeenCalledTimes(1);
});
test("idle transcript does not cross communities", async () => {
  const f = fixture();
  await f.call.start();
  f.callbacks().transcript("Private to community one.");
  await f.call.end();
  expect(f.call.snapshot().messages).toHaveLength(1);
  f.community("two");
  expect(f.call.snapshot().messages).toEqual([]);
  expect(f.call.snapshot().community).toBe("https://two.example");
});
test("session replacement synchronously revokes audio and pending approval", async () => {
  const f = fixture();
  await f.call.start();
  const decide = vi.fn(async () => {});
  f.callbacks().permission({ title: "Run command" }, decide);
  const request = f.call.snapshot().permission?.request;
  if (!request) throw Error("missing approval");
  f.change({ session: {} as RelaySnapshot["session"] });
  expect(f.options().signal.aborted).toBe(true);
  expect(f.call.snapshot().permission).toBeUndefined();
  await f.call.decide(true, request);
  expect(decide).not.toHaveBeenCalled();
  f.callbacks().transcript("Late answer");
  expect(f.call.snapshot().messages).toEqual([]);
});
test("an old rendered approval cannot approve a replacement request", async () => {
  const f = fixture();
  await f.call.start();
  const first = vi.fn(async () => {}),
    second = vi.fn(async () => {});
  f.callbacks().permission({ title: "A" }, first);
  const a = f.call.snapshot().permission?.request;
  if (!a) throw Error("missing A");
  f.callbacks().permission({ title: "B" }, second);
  const b = f.call.snapshot().permission?.request;
  if (!b) throw Error("missing B");
  await f.call.decide(true, a);
  expect(first).not.toHaveBeenCalled();
  expect(second).not.toHaveBeenCalled();
  await f.call.decide(false, b);
  expect(second).toHaveBeenCalledExactlyOnceWith("reject_once");
});
test("resumed speech revokes the current permission", async () => {
  const f = fixture();
  await f.call.start();
  const decide = vi.fn(async () => {});
  f.callbacks().permission({ title: "A" }, decide);
  const request = f.call.snapshot().permission?.request;
  if (!request) throw Error("missing approval");
  f.callbacks().event("speech_started", {});
  await f.call.decide(true, request);
  expect(decide).not.toHaveBeenCalled();
  expect(f.call.snapshot().permission).toBeUndefined();
});
test("pending media setup cannot resurrect after community change", async () => {
  let complete: ((voice: Voice) => void) | undefined;
  let signal: AbortSignal | undefined;
  const voice: Voice = {
    stop: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    decide: vi.fn(async () => {}),
    setMuted() {},
  };
  const f = fixture(async (_token, _ui, options) => {
    signal = options.signal;
    options.created?.(voice);
    return new Promise((resolve) => {
      complete = resolve;
    });
  });
  const opening = f.call.start();
  await flush();
  f.community("two");
  expect(signal?.aborted).toBe(true);
  if (!complete) throw Error("not started");
  complete(voice);
  await opening;
  expect(f.call.snapshot().phase).toBe("idle");
  expect(f.call.snapshot().messages).toEqual([]);
});
test("reconnect stays disabled until media teardown completes", async () => {
  let finish: (() => void) | undefined;
  const f = fixture();
  await f.call.start();
  vi.mocked(f.voice.stop).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const ending = f.call.end();
  await f.call.start();
  expect(f.open).toHaveBeenCalledTimes(1);
  expect(f.call.snapshot().phase).toBe("stopping");
  if (!finish) throw Error("cleanup missing");
  finish();
  await ending;
  expect(f.call.snapshot().phase).toBe("idle");
});
test("thinking belongs to the call across panel relocation", async () => {
  const f = fixture();
  f.call.setThinking("high");
  const release = f.call.attach();
  await f.call.start();
  release();
  f.call.attach();
  await flush();
  expect(f.options().thinking).toBe("high");
  expect(f.call.snapshot().thinking).toBe("high");
  f.call.setThinking("none");
  expect(f.call.snapshot().thinking).toBe("high");
});
test("disabling the plugin fences late callbacks and further starts", async () => {
  const f = fixture();
  await f.call.start();
  f.call.dispose();
  f.callbacks().permission({ title: "late" }, vi.fn());
  await f.call.start();
  expect(f.options().signal.aborted).toBe(true);
  expect(f.open).toHaveBeenCalledTimes(1);
  expect(f.call.snapshot().permission).toBeUndefined();
});

test("audio analyzers follow the active call and ignores retired callbacks", async () => {
  const f = fixture();
  await f.call.start();
  const old = f.callbacks();
  const analyser = {} as AnalyserNode;
  const output = {} as AnalyserNode;
  old.analyzers(analyser, output);
  expect(f.call.snapshot().inputAnalyser).toBe(analyser);
  expect(f.call.snapshot().outputAnalyser).toBe(output);
  await f.call.end();
  expect(f.call.snapshot().inputAnalyser).toBeNull();
  expect(f.call.snapshot().outputAnalyser).toBeNull();
  await f.call.start();
  old.analyzers(analyser, output);
  expect(f.call.snapshot().inputAnalyser).toBeNull();
  expect(f.call.snapshot().outputAnalyser).toBeNull();
  f.callbacks().analyzers(analyser, output);
  f.callbacks().ended();
  expect(f.call.snapshot().inputAnalyser).toBeNull();
  expect(f.call.snapshot().outputAnalyser).toBeNull();
});

test("community replacement clears both audio analyzers immediately", async () => {
  const f = fixture();
  await f.call.start();
  f.callbacks().analyzers({} as AnalyserNode, {} as AnalyserNode);
  f.community("two");
  expect(f.call.snapshot().inputAnalyser).toBeNull();
  expect(f.call.snapshot().outputAnalyser).toBeNull();
});

test("transcript visibility defaults off and can change without restarting the call", async () => {
  const f = fixture();
  expect(f.call.snapshot().showTranscript).toBe(false);
  await f.call.start();
  f.callbacks().transcript("Kept while hidden.");
  f.call.setShowTranscript(true);
  expect(f.call.snapshot().showTranscript).toBe(true);
  const messages = f.call.snapshot().messages;
  f.call.setShowTranscript(false);
  expect(f.call.snapshot().messages).toBe(messages);
  f.call.setShowTranscript(true);
  expect(f.open).toHaveBeenCalledTimes(1);
  expect(f.voice.stop).not.toHaveBeenCalled();
  await f.call.end();
  await f.call.start();
  expect(f.call.snapshot().showTranscript).toBe(true);
  expect(f.call.snapshot().messages).toEqual([]);
});

test("transcript timestamps stay at first receipt as message chunks arrive", async () => {
  const now = vi.spyOn(Date, "now");
  try {
    const f = fixture();
    await f.call.start();
    now.mockReturnValue(1000);
    f.callbacks().transcript("First ");
    now.mockReturnValue(5000);
    f.callbacks().transcript("reply.");
    f.callbacks().userTranscript("Next question.", "user-1");
    expect(f.call.snapshot().messages).toMatchObject([
      { text: "First reply.", createdAt: 1 },
      { text: "Next question.", createdAt: 5 },
    ]);
  } finally {
    now.mockRestore();
  }
});
