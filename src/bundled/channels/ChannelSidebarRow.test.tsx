// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ChannelSidebarRow } from "./ChannelSidebarRow";

afterEach(cleanup);
const parent = {
  id: "parent",
  name: "Engineering",
  channelType: "stream" as const,
};
function mount() {
  const onSelect = vi.fn(),
    onNewSession = vi.fn();
  function Row() {
    const [collapsed, setCollapsed] = useState(false);
    return (
      <ChannelSidebarRow
        channel={parent}
        collapsed={collapsed}
        onToggle={(open) => setCollapsed(!open)}
        icon={<svg data-testid="channel-icon" />}
        badge={<span>3</span>}
        sessions={[
          {
            id: "child",
            name: "Plan the release",
            channelType: "session",
            parentChannelId: parent.id,
          },
        ]}
        draft={true}
        draftSelected={false}
        selected="child"
        onSelect={onSelect}
        onPrepare={() => {}}
        onNewSession={onNewSession}
      />
    );
  }
  render(<Row />);
  return { onSelect, onNewSession };
}
it("opens a compact action menu independently of selecting its channel", async () => {
  const user = userEvent.setup();
  const callbacks = mount();
  const trigger = screen.getByRole("button", {
    name: "More options for Engineering",
  });
  await user.click(trigger);
  await user.click(
    await screen.findByRole("menuitem", { name: "New session" }),
  );
  expect(callbacks.onNewSession).toHaveBeenCalledWith("parent");
  expect(callbacks.onSelect).not.toHaveBeenCalled();
  await user.click(trigger);
  await user.keyboard("{Escape}");
  expect(trigger).toHaveFocus();
});
it("opens saved child sessions and retained drafts without a channel icon", async () => {
  const user = userEvent.setup();
  const callbacks = mount();
  const child = screen.getByRole("button", {
    name: "Plan the release, session in Engineering",
  });
  expect(child).toHaveAttribute("aria-current", "page");
  expect(child.querySelector("svg")).toBeNull();
  await user.click(child);
  expect(callbacks.onSelect).toHaveBeenCalledWith("child");
  await user.click(
    screen.getByRole("button", { name: "New session draft in Engineering" }),
  );
  expect(callbacks.onNewSession).toHaveBeenCalledWith("parent");
});

it("collapses child sessions and drafts without navigating and expands with the keyboard", async () => {
  const user = userEvent.setup();
  const callbacks = mount();
  const toggle = screen.getByRole("button", {
    name: "Collapse sessions in Engineering",
  });
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  await user.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(
    screen.queryByRole("button", {
      name: "Plan the release, session in Engineering",
    }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "New session draft in Engineering" }),
  ).not.toBeInTheDocument();
  expect(callbacks.onSelect).not.toHaveBeenCalled();
  expect(callbacks.onNewSession).not.toHaveBeenCalled();
  await user.keyboard("{Enter}");
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(
    screen.getByRole("button", {
      name: "Plan the release, session in Engineering",
    }),
  ).toHaveAttribute("aria-current", "page");
});
