import { useCallback, useLayoutEffect, useRef } from "react";
import { useAgentControl } from "../../features/agents/control-react";
import {
  canStopAgent,
  agentLaunchBlock,
  type AgentAction,
  type AgentControl,
} from "../../features/agents/control";
import { exactProfileAgent } from "../../features/profiles/instance-target";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import { Button } from "../../shared/design-system/ui/Button";

/** Observe the app-owned controller; profile metadata never grants control. */
export function ProfileAgentActions({
  control,
  relay,
  pubkey,
  instanceId,
}: {
  control: AgentControl;
  relay: RelayData;
  pubkey: string;
  instanceId?: string | undefined;
}) {
  const connection = useRelayConnection(relay);
  const state = useAgentControl(control);
  const stopButton = useRef<HTMLButtonElement>(null);
  const restoreStartFocus = useRef(false);
  const startRef = useCallback((node: HTMLButtonElement | null) => {
    if (!node) return;
    // Capture focus before React removes Start, not after it falls back to body.
    return () => {
      restoreStartFocus.current = document.activeElement === node;
    };
  }, []);
  useLayoutEffect(() => {
    if (restoreStartFocus.current && document.activeElement === document.body)
      stopButton.current?.focus();
    restoreStartFocus.current = false;
  });
  if (connection.status !== "ready" || !connection.scope) return null;
  const agent = exactProfileAgent(
    state.data?.agents ?? [],
    connection.scope,
    pubkey,
    instanceId,
  );
  if (!agent && (state.status !== "error" || state.data)) return null;
  const startBlock = agent ? agentLaunchBlock(state, agent) : null;
  const act = (action: AgentAction) => {
    // A retired presentation cannot dispatch into a newly selected community.
    if (!agent || relay.snapshot() !== connection) return;
    const current = control.snapshot();
    if (action === "stop" ? !canStopAgent(current, agent.id) : !!startBlock)
      return;
    void control.action(agent.id, action).catch(() => {});
  };
  return (
    <section aria-label="Local agent actions" className="flex flex-col gap-2">
      {agent && (
        <>
          <div className="flex flex-wrap gap-2">
            {(agent.status === "stopped" || agent.status === "failed") && (
              <Button
                size="compact"
                ref={startRef}
                focusableWhenDisabled
                disabled={!!startBlock}
                onClick={() => act("start")}
              >
                {agent.status === "failed" ? "Retry start" : "Start"}
              </Button>
            )}
            <Button
              ref={stopButton}
              size="compact"
              focusableWhenDisabled
              disabled={!canStopAgent(state, agent.id)}
              onClick={() => act("stop")}
            >
              Stop
            </Button>
            <Button
              size="compact"
              focusableWhenDisabled
              disabled={!!startBlock}
              onClick={() => act("restart")}
            >
              Restart
            </Button>
          </div>
          {startBlock && (
            <p className="text-body-sm text-secondary">{startBlock}</p>
          )}
          {agent.error && <p role="alert">{agent.error}</p>}
        </>
      )}
      {state.error && <p role="alert">{state.error}</p>}
      {state.status === "error" && (
        <>
          {agent && (
            <p className="text-body-sm text-secondary">
              Showing the last host snapshot. Current process state and durable
              enabled intent are unconfirmed.
            </p>
          )}
          <Button
            size="compact"
            disabled={state.busy}
            onClick={() => void control.refresh()}
          >
            Retry status
          </Button>
        </>
      )}
      {state.busy && <p role="status">Waiting for the host to confirm…</p>}
    </section>
  );
}
