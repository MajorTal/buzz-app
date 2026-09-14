import { expect, it, vi } from "vitest";
import { WORKFLOW_READ_BYTES, workflowReadText, workflowHost } from "./http";
it("structured body budget counts stream bytes, cancels overflow, rejects invalid UTF8", async () => {
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(WORKFLOW_READ_BYTES + 1));
      },
      cancel,
    }),
  );
  await expect(workflowReadText(response)).rejects.toThrow("size limit");
  expect(cancel).toHaveBeenCalledTimes(1);
  await expect(
    workflowReadText(new Response(new Uint8Array([0xff]))),
  ).rejects.toThrow();
});
it("broker host rejects cancelled or invalid history reads before dispatch", async () => {
  const request = vi.fn();
  const host = workflowHost(request);
  const cancel = new AbortController();
  cancel.abort();
  await expect(
    host.runs("11111111-1111-4111-8111-111111111111", undefined, cancel.signal),
  ).rejects.toThrow();
  await expect(
    host.runs("../", undefined, new AbortController().signal),
  ).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
