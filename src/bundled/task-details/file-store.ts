import { useMemo, useSyncExternalStore } from "react";
import { parseTask } from "./data";
import type { AgentLibrary } from "../../features/agents/library";

type Records = Record<string, { value: string | null; revision: string }>;

async function request(scope: string, body?: unknown): Promise<Records> {
  const response = await fetch(
    `/api/experiment/tasks?scope=${encodeURIComponent(scope)}`,
    {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new Error(
      "Task file service unavailable. Use the prototype dev server.",
    );
  const value = await response.json();
  if (!response.ok)
    throw new Error(value.error || "Could not access task file");
  return value;
}

export function createFileStore(scope: string) {
  let state: { records: Records | undefined; error: string } = {
    records: undefined,
    error: "",
  };
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let loading = false;
  let generation = 0;
  let failures = 0;
  const publish = (next: typeof state) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const load = async () => {
    if (loading) return;
    loading = true;
    const current = generation;
    clearTimeout(timer);
    try {
      const migrated = `buzz.task-file-import.v1:${scope}`;
      if (!localStorage.getItem(migrated)) {
        const legacy = Object.fromEntries(
          Object.entries(localStorage).filter(([key]) => {
            const prefix = key.startsWith("buzz.local-task.v1:")
              ? "buzz.local-task.v1:"
              : "buzz.local-project.v1:";
            return (
              key.startsWith(prefix) &&
              (() => {
                try {
                  return JSON.parse(key.slice(prefix.length))[0] === scope;
                } catch {
                  return false;
                }
              })()
            );
          }),
        );
        if (Object.keys(legacy).length)
          await request(scope, { action: "import", records: legacy });
        localStorage.setItem(migrated, "true");
      }
      const next = await request(scope);
      failures = 0;
      if (listeners.size && current === generation) {
        if (
          JSON.stringify(next) !== JSON.stringify(state.records) ||
          state.error
        )
          publish({ records: next, error: "" });
      }
    } catch (e) {
      failures++;
      if (listeners.size && current === generation)
        publish({ ...state, error: String(e) });
    } finally {
      loading = false;
      if (listeners.size)
        timer = setTimeout(
          () => void load(),
          Math.min(3000 * 2 ** Math.min(failures, 4), 30000),
        );
    }
  };
  return {
    snapshot: () => state,
    active: () => listeners.size > 0,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        void load();
        window.addEventListener("focus", load);
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          generation++;
          clearTimeout(timer);
          window.removeEventListener("focus", load);
        }
      };
    },
    retry: () => void load(),
    read: () => request(scope),
    async save(key: string, value: string | null, expected: string | null) {
      const next = await request(scope, {
        action: "put",
        key,
        value,
        expected,
      });
      const record = next[key];
      if (!record?.revision)
        throw new Error("Save returned no record; reload to check its state.");
      generation++;
      // A response includes the whole file, but concurrent saves may finish out of order.
      // Only this key belongs to this write; the next poll refreshes other records.
      publish({ records: { ...state.records, [key]: record }, error: "" });
      return record.revision;
    },
  };
}

// All visible task surfaces share one poller, not one request per message row.
const stores = new Map<string, ReturnType<typeof createFileStore>>();
export function taskAttachmentCacheKey(
  scope: string,
  channelId: string,
  identities: AgentLibrary["identities"] = [],
) {
  const snapshot = stores.get(scope)?.snapshot();
  const records = snapshot?.records;
  if (!records) return null;
  const prefix = `buzz.local-task.v1:${JSON.stringify([scope, channelId]).slice(0, -1)},`;
  const entries = Object.entries(records)
    .filter(([key]) => key.startsWith(prefix))
    .sort(([a], [b]) => a.localeCompare(b));
  const assignees = new Set(
    entries.flatMap(([, record]) => {
      try {
        return [parseTask(record.value).assignee];
      } catch {
        return [];
      }
    }),
  );
  return JSON.stringify([
    snapshot?.error,
    entries,
    identities
      .filter(({ pubkey }) => assignees.has(pubkey))
      .map(({ pubkey, name, avatar }) => [pubkey, name, !!avatar])
      .sort(),
  ]);
}
function storeFor(scope: string) {
  let store = stores.get(scope);
  if (!store) {
    for (const [key, entry] of stores) if (!entry.active()) stores.delete(key);
    store = createFileStore(scope);
    stores.set(scope, store);
  }
  return store;
}

export function useFileStore(scope: string) {
  const store = useMemo(() => storeFor(scope), [scope]);
  const { records, error } = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
    store.snapshot,
  );
  const values = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(records ?? {})
          .filter(([, r]) => r.value !== null)
          .map(([k, r]) => [k, r.value as string]),
      ),
    [records],
  );
  return {
    records,
    error,
    retry: store.retry,
    storage: {
      length: Object.keys(values).length,
      key: (i: number) => Object.keys(values)[i] ?? null,
      getItem: (key: string) => values[key] ?? null,
    },
    read: store.read,
    save: store.save,
  };
}
