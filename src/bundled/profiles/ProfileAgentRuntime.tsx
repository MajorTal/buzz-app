import { useEffect, useState, useSyncExternalStore } from "react";
import type { AgentControl } from "../../features/agents/control";
import type { OpenResult } from "../../features/navigation/controller";
import { exactProfileAgent } from "../../features/profiles/instance-target";
import { agentProcessLabel } from "../agents/agent-edit";
import { AgentEditor } from "../agents/AgentEditor";
import { Button } from "../../shared/design-system/ui/Button";
import styles from "./Profiles.module.css";

/** Native status and saved-settings summary for this exact key in the active
 * community. The verified owner can open the existing editor in place when the
 * native identity is unambiguous; the caller supplies ownership evidence. */
export function ProfileAgentRuntime({
  control,
  onOpenHarnesses,
  scope,
  pubkey,
  instanceId,
  owned = false,
}: {
  control: AgentControl;
  onOpenHarnesses?: (() => Promise<OpenResult>) | undefined;
  scope: string;
  pubkey: string;
  instanceId?: string | undefined;
  owned?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const state = useSyncExternalStore(
    control.subscribe,
    control.snapshot,
    control.snapshot,
  );
  useEffect(() => {
    void control.refresh();
  }, [control]);
  const data = state.data;
  const uniqueAgent = data
    ? exactProfileAgent(data.agents, scope, pubkey)
    : undefined;
  const agent = data
    ? exactProfileAgent(data.agents, scope, pubkey, instanceId)
    : undefined;
  if (!data || !agent) return null;
  const drift =
    agent.runningRevision !== null && agent.runningRevision !== agent.revision;
  const facts = [
    ["Harness", agent.harness.command],
    ["Provider", agent.harness.provider],
    ["Model", agent.harness.model],
    ["Workspace", agent.workspace],
  ].filter(([, value]) => value);
  return (
    <section aria-label="Local agent" className={styles.runtime}>
      <h3 className="text-body">Local agent</h3>
      <p role="status">{agentProcessLabel(agent)}</p>
      {drift && (
        <p>
          Saved revision {agent.revision} is not running yet (running revision{" "}
          {agent.runningRevision}). Restart from Agents to apply.
        </p>
      )}
      {!!facts.length && (
        <>
          <p className="text-body-sm text-subtle">
            Saved settings; environment overrides may apply.
          </p>
          <dl>
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt className="text-body-sm text-subtle">{label}</dt>
                <dd className="font-mono text-mono">{value}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {owned && uniqueAgent?.id === agent.id && state.status === "ready" && (
        <Button
          size="compact"
          variant="subtle"
          aria-haspopup="dialog"
          disabled={state.busy}
          onClick={() => setEditing(true)}
        >
          Agent instructions
        </Button>
      )}
      {!!agent.diagnostics.length && (
        <details>
          <summary>Host diagnostics</summary>
          <pre className="font-mono text-mono">
            {agent.diagnostics.join("\n")}
          </pre>
        </details>
      )}
      {editing && owned && uniqueAgent?.id === agent.id && (
        <AgentEditor
          agent={agent}
          control={control}
          state={state}
          onClose={() => setEditing(false)}
          onOpenHarnesses={
            onOpenHarnesses
              ? () => {
                  void onOpenHarnesses().then((result) => {
                    if (result.status === "opened") setEditing(false);
                  });
                }
              : undefined
          }
        />
      )}
    </section>
  );
}
