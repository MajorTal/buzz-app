import { ReadError } from "../relay/errors.ts";
import { readApiFailure } from "../relay/http-admission.ts";
import type { WorkflowHost } from "./host.ts";
import { record, runsPath } from "./protocol.ts";

export const WORKFLOW_READ_BYTES = 1024 * 1024;

/** Only the fixed run-history route; input cannot choose an upstream URL or size. */
export function workflowRunsPath(body: unknown): string {
  if (
    !record(body) ||
    typeof body.id !== "string" ||
    Object.keys(body).some((key) => !["id", "cursor"].includes(key))
  )
    throw new Error("Invalid workflow read");
  const cursor = body.cursor;
  if (
    cursor !== undefined &&
    (!record(cursor) ||
      typeof cursor.before !== "string" ||
      typeof cursor.beforeId !== "string" ||
      Object.keys(cursor).some((key) => !["before", "beforeId"].includes(key)))
  )
    throw new Error("Invalid workflow cursor");
  return runsPath(body.id, cursor as Parameters<typeof runsPath>[1]);
}

/** Stream-bound before parsing. Never include upstream text in an error/log. */
export async function workflowReadText(response: Response): Promise<string> {
  if (!response.body) throw new Error("Workflow response body missing");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0,
    text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > WORKFLOW_READ_BYTES)
        throw new Error("Workflow response exceeds the size limit");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Adapters supply authentication/admission; the capability validates domain rows. */
export function workflowHost(
  request: (
    route: string,
    body: unknown,
    signal: AbortSignal,
  ) => Promise<Response>,
): WorkflowHost {
  return Object.freeze({
    async runs(id, cursor, signal) {
      const body = { id, ...(cursor ? { cursor } : {}) };
      workflowRunsPath(body);
      signal = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
      signal.throwIfAborted();
      const response = await request("workflow-runs", body, signal);
      if (!response.ok) {
        const failure = await readApiFailure(response);
        throw new ReadError(
          response.status === 401 || response.status === 403
            ? "denied"
            : "unavailable",
          failure.error,
          response.status,
          failure.retryAfterMs,
        );
      }
      const text = await workflowReadText(response);
      signal.throwIfAborted();
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error("Invalid workflow response");
      }
    },
  } satisfies WorkflowHost);
}
