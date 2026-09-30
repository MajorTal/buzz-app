// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: ToastProvider });
import { MessageActionBar } from "./MessageActionBar";
import { MenuItem } from "../../shared/design-system/ui/Menu";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("replies and exposes real sibling controls without placeholders", () => {
  const reply = vi.fn();
  render(<MessageActionBar onReply={reply} copyText={() => "Hello"} />);
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  expect(reply).toHaveBeenCalledOnce();
  expect(
    screen.getByRole("button", { name: "Copy link" }).hasAttribute("disabled"),
  ).toBe(true);
});
it("opens with keyboard, invokes a sibling action, and returns focus on Escape", async () => {
  const user = userEvent.setup();
  const action = vi.fn();
  render(
    <MessageActionBar
      copyText={() => "Hello"}
      overflowItems={<MenuItem onClick={action}>Edit message</MenuItem>}
    />,
  );
  const trigger = screen.getByRole("button", { name: "More message actions" });
  trigger.focus();
  await user.keyboard("{Enter}");
  await user.click(
    await screen.findByRole("menuitem", { name: "Edit message" }),
  );
  expect(action).toHaveBeenCalledOnce();
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  trigger.focus();
  await user.keyboard("{Enter}");
  const menu = await screen.findByRole("menu");
  await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});
it.each(["{Escape}", "{ArrowDown}{Escape}"])(
  "returns focus after pointer open then keyboard close: %s",
  async (keys) => {
    const user = userEvent.setup();
    render(<MessageActionBar copyText={() => "Hello"} />);
    const trigger = screen.getByRole("button", {
      name: "More message actions",
    });
    await user.click(trigger);
    const menu = await screen.findByRole("menu");
    await waitFor(() =>
      expect(menu.contains(document.activeElement)).toBe(true),
    );
    await user.keyboard(keys);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await user.keyboard("{Enter}");
    await screen.findByRole("menu");
  },
);
it("keeps keyboard retry reachable after pointer open and a failed copy", async () => {
  const user = userEvent.setup();
  const write = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockRejectedValueOnce(new Error("denied"))
    .mockResolvedValueOnce();
  render(<MessageActionBar copyText={() => "Hello"} />);
  const trigger = screen.getByRole("button", { name: "More message actions" });
  await user.click(trigger);
  const menu = await screen.findByRole("menu");
  await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
  await user.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(
    screen.getByRole("menuitem", { name: "Copy message" }),
  );
  await user.keyboard("{Enter}");
  await screen.findByText("Couldn’t copy. Try again from the message menu.");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  await user.keyboard("{Enter}");
  const retry = await screen.findByRole("menuitem", { name: "Copy message" });
  await waitFor(() => expect(document.activeElement).toBe(retry));
  await user.keyboard("{Enter}");
  await screen.findByText("Message copied");
  expect(write).toHaveBeenCalledTimes(2);
  expect(write).toHaveBeenLastCalledWith("Hello");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});
it("copies the message, shows failure, and allows retry", async () => {
  const user = userEvent.setup();
  const write = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockRejectedValueOnce(new Error("denied"))
    .mockResolvedValueOnce();
  render(<MessageActionBar copyText={() => "Hello"} />);
  const trigger = screen.getByRole("button", { name: "More message actions" });
  await user.click(trigger);
  await user.click(
    await screen.findByRole("menuitem", { name: "Copy message" }),
  );
  await screen.findByText("Couldn’t copy. Try again from the message menu.");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(document.activeElement).not.toBe(trigger);
  await user.click(trigger);
  await user.click(
    await screen.findByRole("menuitem", { name: "Copy message" }),
  );
  const copied = await screen.findByText("Message copied");
  expect(copied.closest(".buzz-toast")).not.toBeNull();
  expect(write).toHaveBeenLastCalledWith("Hello");
});
it("prevents duplicate clipboard writes until the first settles", async () => {
  userEvent.setup();
  let finish!: () => void;
  const write = vi.spyOn(navigator.clipboard, "writeText").mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  render(
    <MessageActionBar
      link="buzz://link"
      copyText={() => "Hello"}
      replyDisabled
      onReply={() => {}}
    />,
  );
  const link = screen.getByRole("button", { name: "Copy link" });
  fireEvent.click(link);
  try {
    expect(link.hasAttribute("disabled")).toBe(true);
    fireEvent.click(link);
    expect(write).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Reply" }).hasAttribute("disabled"),
    ).toBe(true);
  } finally {
    finish();
  }
  await screen.findByText("Link copied");
  expect(link.hasAttribute("disabled")).toBe(false);
});
