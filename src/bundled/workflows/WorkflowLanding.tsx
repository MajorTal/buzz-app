import { WORKFLOW_CHANNEL_BATCH } from "../../features/workflows/queries";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import type {
  WorkflowCapability,
  WorkflowDefinition,
  WorkflowDefinitions,
  WorkflowOperation,
  WorkflowView,
} from "../../features/workflows/types";
import {
  ArrowRightIcon,
  DotsThreeIcon,
  CalendarIcon,
  ChatCircleIcon,
  GitPullRequestIcon,
  LightningIcon,
  PlusIcon,
  SmileyIcon,
  TimerIcon,
  WebhooksLogoIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
} from "../../shared/design-system/ui/Menu";
import { Switch } from "../../shared/design-system/ui/Switch";
import { ConfirmAction } from "./ConfirmAction";
import { getWorkflowActivationWarning } from "./workflowActivationWarning";
import {
  workflowCardPresentation,
  type WorkflowCardIcon,
} from "./workflowCardPresentation";
import {
  readWorkflowDocumentFields,
  yamlWithWorkflowEnabled,
} from "./workflowYamlDocument";

const ICONS: Record<WorkflowCardIcon, typeof LightningIcon> = {
  delay: TimerIcon,
  diff: GitPullRequestIcon,
  message: ChatCircleIcon,
  reaction: SmileyIcon,
  schedule: CalendarIcon,
  webhook: WebhooksLogoIcon,
  workflow: LightningIcon,
};

const EMPTY_DEFINITIONS: WorkflowDefinitions = Object.freeze({
  items: Object.freeze([]),
  partial: false,
});

type DefinitionsSnapshot = ReturnType<
  WorkflowView<WorkflowDefinitions>["snapshot"]
>;

function workflowOperationLocked(
  operations: readonly WorkflowOperation[],
  definition: WorkflowDefinition,
) {
  const matches = (operation: WorkflowOperation) =>
    operation.workflow.channelId === definition.channelId &&
    operation.workflow.id === definition.id &&
    operation.workflow.owner === definition.owner;
  if (
    operations.some(
      (operation) =>
        operation.action === "delete" &&
        operation.outcome !== "rejected" &&
        matches(operation),
    )
  )
    return true;
  for (let index = operations.length - 1; index >= 0; index--) {
    const operation = operations[index];
    if (!operation) continue;
    if (!matches(operation) || operation.outcome === "rejected") continue;
    if (operation.outcome === "pending" || operation.outcome === "unknown")
      return true;
    if (operation.action === "save")
      return operation.eventId !== definition.revision;
  }
  return false;
}

