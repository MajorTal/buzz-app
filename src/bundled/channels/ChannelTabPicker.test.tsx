// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ChannelTabPicker, isChannelTabTool } from "./ChannelTabPicker";
import type { RegisteredPanel } from "../../features/panels/service";
import type { ChannelSummary } from "../../features/relay/contracts";
afterEach(cleanup);
const tool: RegisteredPanel = {
  id: "todos",
  pluginId: "buzz.todos",
  key: "buzz.todos/todos",
  revision: "1",
  title: "Todos",
  matches: () => false,
  channelLauncher: () => null,
  component: () => null,
};
const channels = [
  { id: "alpha", name: "Alpha", channelType: "channel" },
  { id: "dm", name: "Ada", channelType: "dm" },
] as ChannelSummary[];
it("filters by category and query and opens only the chosen registered tool", async () => {
  const user = userEvent.setup(),
    choose = vi.fn(),
    chooseTool = vi.fn();
  const view = render(
    <ChannelTabPicker
      channels={channels}
      tools={[tool]}
      icon={() => null}
      choose={choose}
      chooseTool={chooseTool}
    />,
  );
  expect(screen.getByRole("searchbox")).toHaveFocus();
  expect(screen.queryByRole("button", { name: "Ada" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Direct messages" }));
  expect(screen.queryByRole("button", { name: "Alpha" })).toBeNull();
  await user.type(screen.getByRole("searchbox"), "no match");
  expect(screen.getByRole("status")).toHaveTextContent("No matches");
  await user.clear(screen.getByRole("searchbox"));
  await user.click(screen.getByRole("button", { name: "Ada" }));
  expect(choose).toHaveBeenCalledExactlyOnceWith("dm");
  await user.click(screen.getByRole("button", { name: "Channel tools" }));
  expect(screen.getByRole("searchbox")).toHaveValue("");
  expect(
    within(screen.getByRole("navigation")).getByRole("button", {
      name: "Channel tools",
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await user.click(screen.getByRole("button", { name: "Todos" }));
  expect(chooseTool).toHaveBeenCalledExactlyOnceWith(tool);
  view.rerender(
    <ChannelTabPicker
      channels={channels}
      tools={[]}
      icon={() => null}
      choose={choose}
      chooseTool={chooseTool}
    />,
  );
  expect(screen.queryByRole("button", { name: "Todos" })).toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent("No channel tools");
});
it("accepts only the current supported channel tool contributions", () => {
  expect(isChannelTabTool(tool)).toBe(true);
  expect(isChannelTabTool({ ...tool, pluginId: "other" })).toBe(false);
  expect(
    isChannelTabTool({ ...tool, id: "terminal", pluginId: "buzz.terminal" }),
  ).toBe(true);
  const { channelLauncher: _, ...withoutLauncher } = tool;
  expect(isChannelTabTool(withoutLauncher)).toBe(false);
});
