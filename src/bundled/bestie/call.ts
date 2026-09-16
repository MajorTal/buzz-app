import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import { relayOrigin } from "../../features/communities/destination";
import type {
  PermissionTool,
  Voice,
  VoiceUI,
  openVoice,
} from "./media/voice.mjs";

type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
};
type Phase =
  | "idle"
  | "connecting"
  | "listening"
  | "speaking"
  | "stopping"
  | "error";
export type CallSnapshot = Readonly<{
  phase: Phase;
  message: string;
  community: string | undefined;
  muted: boolean;
  showTranscript: boolean;
  inputAnalyser: AnalyserNode | null;
  outputAnalyser: AnalyserNode | null;
  permission: (PermissionTool & { request: number }) | undefined;
  thinking: string;
  approval: "auto" | "ask";
  messages: readonly Message[];
  firstSoundMs: number | undefined;
}>;
type Connection = {
  relay: string;
  viewer: string;
  session: RelaySnapshot["session"];
};
function connection(snapshot: RelaySnapshot): Connection | undefined {
  if (snapshot.status !== "ready" || !snapshot.viewer || !snapshot.scope)
    return;
  const suffix = `:${snapshot.viewer}`;
  if (
    !/^[a-f0-9]{64}$/.test(snapshot.viewer) ||
    !snapshot.scope.endsWith(suffix)
  )
    return;
  try {
    return {
      relay: relayOrigin(snapshot.scope.slice(0, -suffix.length)),
      viewer: snapshot.viewer,
      session: snapshot.session,
    };
  } catch {
    return;
  }
}
const same = (a: Connection | undefined, b: Connection | undefined) =>
  !!a &&
  !!b &&
  a.relay === b.relay &&
  a.viewer === b.viewer &&
  a.session === b.session;

