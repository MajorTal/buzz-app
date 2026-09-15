import type { WorkflowRunCursor } from "./types.ts";

/** Host-owned authenticated reads on the captured relay principal/admission lane. */
export interface WorkflowHost {
  runs(
    id: string,
    cursor: WorkflowRunCursor | undefined,
    signal: AbortSignal,
  ): Promise<unknown>;
}
