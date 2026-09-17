import { Button } from "../../shared/design-system/ui/Button";
import { useState } from "react";
import type { RelayProfiler } from "../../features/relay/profiling";

/** On-demand diagnostics avoid subscribing rendering to every instrumentation sample. */
export function RelayTimings({ profiling }: { profiling: RelayProfiler }) {
  const [samples, setSamples] = useState<ReturnType<RelayProfiler["snapshot"]>>(
    [],
  );
  return (
    <details>
      <summary>Relay timings</summary>
      <Button type="button" onClick={() => setSamples(profiling.snapshot())}>
        Capture timings
      </Button>
      <Button
        type="button"
        onClick={() => {
          const blob = new Blob(
            [JSON.stringify(profiling.snapshot(), null, 2)],
            { type: "application/json" },
          );
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = "relay-timings.json";
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}
      >
        Export timings
      </Button>
      <pre style={{ maxHeight: "16rem", overflow: "auto" }}>
        {samples
          .slice(-40)
          .map(
            (sample) =>
              `${sample.id.slice(0, 10)} ${sample.stage}: ${sample.duration.toFixed(1)} ms (${sample.outcome})${sample.count === undefined ? "" : ` [${sample.count}]`}`,
          )
          .join("\n")}
      </pre>
    </details>
  );
}
