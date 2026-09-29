import { useEffect, useSyncExternalStore } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Header } from "../../shared/design-system/ui/Header";
import type { Updates } from "./updates";

export function UpdateSettings({
  updates,
  active,
}: {
  updates: Updates;
  active: boolean;
}) {
  const status = useSyncExternalStore(
    updates.subscribe,
    updates.snapshot,
    updates.snapshot,
  );
  useEffect(
    () => (active ? updates.showInline() : undefined),
    [active, updates],
  );
  const pending = [
    "checking",
    "available",
    "downloading",
    "installing",
  ].includes(status.state);
  const messages = {
    idle: "Check if a new version is available.",
    checking: "Checking for updates...",
    "up-to-date": "You're on the latest version.",
    unavailable:
      "Automatic updates aren't available on this build. Download the latest release manually.",
    available: "Preparing update...",
    downloading: "Downloading update...",
    installing: "Installing update...",
    ready: "Update downloaded. Click to apply.",
    error: "",
  };
  const label =
    status.state === "ready" || status.state === "installing"
      ? "Update Now"
      : status.state === "error"
        ? "Retry"
        : status.state === "up-to-date" || status.state === "unavailable"
          ? "Check Again"
          : "Check for Updates";
  return (
    <section aria-labelledby="update-settings-title">
      <Header
        id="update-settings-title"
        title="Software Updates"
        subtitle="Keep Buzz up to date with the latest features and fixes."
      />
      <div className="flex flex-wrap items-center justify-between gap-3 py-3">
        <p role="status" className="m-0 min-w-0 text-body-sm text-subtle">
          {status.state === "error" ? (
            <span className="error">Update failed: {status.message}</span>
          ) : (
            messages[status.state]
          )}
        </p>
        <Button
          type="button"
          size="sm"
          loading={pending}
          onClick={() =>
            void (status.state === "ready"
              ? updates.installAndRelaunch()
              : updates.checkForUpdate())
          }
        >
          {label}
        </Button>
      </div>
    </section>
  );
}
