// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ChannelList } from "./contracts";
import { useListedChannel } from "./listed-channel";

afterEach(cleanup);

it("renders only when the selected fact of its own channel changes", () => {
  const members = ["a"];
  let list: ChannelList = {
    status: "ready",
    channels: [
      { id: "one", name: "One", members },
      { id: "two", name: "Two", members: [] },
    ],
  };
  const listeners = new Set<() => void>();
  const queries = {
    list: () => list,
    subscribeList: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const publish = (next: ChannelList) =>
    act(() => {
      list = next;
      for (const notify of listeners) notify();
    });
  const seen: unknown[] = [];
  function Probe() {
    const archived = useListedChannel(queries, "one", (c) => !!c?.archived);
    const roster = useListedChannel(queries, "one", (c) => c?.members);
    seen.push([archived, roster]);
    return null;
  }
  render(<Probe />);
  expect(seen).toEqual([[false, members]]);

  // A message replaces the list and every summary; no selected fact changed.
  publish({
    ...list,
    channels: [
      { id: "one", name: "One", members, preview: "new" },
      { id: "two", name: "Two", members: [], archived: true },
    ],
  });
  expect(seen).toHaveLength(1);

  publish({
    ...list,
    channels: [{ id: "one", name: "One", members, archived: true }],
  });
  expect(seen.at(-1)).toEqual([true, members]);
  expect(seen).toHaveLength(2);

  publish({ ...list, channels: [] });
  expect(seen.at(-1)).toEqual([false, undefined]);
});
