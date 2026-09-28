import {
  useEffect,
  useCallback,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  WorkflowCapability,
  WorkflowDefinition,
} from "../../features/workflows/types";
import { HashIcon } from "../../shared/design-system/icons";
import { MenuItem, MenuSeparator } from "../../shared/design-system/ui/Menu";
import { Button } from "../../shared/design-system/ui/Button";
import { ConfirmAction } from "./ConfirmAction";
import { WorkflowEditor } from "./WorkflowEditor";
import { WorkflowOperations } from "./WorkflowOperations";
import { WorkflowRuns } from "./WorkflowRuns";
import { exactSaveReadback } from "./editor-model";
import { DEFAULT_FORM_STATE, formStateToYaml } from "./workflowFormTypes";
import { readWorkflowDocumentFields } from "./workflowYamlDocument";
import { useWorkflowView } from "./useWorkflowView";

type Draft = {
  editorKey: number;
  original: WorkflowDefinition | undefined;
  yaml: string;
  initial: string;
  operationId?: string;
};

function draftFor(next: WorkflowDefinition | "new", editorKey: number): Draft {
  const yaml =
    next === "new"
      ? formStateToYaml({ ...DEFAULT_FORM_STATE, name: "Untitled workflow" })
      : next.yaml;
  return {
    editorKey,
    original: next === "new" ? undefined : next,
    yaml,
    initial: yaml,
  };
}

