// The only owner of Playwright `pageerror` collection for browser tests. A lint
// plugin (page-errors.grit) rejects other collectors.
//
// Every page error is kept as evidence in `errors`. `unexplained()` returns the
// errors that are not a known engine report; tests assert that it is empty.
// Add an engine report here only with evidence that the application did not
// throw or leave a rejection unhandled.

const resizeObserverLoop =
  "ResizeObserver loop completed with undelivered notifications.";
// WebKit's cancellation text for a request: Linux (CI), then macOS.
const cancellations = new Set(["Load request cancelled", "cancelled"]);
const cancelledLoad =
  /^Fetch API cannot load (\S+) due to access control checks\.$/;

// Playwright converts every WebKit console message with source "javascript" and
// level "error" into a page error, and splits its text at the first colon
// ("Fetch API cannot load http" becomes the name). The stack's first line keeps
// the full text. Reports without a stack keep their name, for example
// "Unhandled Promise Rejection".
const errorText = (error) =>
  (error.stack ?? "").split("\n")[0] ||
  (error.name ? `${error.name}: ${error.message}` : error.message);

export function watchPageErrors(page) {
  const webkit = page.context().browser()?.browserType().name() === "webkit";
  const errors = [];
  const cancelled = [];
  page.on("pageerror", (error) => errors.push(errorText(error)));
  if (webkit)
    page.on("requestfailed", (request) => {
      if (cancellations.has(request.failure()?.errorText))
        cancelled.push(request.url());
    });
  return {
    errors,
    unexplained() {
      if (!webkit) return [...errors];
      const unmatched = [...cancelled];
      return errors.filter((message) => {
        // A layout warning that WebKit reports as a page error.
        if (message === resizeObserverLoop) return false;
        // When a reload or navigation cancels a fetch, WebKit logs the fetch as
        // an access-control failure even though the caller handles the
        // rejection. An unhandled rejection is a separate page error named
        // "Unhandled Promise Rejection". Accept the log only for a request that
        // Playwright saw cancelled, once per cancellation.
        const url = cancelledLoad.exec(message)?.[1];
        const match = url ? unmatched.indexOf(url) : -1;
        if (match < 0) return true;
        unmatched.splice(match, 1);
        return false;
      });
    },
  };
}
