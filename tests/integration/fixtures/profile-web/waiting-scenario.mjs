import { setTimeout as pause } from "node:timers/promises";

// Abort-aware outstanding work: only the harness aborting `signal` ends it.
export default async (_page, { signal }) => {
  signal.addEventListener("abort", () =>
    process.send({ type: "scenarioAborted" }),
  );
  process.send({ type: "scenarioWaiting" });
  await pause(60_000, undefined, { signal });
};