function useLandingDefinitions(
  capability: WorkflowCapability,
  channels: readonly ChannelSummary[],
  refreshRequest: number,
  retryRequest: number,
  operationRefreshKey: string,
  saveReadback: Pick<WorkflowDefinition, "channelId" | "revision"> | undefined,
) {
  // Mount already reads current definitions; only consume subsequent notifications.
  const observedRefresh = useRef(refreshRequest);
  const observedReadback = useRef(saveReadback);
  const store = useMemo(() => {
    let snapshots: Readonly<Record<string, DefinitionsSnapshot>> = {};
    let paused = false;
    let state = { snapshots, paused };
    let channelIds: readonly string[] = [];
    const queued = new Map<string, boolean>();
    const listeners = new Set<() => void>();
    type Read = {
      ids: readonly string[];
      ifStale: boolean;
      view: WorkflowView<WorkflowDefinitions>;
      stop(): void;
    };
    let active: Read | undefined;
    let invalidated = false;
    // Retain one completed view to observe session clear/access loss even after
    // discovery finishes. All other views are disposed; at most two are live.
    let retained: Read | undefined;
    const emit = () => {
      state = { snapshots, paused };
      for (const listener of listeners) listener();
    };
    const release = (read: Read | undefined) => {
      read?.stop();
      read?.view.dispose();
    };
    const purge = (snapshot: DefinitionsSnapshot) => {
      invalidated = true;
      paused = false;
      queued.clear();
      const previous = active;
      active = undefined;
      release(previous);
      snapshots = Object.fromEntries(
        channelIds.map((id) => [
          id,
          {
            status: snapshot.status,
            data: EMPTY_DEFINITIONS,
            ...(snapshot.error ? { error: snapshot.error } : {}),
          },
        ]),
      );
      emit();
    };
    const failure = (id: string) => ({
      status: "error" as const,
      data: snapshots[id]?.data ?? EMPTY_DEFINITIONS,
      error: "Workflow read unavailable. Retry; this is not proof of deletion.",
    });
    const definitionsFor = (id: string, data: WorkflowDefinitions) => ({
      items: data.items.filter((row) => row.channelId === id),
      partial: data.partialChannelIds?.includes(id) ?? data.partial,
    });
    const hasCopiedData = (data: WorkflowDefinitions | undefined) =>
      !!data &&
      (data.items.length > 0 ||
        data.partial ||
        (data.partialChannelIds?.length ?? 0) > 0);
    const record = (owned: Read, snapshot: DefinitionsSnapshot) => {
      for (const id of owned.ids) {
        const previous = snapshots[id]?.data;
        snapshots = {
          ...snapshots,
          [id]: {
            ...snapshot,
            data:
              snapshot.status === "loading" || snapshot.status === "error"
                ? previous && hasCopiedData(previous)
                  ? previous
                  : definitionsFor(id, snapshot.data)
                : definitionsFor(id, snapshot.data),
          },
        };
      }
    };
    const pause = (owned: Read, snapshot: DefinitionsSnapshot) => {
      paused = true;
      for (const id of owned.ids) queued.set(id, false);
      if (active) {
        for (const id of active.ids) queued.set(id, false);
        if (active !== owned) release(active);
      }
      active = undefined;
      if (retained !== owned) release(retained);
      retained = owned;
      record(owned, snapshot);
      emit();
    };
    const observe = (ids: readonly string[], ifStale: boolean): Read => {
      const view = capability.definitions(ids);
      const owned = { ids, ifStale, view, stop: () => {} };
      owned.stop = view.subscribe(() => {
        if (active !== owned && retained !== owned) return;
        const snapshot = view.snapshot();
        if (snapshot.status === "idle" || snapshot.status === "unavailable") {
          purge(snapshot);
        } else if (snapshot.status === "error") {
          pause(owned, snapshot);
        } else {
          record(owned, snapshot);
          emit();
        }
      });
      return owned;
    };
    const readNext = () => {
      if (active || paused) return;
      const ids = channelIds
        .filter((id) => queued.has(id))
        .slice(0, WORKFLOW_CHANNEL_BATCH);
      const first = ids[0];
      if (!first) return;
      const ifStale = ids.every((id) => queued.get(id));
      for (const id of ids) queued.delete(id);
      let owned: Read;
      try {
        owned = observe(ids, ifStale);
        active = owned;
        void owned.view
          .refresh({ ifStale: owned.ifStale })
          .catch(() => {
            if (active === owned) pause(owned, failure(first));
          })
          .finally(() => {
            if (active !== owned) return;
            const snapshot = owned.view.snapshot();
            if (snapshot.status === "error") {
              pause(owned, snapshot);
              return;
            }
            record(owned, snapshot);
            release(retained);
            retained = owned;
            active = undefined;
            emit();
            readNext();
          });
      } catch {
        release(active);
        active = undefined;
        for (const id of ids) {
          snapshots = { ...snapshots, [id]: failure(id) };
          queued.set(id, false);
        }
        paused = true;
        emit();
      }
    };
    return {
      snapshot: () => state,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      channels(ids: readonly string[]) {
        // Membership changes re-establish authorized interest after a secure
        // purge. A session clear alone never restarts discovery.
        if (invalidated) snapshots = {};
        invalidated = false;
        channelIds = ids;
        const wanted = new Set(ids);
        if (active?.ids.some((id) => !wanted.has(id))) {
          const previous = active;
          active = undefined;
          for (const id of previous.ids)
            if (wanted.has(id)) queued.set(id, previous.ifStale);
          release(previous);
        }
        if (retained?.ids.some((id) => !wanted.has(id))) {
          release(retained);
          retained = undefined;
          // Keep copied snapshots subscribed to session invalidation without
          // rereading a completed channel just to replace the observer.
          const replacement = ids[0];
          if (replacement && !active) retained = observe([replacement], true);
        }
        for (const id of queued.keys()) if (!wanted.has(id)) queued.delete(id);
        snapshots = Object.fromEntries(
          Object.entries(snapshots).filter(([id]) => wanted.has(id)),
        );
        for (const id of ids)
          if (!snapshots[id]) {
            snapshots = {
              ...snapshots,
              [id]: { status: "loading", data: EMPTY_DEFINITIONS },
            };
            queued.set(id, true);
          }
        emit();
        readNext();
      },
      retry() {
        paused = false;
        readNext();
        emit();
      },
      refresh(ids = channelIds, afterPending = false) {
        invalidated = false;
        if (!afterPending) paused = false;
        for (const id of ids)
          if (channelIds.includes(id)) queued.set(id, false);
        // A pending read already satisfies refresh; never cancel and repeat it.
        if (active && !afterPending)
          for (const id of active.ids) queued.delete(id);
        readNext();
        emit();
      },
      dispose() {
        const previous = active;
        active = undefined;
        queued.clear();
        release(previous);
        release(retained);
        retained = undefined;
        snapshots = {};
        paused = false;
        state = { snapshots, paused };
      },
    };
  }, [capability]);
  const channelIdsKey = channels
    .map((channel) => channel.id)
    .sort()
    .join(":");
  useEffect(() => () => store.dispose(), [store]);
  useEffect(() => {
    store.channels(channelIdsKey ? channelIdsKey.split(":") : []);
  }, [channelIdsKey, store]);
  useEffect(() => {
    if (observedRefresh.current === refreshRequest) return;
    observedRefresh.current = refreshRequest;
    store.refresh();
  }, [refreshRequest, store]);
  useEffect(() => {
    if (retryRequest) store.retry();
  }, [retryRequest, store]);
  useEffect(() => {
    if (operationRefreshKey)
      store.refresh(
        operationRefreshKey.split(":").map((key) => key.split("/")[0] ?? ""),
        true,
      );
  }, [operationRefreshKey, store]);
  useEffect(() => {
    // The receipt-triggered read may finish before the saved head is visible.
    // Verified editor readback must also invalidate the landing’s copied result.
    if (observedReadback.current === saveReadback) return;
    observedReadback.current = saveReadback;
    if (
      saveReadback &&
      !store
        .snapshot()
        .snapshots[saveReadback.channelId]?.data.items.some(
          (definition) => definition.revision === saveReadback.revision,
        )
    )
      store.refresh([saveReadback.channelId], true);
  }, [saveReadback, store]);
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}

