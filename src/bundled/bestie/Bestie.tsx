import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  IconMicrophone,
  IconMicrophoneOff,
  IconPhone,
  IconPhoneOff,
} from "@tabler/icons-react";
import { Transcript } from "./Transcript";
import { PanelHeaderActions } from "../../features/panels/PanelHeaderActions";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Button } from "../../shared/design-system/ui/Button";
import type { BestieCall } from "./call";
import { CallSettings } from "./CallSettings";
import { VoiceWave } from "./VoiceWave";
import { SpeakingAvatar } from "./SpeakingAvatar";
import styles from "./Bestie.module.css";

export function Bestie({
  call,
  available,
}: {
  call: BestieCall;
  available: boolean;
}) {
  const state = useSyncExternalStore(
    call.subscribe,
    call.snapshot,
    call.snapshot,
  );
  useLayoutEffect(() => call.attach(), [call]);
  const [instantControls, setInstantControls] = useState(false);
  const controls = useRef<HTMLElement>(null);
  const restoreFocus = useRef(false);
  const permission = state.permission;
  const connected = state.phase === "listening" || state.phase === "speaking";
  const busy =
    connected || state.phase === "connecting" || state.phase === "stopping";
  useLayoutEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    controls.current
      ?.querySelector<HTMLButtonElement>(
        busy
          ? '[aria-label="End Bestie conversation"]'
          : '[aria-label="Start Bestie voice conversation"]',
      )
      ?.focus();
  }, [busy]);
  const status = !available
    ? "Voice isn’t available in this app."
    : !state.community
      ? "Choose a community to call Bestie."
      : state.message === "Conversation ended." ||
          state.message.startsWith("Listening through ")
        ? ""
        : state.message;
  return (
    <section
      data-buzz-ui=""
      className={`${styles.panel} text-body`}
      aria-label="Bestie conversation"
    >
      <PanelHeaderActions>
        <CallSettings call={call} state={state} busy={busy} />
      </PanelHeaderActions>
      <div className={styles.body} data-transcript={state.showTranscript}>
        <div className={styles.identity}>
          <SpeakingAvatar analyser={state.outputAnalyser} />
          <p role="status" className={`${styles.status} text-body-sm`}>
            {status}
          </p>
        </div>
        {state.showTranscript && <Transcript messages={state.messages} />}
      </div>
      {permission && (
        <section
          className={styles.permission}
          aria-label="Bestie tool approval"
        >
          <h3 className="text-body font-medium">
            {permission.title || "Approve tool call?"}
          </h3>
          <pre>
            {JSON.stringify(permission.rawInput ?? permission, null, 2)}
          </pre>
          <div className={styles.decisions}>
            <Button
              onClick={() => {
                void call.decide(false, permission.request);
              }}
            >
              Deny
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                void call.decide(true, permission.request);
              }}
            >
              Allow once
            </Button>
          </div>
        </section>
      )}
      <footer
        ref={controls}
        className={styles.controls}
        data-active={busy}
        data-instant={instantControls}
        onPointerDownCapture={() => setInstantControls(false)}
        onKeyDownCapture={() => setInstantControls(true)}
      >
        <div className={styles.callControls} inert={!busy} aria-hidden={!busy}>
          <span className={styles.muteControl}>
            <IconButton
              icon={
                state.muted ? (
                  <IconMicrophoneOff size={20} />
                ) : (
                  <IconMicrophone size={20} />
                )
              }
              variant="quiet"
              size="default"
              shape="control"
              disabled={!connected}
              aria-label={
                state.muted
                  ? "Unmute Bestie microphone"
                  : "Mute Bestie microphone"
              }
              aria-pressed={state.muted}
              onClick={call.mute}
            />
          </span>
          <VoiceWave
            analyser={state.inputAnalyser}
            muted={state.muted || !connected}
          />
          <span className={styles.hangup}>
            <IconButton
              icon={<IconPhoneOff size={20} />}
              variant="quiet"
              size="default"
              shape="control"
              aria-label="End Bestie conversation"
              disabled={state.phase === "stopping"}
              onClick={(event) => {
                restoreFocus.current = event.detail === 0;
                setInstantControls(event.detail === 0);
                void call.end();
              }}
            />
          </span>
        </div>
        <div className={styles.callStart} inert={busy} aria-hidden={busy}>
          <Button
            variant="quiet"
            aria-label="Start Bestie voice conversation"
            disabled={!available || !state.community}
            onClick={(event) => {
              restoreFocus.current = event.detail === 0;
              setInstantControls(event.detail === 0);
              void call.start();
            }}
          >
            <IconPhone size={18} aria-hidden="true" />
            Call
          </Button>
        </div>
      </footer>
    </section>
  );
}
