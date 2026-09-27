import type { useIdentityNames } from "../../features/identity-names/react";
import {
  useAgentControl,
  useAgentControlRefresh,
} from "../../features/agents/control-react";
import { sameCommunityAgents } from "../../features/agents/choices";
import type { PageNavigation } from "../../features/navigation/service";
import { useEffect, useState, type ReactNode } from "react";
import type {
  AgentControl,
  AgentControlState,
  AgentView,
} from "../../features/agents/control";
import { PlusIcon } from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { AgentCard } from "./AgentCard";
import { AgentEditor } from "./AgentEditor";
import { AgentImport } from "./AgentImport";
import { AgentCreateDialog } from "./AgentCreateDialog";
import { AgentDeleteDialog } from "./AgentDeleteDialog";
import "./AgentControls.css";

/** No relay dependency. Page lifetime owns observation only, never native execution. */
export function AgentControlPanel({
  control,
  importDestination = "",
  createOwner,
  resolveName,
  children,
  editTarget,
  editRequest,
  onCloseTarget,
}: {
  resolveName?: ReturnType<typeof useIdentityNames>;
  control: AgentControl;
  importDestination?: string;
  createOwner?: string | undefined;
  editTarget?: string | null;
  editRequest?: PageNavigation;
  onCloseTarget?: () => void;
  children?: (
    state: AgentControlState,
    edit: (agent: AgentView, avatar?: string) => void,
    duplicate: (agent: AgentView) => void,
    remove: (agent: AgentView) => void,
    importedId: string | null,
    label: (agent: AgentView) => string,
  ) => ReactNode;
}) {
  const [adding, setAdding] = useState<{
    destination: string;
    owner: string;
    source?: AgentView;
  } | null>(null);
  const [importSections, setImportSections] = useState<string[]>([]);
  const [importedId, setImportedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<{
    id: string;
    avatar?: string;
  } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const edit = (agent: AgentView, avatar?: string) => {
    setSelected({ id: agent.id, ...(avatar ? { avatar } : {}) });
    if (editTarget) onCloseTarget?.();
  };
  const duplicate = (agent: AgentView) =>
    setAdding({
      destination: agent.relayUrl,
      owner: createOwner ?? "",
      source: agent,
    });
  const remove = (agent: AgentView) => setDeleting(agent.id);
  useAgentControlRefresh(control);
  const state = useAgentControl(control);
  useEffect(() => {
    if (
      state.data?.agents.some(
        (agent) => agent.id === importedId && agent.enabled,
      )
    )
      setImportedId(null);
  }, [state.data, importedId]);
  const facts =
    state.data?.agents.map((agent) => ({
      pubkey: agent.pubkey,
      name: agent.name,
      isAgent: true,
    })) ?? [];
  const candidates = facts.map((agent) => agent.pubkey);
  // One identity may have separate configurations in different communities.
  // The edited row supplies its own configured name; control still uses agent.id.
  const label = (agent: AgentView) =>
    resolveName?.(agent.pubkey, agent.name, candidates, [
      ...facts,
      { pubkey: agent.pubkey, name: agent.name, isAgent: true },
    ]) ?? agent.name;
  // Route selection takes precedence over card-local editing. Never guess among
  // multiple native records for the same public identity in this community.
  const routed =
    editTarget && importDestination && createOwner
      ? sameCommunityAgents(
          state.data?.agents ?? [],
          `${importDestination}:${createOwner}`,
        ).filter((agent) => agent.pubkey === editTarget)
      : [];
  const editing = editTarget
    ? routed.length === 1
      ? routed[0]
      : undefined
    : state.data?.agents.find((agent) => agent.id === selected?.id);
  useEffect(() => {
    if (
      !editRequest ||
      editRequest.signal.aborted ||
      state.status === "loading" ||
      state.status === "idle"
    )
      return;
    if (state.status !== "ready") {
      editRequest.complete({ status: "failed", reason: "unavailable" });
    } else if (editing) {
      editRequest.complete({ status: "opened" });
    } else {
      editRequest.complete({ status: "failed", reason: "not-found" });
    }
  }, [editRequest, editing, state.status]);
  const deletion = state.data?.agents.find((agent) => agent.id === deleting);
  return (
    <section
      data-buzz-ui=""
      aria-label="Local agent controls"
      className="agent-controls flex min-w-0 flex-col gap-section-gap text-body text-primary"
    >
      {state.data && (
        <div className="flex justify-end">
          <Button
            variant="primary"
            aria-haspopup="dialog"
            onClick={() =>
              setAdding({
                destination: importDestination,
                owner: createOwner ?? "",
              })
            }
          >
            <PlusIcon size={16} aria-hidden="true" />
            Add agent
          </Button>
        </div>
      )}
      {(state.status === "idle" || state.status === "loading") && (
        <p role="status">Reading local agent status…</p>
      )}
      {state.error && (
        <p role={state.status === "unavailable" ? "status" : "alert"}>
          {state.error}
        </p>
      )}
      {state.status === "error" && state.data && (
        <p className="text-body-sm text-secondary">
          Showing the last host snapshot. Current process state and durable
          enabled intent are unconfirmed. Status retries automatically while
          this page is visible; actions are never repeated automatically.
        </p>
      )}
      {state.status === "error" && (
        <Button onClick={() => void control.refresh()}>Retry status</Button>
      )}
      {state.busy && <p role="status">Waiting for the host to confirm…</p>}
      {children ? (
        children(state, edit, duplicate, remove, importedId, label)
      ) : (
        <div className="agent-grid">
          {state.data?.agents.map((agent) => (
            <AgentCard
              key={agent.id}
              name={label(agent)}
              identities={[agent]}
              editable={[agent]}
              onEdit={edit}
              onDuplicate={duplicate}
              onDelete={control.delete ? remove : undefined}
            />
          ))}
        </div>
      )}
      {state.data && (
        <Accordion
          variant="activity"
          value={importSections}
          onValueChange={setImportSections}
          items={[
            {
              value: "old-buzz",
              title: state.data.agents.some((agent) => agent.needsTeamImport)
                ? "Import or repair from old Buzz"
                : "Not imported from old Buzz",
              content: importSections.includes("old-buzz") ? (
                <AgentImport
                  key={importDestination}
                  control={control}
                  initialDestination={importDestination}
                  managedAgents={state.data.agents}
                  commitAvailable={
                    state.status === "ready" &&
                    state.data.importAvailable !== false
                  }
                  disabled={state.busy}
                  onImported={(agents) => {
                    setImportedId(agents[0]?.id ?? null);
                    setImportSections([]);
                  }}
                />
              ) : null,
            },
          ]}
        />
      )}
      {adding && (
        <AgentCreateDialog
          control={control}
          state={state}
          destination={adding.destination}
          owner={adding.owner}
          {...(adding.source ? { source: adding.source } : {})}
          onClose={() => setAdding(null)}
        />
      )}
      {editing && (
        <AgentEditor
          key={editing.id}
          agent={editing}
          displayName={label(editing)}
          control={control}
          state={state}
          avatar={editTarget ? undefined : selected?.avatar}
          onClose={
            editTarget ? (onCloseTarget ?? (() => {})) : () => setSelected(null)
          }
        />
      )}
      {deletion && control.delete && (
        <AgentDeleteDialog
          agent={deletion}
          control={control}
          state={state}
          onClose={() => setDeleting(null)}
        />
      )}
    </section>
  );
}
