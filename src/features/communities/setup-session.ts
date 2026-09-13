import type { RelayData } from "../relay/service";
import type { RelaySession } from "../relay/session";

/** Acquire without a local membership/selection side effect. Retry only a failed
 * connection; never replace a ready session and its durable outbox during setup. */
export async function waitForSetupSession(
  owner: RelayData,
  accountSignal: AbortSignal,
): Promise<RelaySession> {
  const signal = AbortSignal.any([accountSignal, AbortSignal.timeout(12000)]);
  signal.throwIfAborted();
  if (["error", "disconnected"].includes(owner.snapshot().status))
    owner.retry();
  const session = await new Promise<RelaySession>((resolve, reject) => {
    let unsubscribe = () => {};
    const finish = (error?: unknown, value?: RelaySession) => {
      unsubscribe();
      signal.removeEventListener("abort", abort);
      if (value) resolve(value);
      else reject(error);
    };
    const abort = () => finish(signal.reason);
    const check = () => {
      const state = owner.snapshot();
      if (signal.aborted) abort();
      else if (state.status === "ready") finish(undefined, state.session);
      else if (state.status !== "connecting")
        finish(new Error("Community session unavailable; retry setup"));
    };
    unsubscribe = owner.subscribe(check);
    signal.addEventListener("abort", abort, { once: true });
    check();
  });
  // whenReady reports storage failure rather than interpreting it as no saved intent.
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void (session.outbox?.whenReady() ?? Promise.resolve())
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
  signal.throwIfAborted();
  if (
    owner.snapshot().session !== session ||
    owner.snapshot().status !== "ready"
  )
    throw new DOMException(
      "Community session changed; reopen setup",
      "AbortError",
    );
  return session;
}
