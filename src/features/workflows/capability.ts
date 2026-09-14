import type { EventData } from "../relay/events";
import type { RelayReader } from "../relay/reader";
import type { Outbox, LocalEvents } from "../relay/outbox";
import type { WorkflowHost } from "./host";
import type {
  WorkflowCapability,
  WorkflowOperation,
  WorkflowReference,
  WorkflowView,
  WorkflowDefinition,
} from "./types";
import {
  definition,
  isWorkflowOperation,
  parseRuns,
  record,
  validateReference,
  validateWorkflowEvent,
  workflowReference,
  UUID,
} from "./protocol";

/** Session-owned configuration snapshots and bounded result state; never an engine. */
export function createWorkflows({
  reader,
  viewer,
  outbox,
  local,
  host,
  canAccess,
  notify = (listener: () => void) => listener(),
}: {
  reader: RelayReader | undefined;
  viewer: string;
  outbox: Outbox | undefined;
  local: LocalEvents | undefined;
  host: WorkflowHost | undefined;
  canAccess(channel: string): boolean;
  notify?: (listener: () => void) => void;
}) {
  let closed = false;
  const views = new Set<{
    clear(): void;
    interrupt(): void;
    emit(): void;
    dispose(): void;
  }>();
  const listeners = new Set<() => void>();
  type Result = {
    outcome: WorkflowOperation["outcome"];
    runId?: string;
    error?: string;
  };
  const results = new Map<string, Result>();
  const receiptInterest = new Set<string>();
  const availability = Object.freeze({
    definitions: !!reader,
    history: !!host,
    save: !!host && !!outbox?.supports(30620),
    trigger: !!host && !!outbox?.supports(46020),
    delete: !!host && !!outbox?.supports(5),
  });
  let operations: readonly WorkflowOperation[] = Object.freeze([]);
  function rebuild() {
    operations = closed
      ? Object.freeze([])
      : Object.freeze(
          (local?.snapshot() ?? [])
            .flatMap((item): WorkflowOperation[] => {
              if (!isWorkflowOperation(item.event)) return [];
              let workflow: WorkflowReference;
              try {
                workflow = workflowReference(item.event);
              } catch {
                return [];
              }
              if (workflow.owner !== viewer || !canAccess(workflow.channelId))
                return [];
              const result = results.get(item.event.id);
              const outcome =
                result?.outcome ??
                (item.delivery === "sending"
                  ? "pending"
                  : item.delivery === "failed"
                    ? "rejected"
                    : "unknown");
              const error =
                result?.outcome === "succeeded"
                  ? undefined
                  : (result?.error ?? item.error);
              return [
                Object.freeze({
                  eventId: item.event.id,
                  workflow,
                  action:
                    item.event.kind === 30620
                      ? "save"
                      : item.event.kind === 5
                        ? "delete"
                        : "trigger",
                  delivery: item.delivery,
                  outcome,
                  ...(result?.runId ? { runId: result.runId } : {}),
                  ...(error !== undefined ? { error } : {}),
                }),
              ];
            })
            .slice(-256),
        );
    const active = new Set(operations.map((op) => op.eventId));
    for (const id of results.keys()) if (!active.has(id)) results.delete(id);
    for (const listener of listeners) notify(listener);
  }
  const stop = local?.subscribe(rebuild);
  rebuild();
  function assertAccess(reference: WorkflowReference) {
    validateReference(reference);
    if (closed || !canAccess(reference.channelId))
      throw new Error(
        "Workflow access unavailable; refresh channel membership",
      );
  }
  function view<T>(
    channelId: string,
    available: boolean,
    empty: T,
    load: (signal: AbortSignal) => Promise<T>,
    accept?: (data: T) => void,
  ): WorkflowView<T> {
    if (!UUID.test(channelId)) throw new Error("Invalid workflow channel");
    if (views.size >= 16)
      throw new Error("Too many workflow views; close another detail first");
    let disposed = false;
    let controller: AbortController | undefined;
    let pending: Promise<void> | undefined;
    const subscribers = new Set<() => void>();
    type Snapshot = ReturnType<WorkflowView<T>["snapshot"]>;
    let snapshot: Snapshot = Object.freeze({
      status:
        available && !closed && canAccess(channelId) ? "idle" : "unavailable",
      data: empty,
    });
    const emit = () => {
      for (const listener of subscribers) notify(listener);
    };
    function clear() {
      controller?.abort();
      controller = undefined;
      pending = undefined;
      snapshot = Object.freeze({
        status:
          available && !closed && !disposed && canAccess(channelId)
            ? "idle"
            : "unavailable",
        data: empty,
      });
    }
    const owner = {
      clear,
      interrupt() {
        controller?.abort();
        controller = undefined;
        pending = undefined;
        if (snapshot.status === "idle" || snapshot.status === "unavailable")
          return;
        snapshot = Object.freeze({
          status: "error",
          data: snapshot.data,
          error:
            "Connection interrupted. Refresh to check current workflow data; your draft is retained.",
        });
      },
      emit,
      dispose() {
        disposed = true;
        clear();
        subscribers.clear();
        views.delete(owner);
      },
    };
    views.add(owner);
    return Object.freeze({
      snapshot: () => snapshot,
      subscribe(listener: () => void) {
        if (closed || disposed) return () => {};
        subscribers.add(listener);
        return () => {
          subscribers.delete(listener);
        };
      },
      refresh() {
        if (closed || disposed || !available) return Promise.resolve();
        if (!canAccess(channelId)) {
          clear();
          emit();
          return Promise.resolve();
        }
        if (pending) return pending;
        const owned = new AbortController();
        controller = owned;
        const signal = AbortSignal.any([
          owned.signal,
          AbortSignal.timeout(10000),
        ]);
        snapshot = Object.freeze({ status: "loading", data: snapshot.data });
        pending = Promise.resolve()
          .then(() => {
            signal.throwIfAborted();
            if (!canAccess(channelId))
              throw new Error("Workflow channel access unavailable");
            return load(signal);
          })
          .then((data) => {
            if (
              closed ||
              disposed ||
              controller !== owned ||
              signal.aborted ||
              !canAccess(channelId)
            )
              return;
            snapshot = Object.freeze({ status: "ready", data });
            accept?.(data);
            emit();
          })
          .catch(() => {
            if (
              closed ||
              disposed ||
              controller !== owned ||
              owned.signal.aborted
            )
              return;
            snapshot = Object.freeze({
              status: "error",
              data: empty,
              error:
                "Workflow read unavailable. Retry; this is not proof of deletion.",
            });
            emit();
          })
          .finally(() => {
            if (controller === owned) {
              controller = undefined;
              pending = undefined;
            }
          });
        const started = pending;
        emit();
        return started;
      },
      dispose: owner.dispose,
    });
  }
  function assertOperation(kind: number) {
    const enabled =
      kind === 30620
        ? availability.save
        : kind === 46020
          ? availability.trigger
          : availability.delete;
    if (!enabled)
      throw new Error("Workflow writes are unavailable on this connection");
  }
  function send(
    kind: 30620 | 46020 | 5,
    workflow: WorkflowReference,
    yaml = "",
    revision?: string,
  ) {
    assertAccess(workflow);
    if (workflow.owner !== viewer)
      throw new Error("Only the workflow owner can modify or run it");
    assertOperation(kind);
    const tags = [
      ["h", workflow.channelId],
      ...(kind === 5
        ? [["a", `30620:${workflow.owner}:${workflow.id}`]]
        : [["d", workflow.id]]),
      ...(revision ? [["expected-revision", revision]] : []),
    ];
    const input = { kind, content: yaml, tags };
    validateWorkflowEvent(
      { ...input, pubkey: viewer, id: "", created_at: 0 },
      viewer,
    );
    if (!outbox) throw new Error("Workflow publishing unavailable");
    if (receiptInterest.size >= 256)
      throw new Error("Too many unresolved workflow commands");
    const id = outbox.send(input);
    receiptInterest.add(id);
    return id;
  }
  const capability = Object.freeze<WorkflowCapability>({
    availability,
    definitions(channelId) {
      return view(
        channelId,
        !!reader,
        Object.freeze({
          items: Object.freeze([] as WorkflowDefinition[]),
          partial: false,
        }),
        async (signal) => {
          if (!reader) throw new Error("Workflow definitions unavailable");
          const events = await reader.read(
            [{ kinds: [30620], "#h": [channelId], limit: 100 }],
            { signal, fresh: true },
          );
          const coordinates = new Map<string, WorkflowDefinition>();
          for (const event of events) {
            const row = definition(event);
            if (row.channelId !== channelId)
              throw new Error("Mismatched workflow channel");
            const key = `${row.owner}:${row.id}`;
            const old = coordinates.get(key);
            if (
              !old ||
              row.createdAt > old.createdAt ||
              (row.createdAt === old.createdAt && row.revision < old.revision)
            )
              coordinates.set(key, row);
          }
          return Object.freeze({
            items: Object.freeze([...coordinates.values()]),
            partial: events.length >= 100,
          });
        },
        ({ items }) => {
          // Only a fresh, verified exact configuration head resolves an unknown
          // save. An echo, another revision, or run history cannot do so.
          let changed = false;
          for (const op of operations) {
            if (
              op.action !== "save" ||
              op.outcome !== "unknown" ||
              !items.some(
                (row) =>
                  row.revision === op.eventId &&
                  row.owner === op.workflow.owner &&
                  row.channelId === op.workflow.channelId &&
                  row.id === op.workflow.id,
              )
            )
              continue;
            results.set(op.eventId, { outcome: "succeeded" });
            receiptInterest.delete(op.eventId);
            changed = true;
          }
          if (changed) rebuild();
        },
      );
    },
    runs(workflow, cursor) {
      assertAccess(workflow);
      return view(
        workflow.channelId,
        !!host,
        Object.freeze({ runs: Object.freeze([]), next: null }),
        async (signal) => {
          if (!host) throw new Error("Workflow history unavailable");
          return parseRuns(
            await host.runs(workflow.id, cursor, signal),
            workflow.id,
          );
        },
      );
    },
    save({ channelId, yaml, existing }) {
      if (existing && existing.channelId !== channelId)
        throw new Error("Workflow channel cannot change");
      return send(
        30620,
        existing ?? { channelId, owner: viewer, id: crypto.randomUUID() },
        yaml,
        existing?.revision,
      );
    },
    delete(workflow) {
      return send(5, workflow);
    },
    trigger(workflow) {
      return send(46020, workflow);
    },
    operations: Object.freeze<WorkflowCapability["operations"]>({
      snapshot: () => operations,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      async dismiss(id) {
        await outbox?.dismiss(id);
        // The outbox cannot dismiss an active attempt, including one already
        // echoed by the relay. Do not tell the editor it may unlock that intent.
        if (local?.snapshot().some((item) => item.event.id === id))
          throw new Error(
            "Command is still being delivered; wait before dismissing it",
          );
        results.delete(id);
        receiptInterest.delete(id);
        rebuild();
      },
    }),
  });
  return {
    capability,
    validate(event: EventData) {
      if (!isWorkflowOperation(event)) return;
      assertOperation(event.kind);
      const reference = validateWorkflowEvent(event, viewer);
      assertAccess(reference);
    },
    receipt(event: EventData, message: string | undefined) {
      if (closed || !receiptInterest.delete(event.id)) return;
      if (message === undefined) {
        results.delete(event.id);
        rebuild();
        return;
      }
      let result: Result = {
        outcome: "unknown",
        error:
          "Delivery may have succeeded, but its result is unavailable. Do not submit a new command to retry.",
      };
      try {
        assertAccess(workflowReference(event));
        if (message?.startsWith("response:")) {
          const value: unknown = JSON.parse(message.slice(9));
          const reference = workflowReference(event);
          if (
            record(value) &&
            (event.kind === 46020
              ? value.workflow_id === undefined ||
                value.workflow_id === reference.id
              : value.workflow_id === reference.id) &&
            value.webhook_secret === undefined
          ) {
            if (event.kind === 30620) result = { outcome: "succeeded" };
            else if (
              event.kind === 46020 &&
              typeof value.run_id === "string" &&
              UUID.test(value.run_id)
            )
              result = { outcome: "succeeded", runId: value.run_id };
            else if (event.kind === 5 && value.deleted === true)
              result = { outcome: "succeeded" };
          }
        }
      } catch {
        /* Do not leak receipt text into errors/journal. */
      }
      results.set(event.id, result);
      rebuild();
    },
    interrupt() {
      // Socket recovery retires reads, not editor intent or HTTP receipt interest.
      for (const owned of views) owned.interrupt();
      for (const owned of views) owned.emit();
    },
    clear() {
      results.clear();
      receiptInterest.clear();
      for (const owned of views) owned.clear();
      rebuild();
      for (const owned of views) owned.emit();
      // Individual view snapshots were cleared before any view callbacks.
      // Views refresh on explicit UI interest; no startup/background fanout.
    },
    dispose() {
      closed = true;
      for (const owned of [...views]) owned.dispose();
      results.clear();
      receiptInterest.clear();
      stop?.();
      rebuild();
      listeners.clear();
    },
  };
}
