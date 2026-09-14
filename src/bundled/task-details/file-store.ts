import { useEffect, useState } from "react";

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

export function useFileStore(scope: string) {
  const [records, setRecords] = useState<Records>();
  const [error, setError] = useState("");
  const [attempt, retry] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry restarts a failed load.
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
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
                JSON.parse(key.slice(prefix.length))[0] === scope
              );
            }),
          );
          if (Object.keys(legacy).length)
            await request(scope, { action: "import", records: legacy });
          localStorage.setItem(migrated, "true");
        }
        const next = await request(scope);
        if (active) {
          setRecords(next);
          setError("");
          timer = setTimeout(() => void load(), 3000);
        }
      } catch (e) {
        if (active) setError(String(e));
      } finally {
        loading = false;
      }
    };
    void load();
    window.addEventListener("focus", load);
    return () => {
      active = false;
      clearTimeout(timer);
      window.removeEventListener("focus", load);
    };
  }, [scope, attempt]);
  const values = Object.fromEntries(
    Object.entries(records ?? {})
      .filter(([, r]) => r.value !== null)
      .map(([k, r]) => [k, r.value as string]),
  );
  return {
    records,
    error,
    retry: () => retry((v) => v + 1),
    storage: {
      length: Object.keys(values).length,
      key: (i: number) => Object.keys(values)[i] ?? null,
      getItem: (key: string) => values[key] ?? null,
    },
    read: () => request(scope),
    save: async (
      key: string,
      value: string | null,
      expected: string | null,
    ) => {
      const next = await request(scope, {
        action: "put",
        key,
        value,
        expected,
      });
      const revision = next[key]?.revision;
      if (!revision)
        throw new Error("Save returned no record; reload to check its state.");
      return revision;
    },
  };
}
