import { expect, it } from "vitest";
import { activityTarget, activitySelection } from "./activity-target";
const agent = "a".repeat(64);
it("round-trips an exact agent and optional channel without guessing a thread", () => {
  expect(activitySelection(activityTarget(agent))).toEqual({ agent });
  expect(activitySelection(activityTarget(agent, "a/b & c"))).toEqual({
    agent,
    channelId: "a/b & c",
  });
});
it("rejects other targets, ambiguous keys and malformed selection", () => {
  for (const target of [
    "",
    "nostr:npub1abc",
    activityTarget("Carl", "alpha"),
    `${activityTarget(agent)}&agent=${agent}`,
    `${activityTarget(agent)}&channel=`,
    `${activityTarget(agent)}&channel=a&channel=b`,
    `${activityTarget(agent)}#fragment`,
    `${activityTarget(agent)}&thread=one`,
    activityTarget(agent, "x".repeat(257)),
  ])
    expect(activitySelection(target)).toBeUndefined();
});
