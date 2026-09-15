import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { RelaySnapshot } from "../../features/relay/service";
import {
  liveAudioRelayUrl,
  signHuddleChallenge,
  startLiveRoomAudio,
} from "./api";

const SAMPLE_RATE = 48_000;
const FRAME_SAMPLES = 960;

export type LiveAudioPeer = Readonly<{
  pubkey: string;
  level: number;
}>;

export type LiveAudioState = Readonly<{
  status: "connecting" | "connected" | "closed" | "error";
  muted: boolean;
  outputMuted: boolean;
  micLevel: number;
  peers: readonly LiveAudioPeer[];
  error?: string;
}>;

export type LiveAudioSession = Readonly<{
  setMuted(muted: boolean): void;
  setOutputMuted(muted: boolean): void;
  leave(): void;
}>;

type PreparedSession = {
  generation: number;
  challenge: string;
};

type NativeAudioState = {
  generation: number;
  status: "connected" | "error";
  peers: LiveAudioPeer[];
  error?: string;
};

type CaptureFrame = {
  samples: Float32Array;
  rms: number;
};

function invokeRawPcm(payload: Float32Array): Promise<unknown> {
  const internals = (
    window as Window & {
      __TAURI_INTERNALS__?: {
        invoke?: (command: string, body: Uint8Array) => Promise<unknown>;
      };
    }
  ).__TAURI_INTERNALS__;
  if (!internals?.invoke)
    return Promise.reject(new Error("Tauri audio IPC is unavailable"));
  return internals.invoke(
    "live_audio_push_pcm",
    new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength),
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function within<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function connectLiveAudio({
  connection,
  roomId,
  roomMembers,
  onState,
  signal,
}: {
  connection: RelaySnapshot;
  roomId: string;
  roomMembers: readonly string[];
  onState(state: LiveAudioState): void;
  signal?: AbortSignal;
}): Promise<LiveAudioSession> {
  if (!isTauri())
    throw new Error("Live audio is available in the Buzz desktop app");

  let stopped = false;
  let generation: number | undefined;
  let stream: MediaStream | undefined;
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let capture: AudioWorkletNode | undefined;
  let silent: GainNode | undefined;
  let unlisten: UnlistenFn | undefined;
  let muted = true;
  let outputMuted = false;
  let nativeConnected = false;
  let micLevel = 0;
  let peers: readonly LiveAudioPeer[] = [];
  let lastMeterAt = 0;
  let state: LiveAudioState = {
    status: "connecting",
    muted,
    outputMuted,
    micLevel,
    peers,
  };

  const publish = (patch: Partial<LiveAudioState> = {}) => {
    state = Object.freeze({
      ...state,
      ...patch,
      muted,
      outputMuted,
      micLevel,
      peers,
    });
    onState(state);
  };
  const cleanup = (next?: Partial<LiveAudioState>) => {
    const firstCleanup = !stopped;
    stopped = true;
    nativeConnected = false;
    micLevel = 0;
    peers = [];
    signal?.removeEventListener("abort", abortJoin);
    if (capture) capture.port.onmessage = null;
    source?.disconnect();
    capture?.disconnect();
    silent?.disconnect();
    stream?.getTracks().forEach((track) => {
      track.stop();
    });
    void context?.close();
    unlisten?.();
    unlisten = undefined;
    if (generation !== undefined)
      void invoke("live_audio_leave", { generation }).catch(() => {});
    if (firstCleanup) publish(next ?? { status: "closed" });
  };
  const abortJoin = () => cleanup({ status: "closed", peers: [] });
  signal?.addEventListener("abort", abortJoin, { once: true });
  publish();

  try {
    signal?.throwIfAborted();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    signal?.throwIfAborted();
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error("No microphone was available");
    track.enabled = false;

    context = new AudioContext({ sampleRate: SAMPLE_RATE });
    if (context.sampleRate !== SAMPLE_RATE)
      throw new Error("Live audio requires a 48 kHz audio context");
    if (context.state === "suspended") await context.resume();
    await context.audioWorklet.addModule("/rooms-capture-worklet.js");
    signal?.throwIfAborted();
    source = context.createMediaStreamSource(stream);
    capture = new AudioWorkletNode(context, "buzz-live-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { frameSamples: FRAME_SAMPLES },
    });
    silent = context.createGain();
    silent.gain.value = 0;
    source.connect(capture);
    capture.connect(silent);
    silent.connect(context.destination);
    capture.port.onmessage = (event: MessageEvent<CaptureFrame>) => {
      if (stopped || !event.data?.samples) return;
      micLevel = muted ? 0 : Math.max(0, Math.min(1, event.data.rms));
      const now = performance.now();
      if (now - lastMeterAt >= 50) {
        lastMeterAt = now;
        publish();
      }
      if (nativeConnected && !muted)
        void invokeRawPcm(event.data.samples).catch(() => {});
    };

    const started = await within(
      startLiveRoomAudio(connection, roomId, roomMembers),
      12_000,
      "Buzz couldn’t start room audio. Try again.",
    );
    const prepared = await within(
      invoke<PreparedSession>("live_audio_prepare", {
        relayUrl: liveAudioRelayUrl(connection),
        roomId: started.audioRoomId,
        parentRoomId: roomId,
      }),
      7_000,
      "The audio relay didn’t respond. Try again.",
    );
    generation = prepared.generation;
    signal?.throwIfAborted();

    unlisten = await listen<NativeAudioState>("live-audio-state", (event) => {
      if (stopped || event.payload.generation !== generation) return;
      peers = Object.freeze(event.payload.peers);
      if (event.payload.status === "error") {
        cleanup({
          status: "error",
          error: event.payload.error ?? "Live audio disconnected",
          peers: [],
        });
      } else {
        publish({ status: "connected" });
      }
    });
    const authEvent = await within(
      signHuddleChallenge(
        connection,
        prepared.challenge,
        signal ?? new AbortController().signal,
      ),
      7_000,
      "Buzz couldn’t authorize room audio. Try again.",
    );
    signal?.throwIfAborted();
    const joined = await within(
      invoke<NativeAudioState>("live_audio_authenticate", {
        generation,
        authEvent,
      }),
      12_000,
      "The audio session didn’t finish connecting. Try again.",
    );
    signal?.throwIfAborted();
    peers = Object.freeze(joined.peers);
    nativeConnected = true;
    publish({ status: "connected" });

    return Object.freeze({
      setMuted(next: boolean) {
        if (stopped) return;
        muted = next;
        track.enabled = !next;
        if (next) micLevel = 0;
        publish();
      },
      setOutputMuted(next: boolean) {
        if (stopped || generation === undefined) return;
        outputMuted = next;
        publish();
        void invoke("live_audio_set_output_muted", {
          generation,
          muted: next,
        }).catch((error) => {
          cleanup({ status: "error", error: errorMessage(error), peers: [] });
        });
      },
      leave() {
        cleanup({ status: "closed", peers: [] });
      },
    });
  } catch (error) {
    cleanup({ status: "closed", peers: [] });
    throw error;
  }
}
