import { useEffect, useState } from "react";
import type { RelayData } from "../features/relay/service";

type BrokerStats = {
  queries: number;
  errors: number;
  media: number;
  connects: number;
};

const STATS_POLL_MS = 5000;

/** Only the dev broker serves /api/relay/*. Packaged builds and proxied
 * deployments have no such endpoint, so absence is normal, not an error. */
async function fetchStats(): Promise<BrokerStats | undefined> {
  try {
    const res = await fetch("/api/relay/stats");
    if (!res.ok) return undefined;
    return (await res.json()) as BrokerStats;
  } catch {
    return undefined;
  }
}

export function DeveloperSettings({ relay }: { relay: RelayData }) {
  const [stats, setStats] = useState<BrokerStats>();
  const [clearing, setClearing] = useState(false);
  const [status, setStatus] = useState<string>();

  useEffect(() => {
    let alive = true;
    async function poll() {
      const next = await fetchStats();
      if (alive) setStats(next);
    }
    void poll();
    const timer = setInterval(poll, STATS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  async function clearCache() {
    setClearing(true);
    try {
      await relay.clearCache();
      setStatus("Caches cleared. Channels and media will refetch on demand.");
    } catch (error) {
      setStatus(`Clear failed: ${String(error)}`);
    } finally {
      setClearing(false);
    }
  }

  return (
    <section aria-labelledby="developer-settings-title">
      <h2 id="developer-settings-title" className="mt-0 mb-6 text-label">
        Developer
      </h2>
      <div className="ui-card space-y-5 p-5 sm:p-6">
        <p className="text-body-sm text-muted">
          Diagnostics for local development. This tab only appears when the app
          is served from localhost in a development build.
        </p>
        <div className="space-y-2">
          <h3 className="m-0 text-label-sm">Relay broker stats</h3>
          {stats ? (
            <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-1 text-body-sm sm:grid-cols-4">
              <div>
                <dt className="text-muted">Queries</dt>
                <dd className="m-0 tabular-nums">{stats.queries}</dd>
              </div>
              <div>
                <dt className="text-muted">Errors</dt>
                <dd className="m-0 tabular-nums">{stats.errors}</dd>
              </div>
              <div>
                <dt className="text-muted">Media</dt>
                <dd className="m-0 tabular-nums">{stats.media}</dd>
              </div>
              <div>
                <dt className="text-muted">Connects</dt>
                <dd className="m-0 tabular-nums">{stats.connects}</dd>
              </div>
            </dl>
          ) : (
            <p role="status" className="m-0 text-body-sm text-muted">
              Broker stats are unavailable. They exist only when the dev relay
              broker is running on this origin.
            </p>
          )}
        </div>
        <div className="space-y-2">
          <h3 className="m-0 text-label-sm">Caches</h3>
          <p className="m-0 text-body-sm text-muted">
            Clears cached channels, messages, and media. Account, relay, and
            sidebar settings are kept.
          </p>
          <button
            type="button"
            disabled={clearing}
            onClick={() => void clearCache()}
          >
            {clearing ? "Clearing…" : "Clear cache"}
          </button>
          {status && (
            <p role="status" className="m-0 text-body-sm text-muted">
              {status}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
