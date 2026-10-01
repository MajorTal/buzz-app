import { setImmediate as nextTurn } from "node:timers/promises";

const scenario = JSON.parse(process.env.BUZZ_TEST_SCENARIO);
const release = Promise.withResolvers();
process.on("message", (message) => {
  if (message === "release") release.resolve();
});
async function operation(name, value) {
  process.send({ type: "call", name });
  if (scenario.held === name) {
    process.send({ type: "held", name });
    await release.promise;
    // Report after promise continuations have drained, not on an arbitrary delay.
    void nextTurn().then(() => process.send({ type: "released" }));
    if (scenario.late === "reject") throw new Error("fixture late rejection");
  }
  if (scenario.reject === name) throw new Error("fixture rejection");
  return value;
}
const session = {
  on() {},
  send(method) {
    return operation(
      method,
      method === "Profiler.stop"
        ? { profile: { nodes: [{ id: 1 }], startTime: 1, endTime: 2 } }
        : { metrics: [{ name: "Timestamp", value: 1 }] },
    );
  },
};
const page = {
  context() {
    return { newCDPSession: () => operation("newCDPSession", session) };
  },
  locator: () => ({ click: () => operation("click") }),
  evaluate: () =>
    operation("evaluate", { epochMilliseconds: 1, monotonicMilliseconds: 1 }),
  async goto() {
    await operation("goto");
    if (!closed) process.send({ type: "navigated" });
  },
};
let closed = false;
const browser = {
  newPage: () => operation("newPage", page),
  startTracing: () => operation("startTracing"),
  stopTracing: () =>
    operation("stopTracing", Buffer.from('{"traceEvents":[]}\n')),
  async close() {
    closed = true;
    process.send({ type: "browserClosed" });
  },
};
export const chromium = { launch: () => operation("launch", browser) };