function WorkflowIcon({ kind }: { kind: WorkflowCardIcon }) {
  const Icon = ICONS[kind];
  return <Icon size={20} weight="bold" aria-hidden="true" />;
}

function WorkflowCard({
  capability,
  channel,
  definition,
  locked,
  operations,
  viewer,
  onError,
  onOpen,
}: {
  capability: WorkflowCapability;
  channel: ChannelSummary;
  definition: WorkflowDefinition;
  locked: boolean;
  operations: readonly WorkflowOperation[];
  viewer: string;
  onError: (message: string | null) => void;
  onOpen: (
    definition: WorkflowDefinition,
    channel: ChannelSummary,
    action?: "run" | "delete",
  ) => void;
}) {
  const [confirmEnable, setConfirmEnable] = useState(false);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const fields = readWorkflowDocumentFields(definition.yaml);
  const presentation = workflowCardPresentation(definition.yaml);
  const enabled = fields.enabled !== false;
  const readonly = definition.owner !== viewer;
  const submittedOperation = operations.find(
    (operation) => operation.eventId === submitted,
  );
  const awaitingReadback =
    submitted !== null &&
    definition.revision !== submitted &&
    submittedOperation?.outcome !== "rejected";
  const toggleDisabled =
    readonly ||
    locked ||
    awaitingReadback ||
    !fields.editable ||
    !capability.availability.save;
  const warning = getWorkflowActivationWarning(definition.yaml);
  const name = fields.name || "Unnamed or malformed workflow";
  const toggle = (next: boolean) => {
    const yaml = yamlWithWorkflowEnabled(definition.yaml, next);
    if (yaml === null) {
      onError("This workflow cannot be changed from the landing page.");
      return;
    }
    try {
      const operationId = capability.save({
        channelId: channel.id,
        existing: definition,
        yaml,
      });
      setSubmitted(operationId);
      onError(null);
    } catch (cause) {
      onError(
        cause instanceof Error
          ? cause.message
          : "The workflow status could not be submitted.",
      );
    }
  };

  return (
    <>
      <article className="workflow-card">
        <Button
          aria-label={`Open ${name}`}
          data-workflow-card-open=""
          onClick={() => onOpen(definition, channel)}
          variant="ghost"
        >
          Open {name}
        </Button>
        <div className="workflow-card-content">
          <div className="workflow-card-topline">
            <div className="workflow-card-flow" aria-hidden="true">
              <span className="workflow-card-icon">
                {presentation.triggerEmoji ? (
                  <span className="workflow-card-emoji text-body-lg">
                    {presentation.triggerEmoji}
                  </span>
                ) : (
                  <WorkflowIcon kind={presentation.triggerIcon} />
                )}
              </span>
              {presentation.actionIcons.length > 0 && (
                <>
                  <ArrowRightIcon
                    className="workflow-card-arrow"
                    size={16}
                    aria-hidden="true"
                  />
                  <span className="workflow-card-action-stack">
                    {presentation.actionIcons
                      .slice(0, 3)
                      .map((action, index) => (
                        <span
                          className="workflow-card-icon workflow-card-action"
                          data-index={index}
                          key={action.key}
                        >
                          <WorkflowIcon kind={action.icon} />
                        </span>
                      ))}
                  </span>
                </>
              )}
            </div>
            <div className="workflow-card-switch">
              <Switch
                aria-label={`Enabled in configuration: ${name}`}
                checked={enabled}
                disabled={toggleDisabled}
                onCheckedChange={(next) => {
                  if (next === enabled) return;
                  if (next && warning) setConfirmEnable(true);
                  else toggle(next);
                }}
              />
              <MenuRoot>
                <MenuTrigger
                  render={
                    <IconButton
                      aria-label={`Actions for ${name}`}
                      size="sm"
                      icon={<DotsThreeIcon size={20} aria-hidden="true" />}
                    />
                  }
                />
                <MenuPopup size="compact">
                  <MenuItem onClick={() => onOpen(definition, channel)}>
                    {readonly ? "View workflow" : "Edit workflow"}
                  </MenuItem>
                  <MenuItem
                    disabled={
                      readonly ||
                      locked ||
                      awaitingReadback ||
                      !capability.availability.trigger
                    }
                    onClick={() => onOpen(definition, channel, "run")}
                  >
                    Run now
                  </MenuItem>
                  <MenuItem
                    tone="danger"
                    disabled={
                      readonly ||
                      locked ||
                      awaitingReadback ||
                      !capability.availability.delete
                    }
                    onClick={() => onOpen(definition, channel, "delete")}
                  >
                    Delete workflow
                  </MenuItem>
                </MenuPopup>
              </MenuRoot>
            </div>
          </div>
          <h2 className="workflow-card-description text-body-lg">
            {presentation.description}
          </h2>
          <div className="workflow-card-meta text-caption text-secondary">
            <div className="workflow-card-identity">
              <strong className="text-standard">#{channel.name}</strong>
              <span>{name}</span>

              {readonly && <span>Read-only</span>}
            </div>
            <time
              dateTime={new Date(definition.createdAt * 1000).toISOString()}
            >
              {new Date(definition.createdAt * 1000).toLocaleDateString()}
            </time>
          </div>
        </div>
      </article>
      {confirmEnable && (
        <ConfirmAction
          title={warning?.title ?? "Turn on this workflow?"}
          description={
            warning?.description ??
            "The relay may run this workflow as soon as its trigger matches."
          }
          action="Turn on"
          cancel="Keep off"
          onCancel={() => setConfirmEnable(false)}
          onConfirm={() => {
            setConfirmEnable(false);
            toggle(true);
          }}
        />
      )}
    </>
  );
}

