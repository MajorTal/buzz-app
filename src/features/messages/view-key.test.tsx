import { expect, it } from "vitest";
import type { ComponentProps } from "react";
import type { RelaySession } from "../relay/session";
import { ChannelTimeline } from "./ChannelTimeline";
import { MessageComposer } from "./MessageComposer";

const session = {} as RelaySession;
const common = {
  session,
  scope: "viewer/community",
  channelId: "c",
  channelName: "General",
};
it("the timeline and composer wrappers key owned state by destination, scope and session", () => {
  const variants = [
    {
      render: (props: Record<string, unknown>) =>
        MessageComposer({
          ...common,
          threadRootId: "root",
          ...props,
        } as ComponentProps<typeof MessageComposer>),
      changes: [
        { channelId: "other" },
        { threadRootId: "other" },
        { scope: "other" },
        { session: {} },
      ],
    },
    {
      render: (props: Record<string, unknown>) =>
        ChannelTimeline({
          ...common,
          queries: session,
          window: {
            channelId: "c",
            status: "ready",
            rows: [],
            hasMore: false,
            loadingOlder: false,
            error: undefined,
          },
          onOpenLink: () => false,
          ...props,
        } as ComponentProps<typeof ChannelTimeline>),
      changes: [{ channelId: "other" }, { scope: "other" }, { queries: {} }],
    },
  ];
  for (const { render, changes } of variants) {
    const first = render({});
    expect(first.key).not.toBeNull();
    expect(render({}).key).toBe(first.key);
    expect(render({ channelName: "Renamed" }).key).toBe(first.key);
    for (const change of changes)
      expect(render(change).key).not.toBe(first.key);
  }
});