export function WorkflowChannel({
  capability,
  channelId,
  channelName,
  initialSelection,
  initialAction,
  viewer,
  onDraftRiskChange,
  onSaveReadback,
  onClose,
}: {
  capability: WorkflowCapability;
  channelId: string;
  channelName: string;
  initialSelection?: WorkflowDefinition | "new" | undefined;
  initialAction?: "run" | "delete" | undefined;
  viewer: string;
  onDraftRiskChange?: (atRisk: boolean) => void;
  onSaveReadback?: (
    saved: Pick<WorkflowDefinition, "channelId" | "revision">,
  ) => void;
  onClose?: () => void;
}) {
  const { snapshot, refresh } = useWorkflowView(
    useCallback(
      () => capability.definitions(channelId),
      [capability, channelId],
    ),
  );
  const operations = useSyncExternalStore(
    capability.operations.subscribe,
    capability.operations.snapshot,
    capability.operations.snapshot,
  );
  const submission = useRef<string | null>(null);
  const editorGeneration = useRef(0);
  const detailOnly = initialSelection !== undefined;
  const [draft, setDraft] = useState<Draft | null>(() =>
    initialSelection === undefined ? null : draftFor(initialSelection, 0),
  );
  const [pendingSelection, setPendingSelection] = useState<
    WorkflowDefinition | "new" | "close" | null
  >(null);
  const [confirmDelete, setConfirmDelete] = useState(
    initialAction === "delete",
  );
  const [confirmRun, setConfirmRun] = useState(initialAction === "run");
  const [error, setError] = useState<string | null>(null);
  const [readRuns, setReadRuns] = useState(false);
  const operation = draft?.operationId
    ? operations.find((item) => item.eventId === draft.operationId)
    : undefined;
  const ownOperations = operations.filter(
    (item) => item.workflow.channelId === channelId,
  );
  const busy =
    !!draft?.operationId && (!operation || operation.outcome === "pending");
  const [localDraftAtRisk, setLocalDraftAtRisk] = useState(false);
  const readonly = !!draft?.original && draft.original.owner !== viewer;
  const dirty = !!draft && (draft.yaml !== draft.initial || localDraftAtRisk);
  const atRisk = dirty || !!draft?.operationId;
  const unresolvedWrite = ownOperations.some(
    (item) =>
      (item.outcome === "pending" || item.outcome === "unknown") &&
      (draft?.original
        ? item.workflow.id === draft.original.id &&
          item.workflow.owner === draft.original.owner
        : item.action === "save"),
  );
  useEffect(() => {
    onDraftRiskChange?.(atRisk);
    return () => onDraftRiskChange?.(false);
  }, [atRisk, onDraftRiskChange]);
  useEffect(() => {
    if (!atRisk) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [atRisk]);
  const open = (next: WorkflowDefinition | "new" | "close") => {
    if (next === "close" && onClose) {
      onClose();
      return;
    }
    setLocalDraftAtRisk(false);
    // Explicit replacement discards local form state even for the same revision.
    setDraft(
      next === "close" ? null : draftFor(next, ++editorGeneration.current),
    );
    submission.current = null;
    setError(null);
    setReadRuns(false);
    setPendingSelection(null);
    setConfirmDelete(false);
  };
  const select = (next: WorkflowDefinition | "new" | "close") => {
    if (atRisk) setPendingSelection(next);
    else open(next);
  };
  useEffect(() => {
    if (operation?.eventId && operation.outcome === "succeeded") void refresh();
  }, [operation?.eventId, operation?.outcome, refresh]);
  useEffect(() => {
    if (!operation || !draft || snapshot?.status !== "ready") return;
    const saved = exactSaveReadback(operation, snapshot.data.items);
    if (saved) {
      submission.current = null;
      onSaveReadback?.({
        channelId: saved.channelId,
        revision: saved.revision,
      });
      // Readback updates the draft, not its modal lifetime: remounting would
      // steal focus from a one-time secret dialog delivered by the same save.
      setDraft({
        editorKey: draft.editorKey,
        original: saved,
        yaml: saved.yaml,
        initial: saved.yaml,
      });
    }
  }, [operation, snapshot, draft, onSaveReadback]);
  // A cleared/unavailable view withdraws the saved private definition from display.
  // Unsaved user-authored drafts never become a second retained definition cache.
  useEffect(() => {
    if (snapshot?.status === "unavailable" || snapshot?.status === "idle") {
      submission.current = null;
      setDraft(null);
      setPendingSelection(null);
      setConfirmDelete(false);
      setReadRuns(false);
      setError(null);
    }
  }, [snapshot?.status]);
  const dismiss = async (eventId: string) => {
    await capability.operations.dismiss(eventId);
    if (submission.current === eventId) submission.current = null;
    setDraft((current) => {
      if (current?.operationId !== eventId) return current;
      const { operationId: _, ...retained } = current;
      return retained;
    });
  };
  const save = () => {
    if (
      !draft ||
      submission.current ||
      busy ||
      unresolvedWrite ||
      readonly ||
      !capability.availability.save ||
      draft.operationId
    )
      return;
    try {
      submission.current = "submitting";
      const operationId = capability.save({
        channelId,
        yaml: draft.yaml,
        ...(draft.original ? { existing: draft.original } : {}),
      });
      submission.current = operationId;
      setDraft({ ...draft, operationId });
      setError(null);
    } catch (cause) {
      submission.current = null;
      setError(
        cause instanceof Error
          ? cause.message
          : "The workflow could not be submitted. Your draft is retained.",
      );
    }
  };
  const remove = () => {
    if (
      !draft?.original ||
      submission.current ||
      readonly ||
      unresolvedWrite ||
      !capability.availability.delete ||
      draft.operationId
    )
      return;
    try {
      submission.current = "submitting";
      const operationId = capability.delete(draft.original);
      submission.current = operationId;
      setDraft({ ...draft, operationId });
      setConfirmDelete(false);
      setError(null);
    } catch (cause) {
      submission.current = null;
      setError(
        cause instanceof Error
          ? cause.message
          : "Deletion could not be submitted. Your draft is retained.",
      );
    }
  };
  const trigger = () => {
    if (
      !draft?.original ||
      submission.current ||
      dirty ||
      unresolvedWrite ||
      draft.operationId ||
      readonly ||
      !capability.availability.trigger
    )
      return;
    try {
      submission.current = "submitting";
      submission.current = capability.trigger(draft.original);
      setError(null);
    } catch (cause) {
      submission.current = null;
      setError(
        cause instanceof Error ? cause.message : "Run could not be submitted.",
      );
    }
  };
  useEffect(() => {
    const active = operations.find(
      (item) => item.eventId === submission.current,
    );
    if (
      active?.action === "trigger" &&
      (active.outcome === "succeeded" || active.outcome === "rejected")
    )
      submission.current = null;
  }, [operations]);
  let blocked: string | undefined;
  if (!capability.availability.save)
    blocked = "Saving is unavailable from this host.";
  else if (unresolvedWrite && !draft?.operationId)
    blocked =
      "Review the unresolved request in Recent activity before continuing.";
  else if (draft?.operationId)
    blocked =
      operation?.outcome === "succeeded"
        ? operation.action === "delete"
          ? "Deletion request accepted, not verified runtime deletion. The configuration may remain visible. Review Recent activity to continue."
          : "Configuration saved; waiting for a readback of this exact revision."
        : operation?.outcome === "rejected"
          ? "Draft retained. Review the error below before continuing."
          : undefined;
  if (!snapshot) return <p role="status">Reading configurations…</p>;
  return (
    <section aria-label={`Workflows in ${channelName}`}>
      {!detailOnly && (
        <div className="workflow-toolbar">
          <h2 className="text-heading">Saved configurations</h2>
          <Button
            disabled={snapshot.status === "loading"}
            onClick={() => void refresh()}
          >
            Refresh configurations
          </Button>
          <Button
            disabled={
              !capability.availability.save ||
              snapshot.status === "unavailable" ||
              snapshot.status === "idle"
            }
            onClick={() => select("new")}
          >
            New workflow
          </Button>
        </div>
      )}
      {!detailOnly && (
        <p className="text-body-sm text-secondary">
          Saved configuration only. Turning off does not confirm runs have
          stopped or cancel active runs.
        </p>
      )}
      {snapshot.status === "loading" && (
        <p role="status">Reading configurations…</p>
      )}
      {snapshot.status === "idle" && (
        <p role="status">Configurations cleared. Refresh to read again.</p>
      )}
      {snapshot.status === "unavailable" && (
        <p role="status">Workflow definitions are unavailable.</p>
      )}
      {snapshot.status === "error" && (
        <p role="alert" className="text-danger">
          {snapshot.error ??
            "Configurations could not be read. Use Refresh configurations to retry."}
        </p>
      )}
      {snapshot.data.partial && (
        <p className="text-secondary">This is a bounded, partial list.</p>
      )}
      {!capability.availability.save && (
        <p role="status" className="text-secondary">
          Creating and saving workflows is unavailable from this host. You can
          browse saved configurations, but cannot save changes here yet.
        </p>
      )}
      {!detailOnly &&
        snapshot.status === "ready" &&
        !snapshot.data.items.length && (
          <p>
            No saved configurations returned for this channel.
            {capability.availability.save &&
              " Create a disabled draft to start."}
          </p>
        )}
      {!detailOnly && (
        <ul className="workflow-list">
          {snapshot.data.items.map((definition) => {
            const header = readWorkflowDocumentFields(definition.yaml);
            return (
              <li key={`${definition.owner}:${definition.id}`}>
                <Button variant="ghost" onClick={() => select(definition)}>
                  {header.name || "Unnamed or malformed workflow"}
                </Button>
                <span className="text-body-sm text-secondary">
                  {header.editable
                    ? header.enabled === false
                      ? "Configured disabled"
                      : "Configured enabled"
                    : "Unreadable configuration"}
                  {definition.owner !== viewer ? " · Read-only" : ""}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {draft &&
        snapshot.status !== "unavailable" &&
        snapshot.status !== "idle" && (
          <WorkflowEditor
            key={draft.editorKey}
            create={!draft.original}
            yaml={draft.yaml}
            initialYaml={draft.original?.yaml}
            onChange={(yaml) => setDraft({ ...draft, yaml })}
            onSave={save}
            onLocalDraftRiskChange={setLocalDraftAtRisk}
            readOnly={readonly}
            busy={busy}
            locked={!!draft.operationId}
            blocked={blocked}
            onCancel={() => select("close")}
            scope={
              <span className="workflow-channel-label text-label">
                <HashIcon size={18} aria-hidden="true" />
                {channelName}
              </span>
            }
            actions={(enable) => (
              <>
                <MenuItem
                  disabled={!capability.availability.history}
                  onClick={() => setReadRuns((value) => !value)}
                >
                  {readRuns ? "Hide runs" : "Read runs"}
                </MenuItem>
                {!readonly && (
                  <>
                    <MenuItem
                      disabled={
                        dirty ||
                        !!draft.operationId ||
                        unresolvedWrite ||
                        !capability.availability.trigger
                      }
                      onClick={trigger}
                    >
                      Run now
                    </MenuItem>
                    {enable}
                    <MenuSeparator />
                    <MenuItem
                      tone="danger"
                      disabled={
                        !!draft.operationId ||
                        unresolvedWrite ||
                        !capability.availability.delete
                      }
                      onClick={() => setConfirmDelete(true)}
                    >
                      Delete workflow
                    </MenuItem>
                  </>
                )}
                {readonly && enable}
              </>
            )}
            status={
              <>
                {(snapshot.status === "error" ||
                  snapshot.status === "loading") && (
                  <div className="workflow-options">
                    {snapshot.status === "error" ? (
                      <p role="alert" className="text-danger">
                        {snapshot.error ??
                          "Configurations could not be read. Refresh to retry."}
                      </p>
                    ) : (
                      <p role="status">Reading configurations…</p>
                    )}
                    <Button
                      disabled={snapshot.status === "loading"}
                      onClick={() => void refresh()}
                    >
                      Refresh configurations
                    </Button>
                  </div>
                )}
                {!capability.availability.delete && (
                  <p className="text-body-sm text-secondary">
                    Delete requests are unavailable from this host.
                  </p>
                )}
                {error && (
                  <p role="alert" className="text-danger">
                    {error}
                  </p>
                )}
                {operation?.outcome === "rejected" && (
                  <Button
                    onClick={() => {
                      submission.current = null;
                      const { operationId: _, ...rest } = draft;
                      setDraft(rest);
                    }}
                  >
                    Continue editing retained draft
                  </Button>
                )}
                {draft.original && readRuns && (
                  <WorkflowRuns
                    key={`${draft.original.owner}:${draft.original.id}`}
                    capability={capability}
                    workflow={draft.original}
                  />
                )}
                <WorkflowOperations
                  operations={ownOperations}
                  definitions={
                    snapshot.status === "ready" ? snapshot.data.items : []
                  }
                  onCheckSaved={refresh}
                  onReviewSaved={select}
                  onDismiss={dismiss}
                />
              </>
            }
            details={
              <>
                <p className="text-body-sm text-subtle">
                  Configuration changes apply on save. Turning off does not
                  confirm runs have stopped or cancel active runs.
                </p>
                <p className="text-body-sm text-subtle">
                  Unsaved changes stay in this editor. Leaving or reloading
                  discards them without cancelling submitted operations.
                </p>
                {draft.original && (
                  <details>
                    <summary>Configuration details</summary>
                    <p className="text-mono-sm workflow-key">
                      Owner: {draft.original.owner}
                    </p>
                    <p className="text-mono-sm workflow-key">
                      Revision: {draft.original.revision}
                    </p>
                  </details>
                )}
              </>
            }
          >
            {pendingSelection && (
              <ConfirmAction
                title="Leave this draft?"
                description="Unsaved draft changes will be discarded. Any submitted operation stays with the captured community session; leaving does not cancel or repeat it."
                action="Leave draft"
                onConfirm={() => open(pendingSelection)}
                onCancel={() => setPendingSelection(null)}
              />
            )}
            {confirmRun && (
              <ConfirmAction
                title="Run this workflow now?"
                description="This submits a manual run of the saved configuration, not unsaved edits."
                action="Run now"
                onCancel={() => setConfirmRun(false)}
                onConfirm={() => {
                  setConfirmRun(false);
                  trigger();
                }}
              />
            )}
            {confirmDelete && (
              <ConfirmAction
                title="Request deletion of this workflow?"
                description="The existing backend may retain a visible saved configuration. An accepted request does not confirm runtime deletion or cancellation of work already running. Submit this deletion request?"
                action="Request deletion"
                onConfirm={remove}
                onCancel={() => setConfirmDelete(false)}
              />
            )}
          </WorkflowEditor>
        )}
      {!draft && (
        <WorkflowOperations
          operations={ownOperations}
          definitions={snapshot.status === "ready" ? snapshot.data.items : []}
          onCheckSaved={refresh}
          onReviewSaved={select}
          onDismiss={dismiss}
        />
      )}
    </section>
  );
}
