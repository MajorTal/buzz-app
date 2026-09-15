import {
  IconChevronDown,
  IconPlayerStop,
  IconRefresh,
  IconTerminal2,
} from "@tabler/icons-react";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  PanelProps,
  ChannelPanelContext,
} from "../../features/panels/service";
import type { TerminalSessions } from "./sessions";
import styles from "./Terminal.module.css";

export function TerminalPanel({
  channelContext,
  close,
  sessions,
}: PanelProps & { sessions: TerminalSessions }) {
  if (!channelContext) throw new Error("Terminal requires a channel context");
  return <Content context={channelContext} close={close} sessions={sessions} />;
}
function Content({
  context,
  close,
  sessions,
}: {
  context: ChannelPanelContext;
  close(): void;
  sessions: TerminalSessions;
}) {
  const version = useSyncExternalStore(
    sessions.subscribe,
    sessions.snapshot,
    sessions.snapshot,
  );
  const entry = sessions.get(context);
  const host = useRef<HTMLDivElement>(null);
  const hide = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const attempted = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;
    try {
      sessions.ensure(context);
    } catch (error) {
      setError(String(error));
    }
  }, [context, sessions]);
  useEffect(() => {
    if (entry?.screen && host.current) return entry.screen.mount(host.current);
  }, [entry?.screen]);
  const end = async (restart: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await sessions.end(context);
      if (restart && mounted.current) sessions.ensure(context);
    } catch (error) {
      if (mounted.current) setError(String(error));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <div
      data-buzz-ui=""
      className={styles.panel}
      data-terminal-version={version}
    >
      <PanelHeader
        variant="compact"
        icon={
          <IconTerminal2
            size={16}
            aria-hidden="true"
            style={{ flexShrink: 0 }}
          />
        }
        title={
          <div className={styles.identity}>
            <h2 className="text-label text-primary">BuzzTerm</h2>
            <span
              className="text-body-sm text-secondary"
              title={entry?.context.channelId ?? context.channelId}
            >
              #{entry?.context.channelName ?? context.channelName}
            </span>
            {entry?.context.threadId && (
              <span
                className="text-mono-sm text-secondary font-mono"
                title={entry.context.threadId}
              >
                Thread {entry.context.threadId.slice(0, 8)}
              </span>
            )}
            <span className="text-body-sm text-secondary">
              {entry?.status ?? (sessions.available ? "ended" : "desktop only")}
            </span>
          </div>
        }
        actions={
          <>
            {sessions.available &&
              (entry ? (
                <IconButton
                  size="toolbar"
                  disabled={busy}
                  onClick={() => void end(true)}
                  aria-label="Restart"
                  title="Restart terminal"
                  icon={<IconRefresh size={16} aria-hidden="true" />}
                />
              ) : (
                <Button
                  size="compact"
                  disabled={busy}
                  onClick={() => void end(true)}
                >
                  Start session
                </Button>
              ))}
            {entry && (
              <IconButton
                size="toolbar"
                disabled={busy}
                onClick={(event) => {
                  // Move focus before End removes/disables its own control.
                  // No post-await focus change can steal a later destination.
                  if (document.activeElement === event.currentTarget)
                    hide.current?.focus();
                  void end(false);
                }}
                aria-label="End session"
                title="End session"
                icon={<IconPlayerStop size={16} aria-hidden="true" />}
              />
            )}
            <IconButton
              size="toolbar"
              ref={hide}
              onClick={close}
              aria-label="Hide terminal"
              title="Hide terminal (Cmd/Ctrl+J)"
              icon={<IconChevronDown size={16} aria-hidden="true" />}
            />
          </>
        }
      />
      {!sessions.available ? (
        <p className={`${styles.notice} text-body`}>
          Open Buzz Desktop to use your local shell. The browser cannot start a
          terminal on your computer.
        </p>
      ) : (
        <>
          {(error || entry?.error) && (
            <p
              className={`${styles.notice} text-body text-red-12`}
              role="alert"
            >
              {error ?? entry?.error}
            </p>
          )}
          {entry?.status === "starting" && (
            <p className={`${styles.notice} text-body`} role="status">
              Starting your login shell…
            </p>
          )}
          {!entry && (
            <p className={`${styles.notice} text-body`}>
              Session ended. Start a new shell to use this channel’s current
              context.
            </p>
          )}
          <div className={styles.screen} ref={host} />
        </>
      )}
    </div>
  );
}