function WorkflowChannelCards({
  capability,
  channel,
  operations,
  snapshot,
  viewer,
  onOpen,
}: {
  capability: WorkflowCapability;
  channel: ChannelSummary;
  operations: readonly WorkflowOperation[];
  snapshot: DefinitionsSnapshot | undefined;
  viewer: string;
  onOpen: (
    definition: WorkflowDefinition,
    channel: ChannelSummary,
    action?: "run" | "delete",
  ) => void;
}) {
  const [error, setError] = useState<string | null>(null);

  if (!snapshot) return null;
  if (snapshot.status === "idle" || snapshot.status === "unavailable")
    return null;

  return (
    <>
      {error && (
        <div className="workflow-state-card" role="alert">
          <p className="text-body-sm text-danger">{error}</p>
          <Button size="sm" onClick={() => setError(null)}>
            Dismiss
          </Button>
        </div>
      )}
      {snapshot.data.items.map((definition) => {
        return (
          <WorkflowCard
            capability={capability}
            channel={channel}
            definition={definition}
            key={`${definition.owner}:${definition.id}:${definition.revision}`}
            locked={workflowOperationLocked(operations, definition)}
            onError={setError}
            onOpen={onOpen}
            operations={operations}
            viewer={viewer}
          />
        );
      })}
      {snapshot.data.partial && (
        <div className="workflow-state-card text-body-sm text-secondary">
          #{channel.name} returned a partial workflow list.
        </div>
      )}
    </>
  );
}

