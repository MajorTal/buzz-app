import { Button } from "../shared/design-system/ui/Button";
import { Accordion } from "../shared/design-system/ui/Accordion";
import { useEffect, useState } from "react";
import {
  clientMetrics,
  type OpenSource,
} from "../features/developer/client-metrics";

const METRICS_POLL_MS = 2000;
const ms = (value: number | undefined) =>
  value === undefined ? "–" : `${Math.round(value)} ms`;
type Summary = ReturnType<typeof clientMetrics.summary>;
type Loads = Summary["opens"]["bySource"][OpenSource];
type Phase = Summary["phases"][number];

const SOURCES: readonly [OpenSource, string][] = [
  ["memory", "Memory"],
  ["disk", "Disk"],
  ["disk-late", "Disk, late"],
  ["network", "Server"],
];
// Emphasis: the wait is what caching and relay work change; render is context.
const WAIT = "bg-affordance-accent-prominent";
const RENDER = "bg-current text-metadata";

function Swatch({ className }: { className: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block size-2 rounded-full ${className}`}
    />
  );
}

/** One source's median open as wait + render, scaled to the slowest source. */
function LoadRow({
  label,
  loads,
  scale,
}: {
  label: string;
  loads: Loads;
  scale: number;
}) {
  const wait = loads.waitP50 ?? 0;
  const render = loads.renderP50 ?? 0;
  const width = (value: number) => `${(value / scale) * 100}%`;
  return (
    <li className="grid grid-cols-[5.5rem_1fr_auto] items-center gap-x-3 gap-y-0.5">
      <span className="text-body-sm">
        {label} <span className="text-metadata tabular-nums">{loads.n}</span>
      </span>
      <span
        className="flex h-2 gap-0.5"
        title={`Wait ${ms(wait)}, render ${ms(render)}`}
      >
        {loads.n > 0 && wait > 0 && (
          <span
            className={`rounded-sm ${WAIT}`}
            style={{ width: width(wait) }}
          />
        )}
        {loads.n > 0 && (
          <span
            className={`rounded-sm ${RENDER}`}
            style={{ width: width(render) }}
          />
        )}
      </span>
      <span className="text-body-sm tabular-nums">{ms(loads.p50)}</span>
      <span className="col-start-2 col-end-4 text-metadata tabular-nums">
        {loads.n
          ? `wait ${ms(wait)} · render ${ms(render)} · p90 ${ms(loads.p90)}`
          : "No opens yet"}
      </span>
    </li>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-metadata">{label}</dt>
      <dd className="m-0 text-heading tabular-nums">{value}</dd>
    </div>
  );
}

const phaseName = (phase: Phase, index: number) =>
  phase.kind === "open"
    ? "App open"
    : index
      ? `Reconnect ${index}`
      : "Latest reconnect";

export function ClientMetricsPanel() {
  const [summary, setSummary] = useState(clientMetrics.summary);
  useEffect(() => {
    const timer = setInterval(
      () => setSummary(clientMetrics.summary()),
      METRICS_POLL_MS,
    );
    return () => clearInterval(timer);
  }, []);
  function download() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(clientMetrics.export(), null, 2)], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `buzz-client-metrics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    link.click();
    // WebKit may still be reading the blob when click() returns.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const { opens, mainThread, phases } = summary;
  // A late disk restore is rare; show its row only when it happened.
  const rows = SOURCES.filter(
    ([source]) => source !== "disk-late" || opens.bySource[source].n,
  );
  const scale = Math.max(
    1,
    ...rows.map(
      ([source]) =>
        (opens.bySource[source].waitP50 ?? 0) +
        (opens.bySource[source].renderP50 ?? 0),
    ),
  );
  const [first, ...reconnects] = phases;
  const cpu = (stage: string) => mainThread.cpu[stage];
  const cpuLine = (label: string, stage: string) => {
    const entry = cpu(stage);
    return entry ? `${label}: ${ms(entry.ms)} for ${entry.count} events` : "";
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h3 className="m-0 text-label-sm">Client performance</h3>
          <p className="m-0 text-body-sm text-muted">
            Measured in this window since it loaded. Nothing is sent anywhere.
          </p>
        </div>
        <div className="flex gap-2">
          <Button type="button" onClick={download}>
            Export JSON
          </Button>
          <Button
            type="button"
            onClick={() => {
              clientMetrics.reset();
              setSummary(clientMetrics.summary());
            }}
          >
            Reset
          </Button>
        </div>
      </div>

      <section aria-labelledby="metrics-loads" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h4 id="metrics-loads" className="m-0 text-label-sm">
              Channel load
            </h4>
            <p className="m-0 text-metadata">
              Median from click to rows on screen, by where the rows came from.
            </p>
          </div>
          <p className="m-0 text-body-sm tabular-nums">
            {opens.cacheHitRate === undefined
              ? "No opens yet"
              : `${Math.round(opens.cacheHitRate * 100)}% from cache`}
            {opens.skipped ? (
              <span className="text-metadata">
                {" "}
                · {opens.skipped} not timed
              </span>
            ) : null}
          </p>
        </div>
        <p className="m-0 flex flex-wrap gap-x-4 text-metadata">
          <span className="flex items-center gap-1.5">
            <Swatch className={WAIT} /> Wait: disk read or server request
          </span>
          <span className="flex items-center gap-1.5">
            <Swatch className={RENDER} /> Render: rows in memory to on screen
          </span>
        </p>
        <ul className="m-0 list-none space-y-2 p-0">
          {rows.map(([source, label]) => (
            <LoadRow
              key={source}
              label={label}
              loads={opens.bySource[source]}
              scale={scale}
            />
          ))}
        </ul>
      </section>

      <section aria-labelledby="metrics-live" className="space-y-3">
        <div>
          <h4 id="metrics-live" className="m-0 text-label-sm">
            Live subscriptions{first ? ` · ${phaseName(first, 0)}` : ""}
          </h4>
          <p className="m-0 text-metadata">
            From opening the connection. A subscription is live once the relay
            has sent its stored events (EOSE), and settled once it is live or
            has failed (refused, or over the live capacity).
          </p>
        </div>
        {first && (
          <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
            <Stat label="Connected" value={ms(first.authMs)} />
            <Stat
              label={
                first.routes ? `All ${first.routes} settled` : "All settled"
              }
              value={ms(first.coverageMs)}
            />
            <Stat
              label="Each, median / slowest"
              value={`${ms(first.routeMs.p50)} / ${ms(first.routeMs.max)}`}
            />
            <Stat label="Failed" value={String(first.routeErrors)} />
          </dl>
        )}
        {reconnects.length > 0 && (
          <ul className="m-0 list-none space-y-0.5 p-0 text-body-sm tabular-nums">
            {reconnects.map((phase, index) => (
              <li
                // Phases are append-only; the index is their identity.
                // biome-ignore lint/suspicious/noArrayIndexKey: see above
                key={index}
              >
                {phaseName(phase, index + 1)}: connected {ms(phase.authMs)},{" "}
                {phase.routes} settled in {ms(phase.coverageMs)}
                {phase.routeErrors ? `, ${phase.routeErrors} failed` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Accordion
        items={[
          {
            value: "details",
            title: "Main thread and reads",
            content: (
              <ul className="m-0 list-none space-y-1 p-0 text-body-sm tabular-nums">
                <li>
                  Main thread blocked 50 ms or more: {mainThread.longTasks}{" "}
                  times, {ms(mainThread.longTaskMs)} in total
                </li>
                {[
                  cpuLine("Checking signatures of relay reads", "verify.read"),
                  cpuLine(
                    "Checking signatures of disk restores",
                    "verify.restore",
                  ),
                  cpuLine("Building timelines from events", "fold"),
                ]
                  .filter(Boolean)
                  .map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                {phases.map((phase, index) => (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: append-only phases
                    key={`reads-${index}`}
                  >
                    Reads during {phaseName(phase, index).toLowerCase()}:{" "}
                    {phase.queries} ({phase.background} background),{" "}
                    {Math.round(phase.bytes / 1024)} KB
                  </li>
                ))}
              </ul>
            ),
          },
        ]}
      />
    </div>
  );
}
