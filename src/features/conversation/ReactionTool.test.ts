import { expect, it } from "vitest";
import type { ComponentType } from "react";
import type { Contribution } from "../../plugins/contributions";
import type {
  ComposerTool,
  ComposerToolProps,
  ReactionToolProps,
} from "./contracts";
import { reactionTarget, selectReactionTool } from "./ReactionTool";

const Component = () => null;
const ComposerComponent = Component as ComponentType<ComposerToolProps>;
const ReactionComponent = Component as ComponentType<ReactionToolProps>;
const tool = (
  key: string,
  order?: number,
  reaction = true,
): Contribution<ComposerTool> => ({
  key,
  pluginId: key,
  revision: "one",
  id: key,
  title: key,
  ...(order === undefined ? {} : { order }),
  component: ComposerComponent,
  ...(reaction ? { reactionComponent: ReactionComponent } : {}),
});

it("selects the first reaction provider by declared order, then contribution key", () => {
  expect(
    selectReactionTool([
      tool("plugin/plain", -100, false),
      tool("plugin/z", 1),
      tool("plugin/b", -2),
      tool("plugin/a", -2),
      tool("plugin/default"),
    ])?.key,
  ).toBe("plugin/a");
});

it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY])(
  "treats missing or non-finite order %s as zero",
  (order) => {
    expect(
      selectReactionTool([
        tool("plugin/z", order),
        tool("plugin/after", 1),
        tool("plugin/before", -1),
      ])?.key,
    ).toBe("plugin/before");
  },
);

it("identifies only reactions with a target", () => {
  expect(
    reactionTarget({
      kind: 7,
      tags: [
        ["h", "channel"],
        ["e", "target"],
      ],
    }),
  ).toBe("target");
  expect(reactionTarget({ kind: 7, tags: [["h", "channel"]] })).toBeUndefined();
  expect(
    reactionTarget({ kind: 9, tags: [["e", "thread", "", "reply"]] }),
  ).toBeUndefined();
});
