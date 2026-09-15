import { useState, useRef, useEffect } from "react";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelSummary } from "../../features/relay/contracts";
import { useChannelList } from "../../features/relay/react";
import { AgentChoice } from "../../features/sessions/AgentChoice";
import styles from "../../features/sessions/Sessions.module.css";

export function SessionActions({
  session,
  channel,
}: {
  session: RelaySession;
  channel: ChannelSummary;
}) {
  const list = useChannelList(session.channels);
  const current = useRef(channel);
  current.current = channel;
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const [open, setOpen] = useState(false);
  const [agent, setAgent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [operation, setOperation] = useState<string>();
  async function apply() {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      if (channel.parentChannelId) {
        await session.agentLibrary.refresh();
        await session.workSessions.addAgents(
          channel.id,
          [agent],
          () =>
            live.current &&
            current.current.id === channel.id &&
            current.current.parentChannelId === channel.parentChannelId,
        );
        if (!live.current || current.current.id !== channel.id) return;
        setOpen(false);
        setAgent("");
        return;
      }
      const id = operation ?? session.workSessions.invite(channel.id, agent);
      setOperation(id);
      await session.workSessions.delivered(id);
      await session.workSessions.refresh(channel.id, { member: agent });
      setOpen(false);
      setOperation(undefined);
      setAgent("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  if (channel.archived) return null;
  return (
    <div className={styles.actions}>
      {!open ? (
        <button type="button" onClick={() => setOpen(true)}>
          Invite an agent
        </button>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void apply();
          }}
        >
          <AgentChoice
            side="bottom"
            session={session}
            value={agent}
            onChange={setAgent}
            disabled={busy || !!operation}
            allowed={channel.parentChannelId ? channel.members : undefined}
            parentName={
              list.channels.find((item) => item.id === channel.parentChannelId)
                ?.name
            }
          />
          {error && <p role="alert">{error}</p>}
          <div>
            <button type="submit" disabled={busy || !agent}>
              {busy ? "Saving…" : operation ? "Retry" : "Invite"}
            </button>
            <button
              type="button"
              disabled={busy || !!operation}
              onClick={() => {
                setOpen(false);
                setError(undefined);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
