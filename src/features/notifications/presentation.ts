/** Let mounted reading consumers publish post-commit visibility before an alert.
 * Two frames cover React commit and the timeline's own positioning frame. The
 * timer caps the wait when frames stop; eligibility still checks the live lease.
 * This yields presentation only: it neither observes nor marks a message read.
 * Aborting retires the frame and timer at once and leaves the wait pending, so
 * a closed owner schedules no work against a host that may already be gone.
 */
export function afterPresentation(
  host: Window | undefined = typeof window === "undefined" ? undefined : window,
  signal?: AbortSignal,
): Promise<void> {
  if (!host) return Promise.resolve();
  return new Promise((resolve) => {
    if (signal?.aborted) return;
    let frame = 0;
    const retire = () => {
      host.cancelAnimationFrame(frame);
      host.clearTimeout(timer);
      signal?.removeEventListener("abort", retire);
    };
    const finish = () => {
      retire();
      resolve();
    };
    const timer = host.setTimeout(finish, 100);
    frame = host.requestAnimationFrame(() => {
      frame = host.requestAnimationFrame(finish);
    });
    signal?.addEventListener("abort", retire, { once: true });
  });
}