/** Plugin-owned call. A panel is a view, never the owner of a second microphone. */
export function createBestieCall(
  relay: RelayData,
  loadVoice: () => Promise<typeof openVoice> = async () =>
    (await import("./media/voice.mjs")).openVoice,
) {
  let state: CallSnapshot = {
    phase: "idle",
    message: "Start a voice conversation with Bestie.",
    community: connection(relay.snapshot())?.relay,
    muted: false,
    showTranscript: false,
    inputAnalyser: null,
    outputAnalyser: null,
    thinking: "none",
    approval: "auto",
    permission: undefined,
    messages: [],
    firstSoundMs: undefined,
  };
  const listeners = new Set<() => void>();
  let serial = 0,
    approval = 0,
    viewGeneration = 0,
    views = 0,
    disposed = false;
  type ActiveCall = {
    id: number;
    abort: AbortController;
    scope: Connection;
    voice?: Voice | undefined;
    decision?: Voice["decide"] | undefined;
  };
  let active: ActiveCall | undefined;
  let displayedScope = connection(relay.snapshot());
  const publish = (patch: Partial<CallSnapshot>) => {
    state = { ...state, ...patch };
    for (const fn of listeners) fn();
  };
  const current = (id: number) =>
    !disposed &&
    active?.id === id &&
    same(active.scope, connection(relay.snapshot()));
  const add = (message: Omit<Message, "createdAt">) => {
    const messages = [...state.messages];
    const index = messages.findIndex((m) => m.id === message.id);
    const createdAt =
      messages[index]?.createdAt ?? Math.floor(Date.now() / 1000);
    const row = { ...message, createdAt };
    if (index < 0) messages.push(row);
    else messages[index] = row;
    publish({
      messages: messages
        .slice(-40)
        .map((m) => ({ ...m, text: m.text.slice(-16000) })),
    });
  };
  async function end(message = "Conversation ended.") {
    const call = active;
    if (!call) return;
    active = undefined;
    const stopped = ++serial;
    call.decision = undefined;
    // Abort listeners stop microphone tracks before waiting for network cleanup.
    call.abort.abort();
    publish({
      phase: "stopping",
      muted: false,
      inputAnalyser: null,
      outputAnalyser: null,
      permission: undefined,
      message,
    });
    try {
      await call.voice?.stop(false);
    } catch {
      /* Stream closure also stops the host child. */
    }
    if (!disposed && serial === stopped) publish({ phase: "idle", message });
  }
  const unsubscribe = relay.subscribe(() => {
    const next = connection(relay.snapshot());
    if (!same(displayedScope, next)) {
      void end("Community changed. Start a new conversation here.");
      publish({ messages: [], firstSoundMs: undefined });
    }
    displayedScope = next;
    publish({ community: next?.relay });
  });
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    attach() {
      views++;
      viewGeneration++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        views--;
        const revision = ++viewGeneration;
        // Immediate host relocation retains the same call. A hidden/closed Bestie ends it.
        queueMicrotask(() => {
          if (!views && revision === viewGeneration) void end();
        });
      };
    },
    setShowTranscript(showTranscript: boolean) {
      publish({ showTranscript });
    },
    setThinking(thinking: string) {
      if (
        !active &&
        ["none", "minimal", "low", "medium", "high"].includes(thinking)
      )
        publish({ thinking });
    },
    setApproval(approval: string) {
      if (!active && (approval === "auto" || approval === "ask"))
        publish({ approval });
    },
    async start(thinking = state.thinking) {
      if (disposed || active || state.phase === "stopping") return;
      const scope = connection(relay.snapshot());
      if (!scope) {
        publish({
          phase: "error",
          message: "Connect to a community before starting Bestie.",
        });
        return;
      }
      const call: ActiveCall = {
        id: ++serial,
        abort: new AbortController(),
        scope,
      };
      active = call;
      publish({
        phase: "connecting",
        message: "Connecting Bestie…",
        permission: undefined,
        messages: [],
        muted: false,
        inputAnalyser: null,
        outputAnalyser: null,
        firstSoundMs: undefined,
      });
      let assistant = 0,
        received = 0,
        outputItem: unknown,
        finished = false;
      const ui: VoiceUI = {
        evidence() {},
        analyzers(input, output) {
          if (current(call.id))
            publish({ inputAnalyser: input, outputAnalyser: output });
        },
        status(message) {
          if (current(call.id)) publish({ message });
        },
        transcript(text) {
          if (!current(call.id)) return;
          const id = `assistant-${assistant}`;
          add({
            id,
            role: "assistant",
            text: (state.messages.find((m) => m.id === id)?.text ?? "") + text,
          });
        },
        userTranscript(text, id) {
          if (current(call.id)) add({ id, role: "user", text });
        },
        removeInput(id) {
          if (current(call.id))
            publish({ messages: state.messages.filter((m) => m.id !== id) });
        },
        permission(tool, decide) {
          if (!current(call.id)) return;
          call.decision = tool ? decide : undefined;
          publish({
            permission: tool ? { ...tool, request: ++approval } : undefined,
          });
        },
        ended() {
          if (!current(call.id)) return;
          active = undefined;
          publish({
            phase: state.phase === "error" ? "error" : "idle",
            muted: false,
            inputAnalyser: null,
            outputAnalyser: null,
            permission: undefined,
          });
        },
        event(type, data) {
          if (!current(call.id)) return;
          if (type === "ready" || type === "playback_stopped")
            publish({ phase: "listening" });
          if (type === "speech_started") {
            assistant++;
            call.decision = undefined;
            publish({ phase: "listening", permission: undefined });
          }
          if (type === "audio_received") {
            if (outputItem !== data.itemId) {
              outputItem = data.itemId;
              received = 0;
              finished = false;
            }
            received = Math.max(
              received,
              Number(data.startSample) + Number(data.samples),
            );
            publish({ phase: "speaking" });
          }
          if (type === "response_done") finished = true;
          if (type === "played") {
            if (
              Number.isFinite(data.firstSoundLatencyMs) &&
              Number(data.firstSoundLatencyMs) >= 0
            )
              publish({ firstSoundMs: Number(data.firstSoundLatencyMs) });
            if (
              data.itemId === outputItem &&
              finished &&
              Number(data.playedSamples) >= received
            )
              publish({ phase: "listening" });
          }
          if (type === "error")
            publish({
              phase: "error",
              message: String(data.message || "Voice connection failed."),
            });
        },
      };
      try {
        const open = await loadVoice();
        if (!current(call.id)) return;
        const endpoint = `/api/relay/${encodeURIComponent(scope.relay)}/bestie`;
        const voice = await open(crypto.randomUUID(), ui, {
          signal: call.abort.signal,
          eventsUrl: `${endpoint}?op=events&approval=${state.approval}`,
          rpcUrl: `${endpoint}?op=rpc`,
          thinking,
          created(voice) {
            if (current(call.id)) call.voice = voice;
            else void voice.stop(false);
          },
        });
        if (!current(call.id)) {
          await voice.stop(false);
          return;
        }
        call.voice = voice;
      } catch (error) {
        if (active?.id !== call.id) return;
        const stopped = serial + 1;
        const message =
          error instanceof Error ? error.message : "Voice connection failed.";
        await end(message);
        if (
          !disposed &&
          serial === stopped &&
          same(scope, connection(relay.snapshot()))
        )
          publish({ phase: "error", message });
      }
    },
    end,
    mute() {
      if (!active?.voice) return;
      const muted = !state.muted;
      active.voice.setMuted(muted);
      publish({ muted });
    },
    async decide(allow: boolean, request: number) {
      const call = active;
      if (
        !call?.decision ||
        !current(call.id) ||
        state.permission?.request !== request
      )
        return;
      const decision = call.decision;
      call.decision = undefined;
      publish({ permission: undefined });
      try {
        await decision(allow ? "allow_once" : "reject_once");
      } catch (error) {
        if (current(call.id)) {
          await end();
          publish({
            phase: "error",
            message:
              error instanceof Error ? error.message : "Tool decision failed.",
          });
        }
      }
    },
    dispose() {
      unsubscribe();
      disposed = true;
      void end();
      listeners.clear();
    },
  };
}
export type BestieCall = ReturnType<typeof createBestieCall>;
