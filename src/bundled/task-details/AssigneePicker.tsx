import { useEffect, useSyncExternalStore } from "react";
import type { RelaySession } from "../../features/relay/session";
import { Button } from "../../shared/design-system/ui/Button";
import { MentionPicker } from "../mentions/MentionPicker";

export function AssigneePicker({
  session,
  value,
  onChange,
}: {
  session: RelaySession;
  value: string;
  onChange(value: string): void;
}) {
  const library = session.agentLibrary;
  const snapshot = useSyncExternalStore(
    library.subscribe,
    library.snapshot,
    library.snapshot,
  );
  useEffect(() => {
    void library.refresh();
  }, [library]);
  return (
    <>
      <div className="flex items-center gap-2">
        <span>
          Assignee:{" "}
          {snapshot.identities.find((agent) => agent.pubkey === value)?.name ||
            value ||
            "Unassigned"}
        </span>
        <MentionPicker
          session={session}
          agents={snapshot.identities}
          disabled={snapshot.status !== "ready"}
          select={(agent) => {
            onChange(agent.pubkey);
            return true;
          }}
        />
        {value && (
          <Button type="button" onClick={() => onChange("")}>
            Unassign
          </Button>
        )}
      </div>
      {snapshot.status === "loading" && (
        <p role="status">Loading your agents…</p>
      )}
      {snapshot.status === "ready" && !snapshot.identities.length && (
        <p>No agents in your Buzz library.</p>
      )}
      {(snapshot.status === "error" || snapshot.status === "unavailable") && (
        <p role="alert">
          Agent library unavailable.{" "}
          <Button type="button" onClick={() => void library.refresh()}>
            Retry agents
          </Button>
        </p>
      )}
    </>
  );
}
