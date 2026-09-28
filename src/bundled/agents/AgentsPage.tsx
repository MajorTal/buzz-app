import { useIdentityNames } from "../../features/identity-names/react";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { PageProps } from "../../features/pages/service";
import type { OpenTarget } from "../../features/navigation/targets";
import type { OpenResult } from "../../features/navigation/controller";
import { editAgentRoute } from "./edit-route";
import type {
  AgentControl,
  AgentControlState,
  AgentView,
} from "../../features/agents/control";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import { relayOrigin } from "../../features/communities/destination";
import { useRelayConnection } from "../../features/relay/react";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import { AgentLibrary } from "./AgentLibrary";
import { Button } from "../../shared/design-system/ui/Button";
import { AgentCard } from "./AgentCard";
import { AgentControlPanel } from "./AgentControlPanel";
import { ManagedAgentActions } from "./ManagedAgentActions";

export function AgentsPage({
  relay,
  control,
  navigation,
  open,
}: PageProps & {
  relay: RelayData;
  control?: AgentControl;
  open?: (
    target: OpenTarget,
    options?: { replace?: boolean },
  ) => Promise<OpenResult>;
}) {
  const connection = useRelayConnection(relay);
  const resolveName = useIdentityNames(connection.session.names);
  const request = useMemo(
    () => navigation?.forSession(relay, connection),
    [navigation, relay, connection],
  );
  const target = request?.target;
  const editTarget =
    target?.kind === "page" && target.route
      ? editAgentRoute(target.route.params)
      : null;
  useEffect(() => {
    if (!request || request.signal.aborted) return;
    // The routed edit destination must not acknowledge an unrelated page.
    if (target?.kind !== "page") return;
    if (!editTarget && !target.route) request.complete({ status: "opened" });
    else if (!editTarget)
      request.complete({ status: "failed", reason: "unavailable" });
    else if (
      !control ||
      (connection.status !== "ready" && connection.status !== "connecting")
    )
      request.complete({ status: "failed", reason: "unavailable" });
  }, [request, target, editTarget, control, connection.status]);
  let importDestination = "";
  if (
    connection.viewer &&
    connection.scope?.endsWith(`:${connection.viewer}`)
  ) {
    try {
      importDestination = relayOrigin(
        connection.scope.slice(0, -(connection.viewer.length + 1)),
      );
    } catch {
      // A non-URL fixture or unavailable connection needs an explicit destination.
    }
  }
  const library =
    connection.status === "ready" ? (
      <AgentLibrary
        key={`${connection.scope}:${connection.generation}`}
        session={connection.session}
      />
    ) : (
      <div>
        <p>Connect to a community to browse the old library.</p>
        {connection.status === "error" && (
          <Button onClick={() => relay.retry()}>Retry connection</Button>
        )}
      </div>
    );
  return (
    <div className="h-full min-h-0">
      <FullPageSurface aria-label="Agents">
        <div className="flex h-full min-h-0 flex-col">
          <PanelHeader title="Agents" />
          <div className="min-h-0 flex-1 overflow-auto p-panel-inset text-body">
            <div className="mx-auto flex max-w-6xl flex-col gap-panel-gap">
              {control ? (
                <AgentControlPanel
                  control={control}
                  editTarget={editTarget}
                  onOpenHarnesses={
                    open
                      ? () => {
                          void open({
                            version: 1,
                            kind: "settings",
                            section: "agents",
                          });
                        }
                      : undefined
                  }
                  {...(editTarget && request && connection.status === "ready"
                    ? { editRequest: request }
                    : {})}
                  onCloseTarget={() => {
                    if (target?.kind === "page" && open)
                      void open(
                        {
                          version: 1,
                          kind: "page",
                          pluginId: target.pluginId,
                          pageId: target.pageId,
                          ...(target.scope !== undefined
                            ? { scope: target.scope }
                            : {}),
                        },
                        { replace: true },
                      );
                  }}
                  resolveName={resolveName}
                  importDestination={importDestination}
                  createOwner={
                    connection.status === "ready"
                      ? connection.viewer
                      : undefined
                  }
                >
                  {(state, edit, duplicate, remove, importedId, label) =>
                    state.status === "unavailable" ? (
                      library
                    ) : (
                      <ManagedAgents
                        key={`${connection.scope}:${connection.generation}`}
                        state={state}
                        label={label}
                        edit={edit}
                        duplicate={duplicate}
                        remove={remove}
                        importedId={importedId}
                        control={control}
                        connection={connection}
                      />
                    )
                  }
                </AgentControlPanel>
              ) : (
                <>
                  <p className="text-secondary">
                    Open the desktop app to import and run agents. You can still
                    mention existing channel members.
                  </p>
                  {library}
                </>
              )}
            </div>
          </div>
        </div>
      </FullPageSurface>
    </div>
  );
}
function ManagedAgents({
  state,
  edit,
  duplicate,
  remove,
  importedId,
  control,
  connection,
  label,
}: {
  label(agent: AgentView): string;
  state: AgentControlState;
  edit(agent: AgentView, avatar?: string): void;
  duplicate(agent: AgentView): void;
  remove(agent: AgentView): void;
  importedId: string | null;
  control: AgentControl;
  connection: RelaySnapshot;
}) {
  const library = connection.session.agentLibrary;
  const snapshot = useSyncExternalStore(
    library.subscribe,
    library.snapshot,
    library.snapshot,
  );
  useEffect(() => {
    if (connection.status === "ready") void library.refresh();
  }, [library, connection.status]);
  return (
    <section aria-label="My agents" className="flex flex-col gap-4">
      <h2 className="sr-only">My agents</h2>
      <p className="m-0 text-body-sm text-secondary">
        Mention an agent in a channel to add it and start it. Stop old Buzz and
        its listeners before using an imported identity here.
      </p>
      {state.data?.agents.length === 0 && (
        <p>No agents yet. Create an agent or import one from old Buzz below.</p>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-4">
        {state.data?.agents.map((agent) => {
          const identity = snapshot.identities.find(
            (entry) => entry.pubkey === agent.pubkey,
          );
          const avatar =
            identity?.avatar ??
            snapshot.definitions.find(
              (entry) => entry.id === identity?.definitionId,
            )?.avatar;
          return (
            <AgentCard
              key={agent.id}
              name={label(agent)}
              avatar={avatar}
              identities={[agent]}
              session={connection.session}
              editable={[agent]}
              onEdit={edit}
              onDuplicate={duplicate}
              onDelete={control.delete ? remove : undefined}
            >
              <ManagedAgentActions
                agent={agent}
                state={state}
                control={control}
                imported={agent.id === importedId}
              />
            </AgentCard>
          );
        })}
      </div>
    </section>
  );
}
