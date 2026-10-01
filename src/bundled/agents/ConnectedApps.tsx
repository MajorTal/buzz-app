import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentAppsHost, ConnectedApp } from "../../features/agents/apps";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";

/**
 * Apps this agent uses as tools. The agent can also connect apps itself (for
 * example one it just deployed); every change reaches it in its next conversation.
 */
export function ConnectedApps({
  agentId,
  host,
}: {
  agentId: string;
  host: AgentAppsHost;
}) {
  const [apps, setApps] = useState<ConnectedApp[] | null>(null);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only the newest request for the current agent may write state.
  const generation = useRef(0);
  const run = useCallback(
    (operation: () => Promise<ConnectedApp[]>, onDone?: () => void) => {
      const current = ++generation.current;
      setBusy(true);
      setError(null);
      operation()
        .then((next) => {
          if (current !== generation.current) return;
          setApps(next);
          onDone?.();
        })
        .catch((problem: unknown) => {
          if (current !== generation.current) return;
          setError(
            problem instanceof Error ? problem.message : String(problem),
          );
        })
        .finally(() => {
          if (current === generation.current) setBusy(false);
        });
    },
    [],
  );
  useEffect(() => {
    setApps(null);
    run(() => host.list(agentId));
    return () => {
      generation.current++;
    };
  }, [agentId, host, run]);
  const connect = () => {
    if (!url.trim() || busy) return;
    run(
      () => host.connect(agentId, url.trim(), name.trim() || undefined),
      () => {
        setUrl("");
        setName("");
      },
    );
  };
  // Enter connects here instead of submitting the surrounding settings form.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    connect();
  };
  return (
    <div className="space-y-4">
      <p className="text-body-sm text-subtle">
        Apps this agent can use as tools. It can connect a run402 app it deploys
        on its own. Changes reach it in its next conversation.
      </p>
      {apps === null ? (
        !error && <p className="text-body-sm text-subtle">Loading apps…</p>
      ) : apps.length === 0 ? (
        <p className="text-body-sm text-subtle">No connected apps.</p>
      ) : (
        <ul className="space-y-3" aria-label="Connected apps">
          {apps.map((app) => (
            <li key={app.name} className="flex items-start gap-3">
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-label">
                  {app.name}{" "}
                  <span className="text-body-sm text-subtle">
                    · added by {app.added_by === "agent" ? "the agent" : "you"}
                  </span>
                </p>
                <p className="break-all text-mono text-body-sm">{app.url}</p>
              </div>
              <Button
                disabled={busy}
                aria-label={`Disconnect ${app.name}`}
                onClick={() => run(() => host.disconnect(agentId, app.name))}
              >
                Disconnect
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Field
        label="App MCP URL"
        description="https://<app>.run402.com/… or https://<app>.run402.app/…"
      >
        <Input
          disabled={busy}
          value={url}
          placeholder="https://buzz-todo.run402.com/api/mcp"
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </Field>
      <Field
        label="Name (optional)"
        description="Tool prefix; defaults to the app's host name"
      >
        <Input
          disabled={busy}
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </Field>
      <Button disabled={busy || !url.trim()} onClick={connect}>
        Connect app
      </Button>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
