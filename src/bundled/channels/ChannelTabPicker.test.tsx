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
  await user.click(screen.getByRole("tab", { name: "DMs" }));
  expect(screen.queryByRole("button", { name: "Alpha" })).toBeNull();
  await user.type(screen.getByRole("searchbox"), "no match");
  expect(screen.getByRole("status")).toHaveTextContent("No matches");
  await user.clear(screen.getByRole("searchbox"));
  await user.click(screen.getByRole("button", { name: "Ada" }));
  expect(choose).toHaveBeenCalledExactlyOnceWith("dm");
  await user.click(screen.getByRole("tab", { name: "Tools" }));
  expect(screen.getByRole("searchbox")).toHaveValue("");
  expect(
    within(screen.getByRole("tablist")).getByRole("tab", {
      name: "Tools",
    }),
  ).toHaveAttribute("aria-selected", "true");
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
it("switches categories with the keyboard and labels the active panel", async () => {
  const user = userEvent.setup();
  render(
    <ChannelTabPicker
      channels={channels}
      tools={[tool]}
      icon={() => null}
      choose={vi.fn()}
      chooseTool={vi.fn()}
    />,
  );
  await user.tab({ shift: true });
  expect(screen.getByRole("tab", { name: "Channels" })).toHaveFocus();
  await user.keyboard("{ArrowRight}");
  expect(screen.getByRole("tab", { name: "DMs" })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("tabpanel", { name: "DMs" })).toContainElement(
    screen.getByRole("button", { name: "Ada" }),
  );
  await user.keyboard("{ArrowRight}");
  await user.keyboard("{Enter}");
  expect(screen.getByRole("tabpanel", { name: "Tools" })).toContainElement(
    screen.getByRole("button", { name: "Todos" }),
  );
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
