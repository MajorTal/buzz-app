/** Let mounted reading consumers publish post-commit visibility before an alert.
 * Two frames cover React commit and the timeline's own positioning frame. The
 * timer caps the wait when frames stop; eligibility still checks the live lease.
 * This yields presentation only: it neither observes nor marks a message read.
 */
export function afterPresentation(
  host: Window | undefined = typeof window === "undefined" ? undefined : window,
): Promise<void> {
  if (!host) return Promise.resolve();
  return new Promise((resolve) => {
    let frame = 0;
    const finish = () => {
      host.cancelAnimationFrame(frame);
      host.clearTimeout(timer);
      resolve();
    };
    const timer = host.setTimeout(finish, 100);
    frame = host.requestAnimationFrame(() => {
      frame = host.requestAnimationFrame(finish);
    });
  });
}
