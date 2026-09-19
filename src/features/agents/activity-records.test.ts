import { expect, it } from "vitest";
import { activityRecords } from "./activity-records";
const record = (value: unknown, agent = "a") => ({
  agent,
  id: "envelope",
  receivedAt: 10,
  kind: "batch",
  plaintext: JSON.stringify(value),
});
it("projects only exact-channel children and retains original raw envelopes for all-channels diagnostics", () => {
  const first = {
    kind: "acp_read",
    channelId: "alpha",
    payload: "<script>literal</script>",
  };
  const input = record({
    kind: "batch",
    channelId: "beta",
    payload: {
      events: [
        first,
        { kind: "acp_write", channelId: "beta", payload: "other channel" },
        { kind: "session_resolved", channelId: null },
        { kind: "turn_liveness", channelId: "alpha" },
      ],
    },
  });
  const rows = activityRecords([input], "a", "alpha");
  expect(rows.map((row) => row.id)).toEqual(["envelope:0", "envelope:3"]);
  expect(rows[0]?.envelopeId).toBe("envelope");
  expect(rows[0]?.plaintext).toBe(JSON.stringify(first, null, 2));
  expect(rows.map((row) => row.kind)).toEqual(["acp_read", "turn_liveness"]);
  expect(activityRecords([input], "a")[0]?.plaintext).toBe(input.plaintext);
  expect(activityRecords([input], "other", "alpha")).toEqual([]);
});
it("never inherits envelope context into unscoped children or falls back on malformed batches", () => {
  for (const payload of [
    { events: [null, {}, { channelId: "beta" }] },
    {},
    { events: "broken" },
  ]) {
    expect(
      activityRecords(
        [record({ kind: "batch", channelId: "alpha", payload })],
        "a",
        "alpha",
      ),
    ).toEqual([]);
  }
  const single = record({ kind: "turn_started", channelId: "alpha" });
  expect(activityRecords([single], "a", "alpha")[0]?.plaintext).toBe(
    single.plaintext,
  );
  expect(activityRecords([single], "a", "beta")).toEqual([]);
  expect(
    activityRecords([{ ...single, plaintext: "not json" }], "a", "alpha"),
  ).toEqual([]);
});