export function WorkflowLanding({
  capability,
  channels,
  refreshRequest,
  saveReadback,
  viewer,
  onCreate,
  onOpen,
}: {
  capability: WorkflowCapability;
  channels: readonly ChannelSummary[];
  refreshRequest: number;
  saveReadback?: Pick<WorkflowDefinition, "channelId" | "revision"> | undefined;
  viewer: string;
  onCreate: () => void;
  onOpen: (
    definition: WorkflowDefinition,
    channel: ChannelSummary,
    action?: "run" | "delete",
  ) => void;
}) {
  const operations = useSyncExternalStore(
    capability.operations.subscribe,
    capability.operations.snapshot,
    capability.operations.snapshot,
  );
  const [retryRequest, setRetryRequest] = useState(0);
  const operationRefreshKey = operations
    .filter(
      (operation) =>
        operation.action === "save" &&
        (operation.outcome === "unknown" || operation.outcome === "succeeded"),
    )
    .map(
      (operation) =>
        `${operation.workflow.channelId}/${operation.eventId}/${operation.outcome}`,
    )
    .join(":");
  const { snapshots, paused } = useLandingDefinitions(
    capability,
    channels,
    refreshRequest,
    retryRequest,
    operationRefreshKey,
    saveReadback,
  );
  return (
    <>
      <p className="text-body-sm text-secondary">
        These switches change configuration, not confirmed runtime state. Saving
        a disabled configuration does not confirm that automatic runs have
        stopped or cancel work already running.
      </p>
      <p className="text-body-sm text-secondary" role="status">
        {paused
          ? "Workflow discovery paused. Some channels could not be checked. Loaded workflows are still shown."
          : channels.some(
                (channel) =>
                  !snapshots[channel.id] ||
                  snapshots[channel.id]?.status === "loading",
              )
            ? "Reading workflows…"
            : channels.some(
                  (channel) =>
                    snapshots[channel.id]?.status === "idle" ||
                    snapshots[channel.id]?.status === "unavailable",
                )
              ? "Workflow data cleared or unavailable. Refresh to check access."
              : "Workflow scan finished. Lists may be limited by the relay."}
      </p>
      {paused && (
        <Button
          size="sm"
          onClick={() => setRetryRequest((request) => request + 1)}
        >
          Retry
        </Button>
      )}
      <div className="workflow-card-grid">
        <Button
          aria-label="New workflow"
          data-workflow-create-card=""
          disabled={!capability.availability.save || channels.length === 0}
          onClick={onCreate}
          variant="ghost"
        >
          <PlusIcon size={28} weight="bold" aria-hidden="true" />
        </Button>
        {channels.map((channel) => (
          <WorkflowChannelCards
            capability={capability}
            channel={channel}
            key={channel.id}
            onOpen={onOpen}
            operations={operations}
            snapshot={snapshots[channel.id]}
            viewer={viewer}
          />
        ))}
      </div>
    </>
  );
}
