import { Button } from "../shared/design-system/ui/Button";
// FOUNDATION: Recovery must remain usable without executing any plugin.
import { useSyncExternalStore } from "react";
import type { PluginManager } from "../plugins/manager";

export function RecoveryScreen({ plugins }: { plugins: PluginManager }) {
  const { configuration, busy, error } = useSyncExternalStore(
    plugins.subscribe,
    plugins.snapshot,
  );
  if (configuration.status !== "recovery") return null;
  const { reason, canReset } = configuration;
  return (
    <section className="rounded-3xl border border-line bg-surface p-8 shadow-surface">
      <h1>Couldn’t open Buzz</h1>
      <p>Buzz couldn’t read its plugin configuration.</p>
      <details>
        <summary>Error details</summary>
        <p>{reason}</p>
      </details>
      <Button type="button" disabled={busy} onClick={plugins.retry}>
        Try again
      </Button>
      {canReset ? (
        <>
          <p>
            Resetting saves a backup and restores bundled defaults. Installed
            plugin files remain on disk and can be reinstalled.
          </p>
          <Button
            variant="destructive"
            type="button"
            disabled={busy}
            onClick={plugins.recover}
          >
            Back up & reset settings
          </Button>
        </>
      ) : (
        <p>
          If retrying does not help, restart Buzz. Share the error details with
          the Buzz team if it still cannot open.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
