// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContextMenuRoot, MenuPopup } from "../../shared/design-system/ui/Menu";
import {
  ChannelLifecycleUnconfirmed,
  type ChannelLifecycleCapability,
} from "../../features/relay/channel-lifecycle";
import { ChannelLifecycleMenu } from "./ChannelLifecycleMenu";
import { ChannelLifecycleDialog } from "./ChannelLifecycleDialog";
import type { ChannelLifecycleSettings } from "../../features/relay/channel-lifecycle-protocol";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const settings: ChannelLifecycleSettings = {
  channelId: "id",
  channelType: "stream",
  canArchive: true,
  canDelete: true,
  canLeave: false,
  canHide: false,
  leaveReason: "Transfer ownership before leaving the channel.",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function capability() {
  return {
    available: true,
    load: vi.fn(async () => settings),
    run: vi.fn<ChannelLifecycleCapability["run"]>(async () => {}),
    snapshot: () => ({ status: "ready", hidden: [] }),
    subscribe: () => () => {},
    refreshVisibility: async () => {},
  } satisfies ChannelLifecycleCapability;
}
it("shows fresh loading and the last-owner boundary", async () => {
  const user = userEvent.setup();
  const lifecycle = capability();
  const choose = vi.fn();
  const gate = deferred<ChannelLifecycleSettings>();
  lifecycle.load.mockReturnValueOnce(gate.promise);
  render(
    <ContextMenuRoot open>
      <MenuPopup>
        <ChannelLifecycleMenu
          channelId="id"
          lifecycle={lifecycle}
          choose={choose}
          disabled={false}
        />
      </MenuPopup>
    </ContextMenuRoot>,
  );
  expect(
    await screen.findByText("Checking channel permissions…"),
  ).toBeDefined();
  expect(screen.queryByText("Delete channel…")).toBeNull();
  gate.resolve(settings);
  const leave = await screen.findByRole("menuitem", { name: "Leave channel…" });
  expect(leave.getAttribute("aria-disabled")).toBe("true");
  await user.click(screen.getByRole("menuitem", { name: "Delete channel…" }));
  expect(choose).toHaveBeenCalledWith("delete");
});
it("failed permission reads offer retry rather than stale destructive actions", async () => {
  const user = userEvent.setup();
  const lifecycle = capability();
  lifecycle.load.mockRejectedValueOnce(new Error("permissions offline"));
  render(
    <ContextMenuRoot open>
      <MenuPopup>
        <ChannelLifecycleMenu
          channelId="id"
          lifecycle={lifecycle}
          choose={() => {}}
          disabled={false}
        />
      </MenuPopup>
    </ContextMenuRoot>,
  );
  expect((await screen.findByRole("alert")).textContent).toBe(
    "permissions offline",
  );
  expect(
    screen.queryByRole("menuitem", { name: "Archive channel…" }),
  ).toBeNull();
  await user.click(
    screen.getByRole("menuitem", { name: "Retry channel permissions" }),
  );
  expect(
    await screen.findByRole("menuitem", { name: "Archive channel…" }),
  ).toBeDefined();
});
it("confirmation, pending lockout and failed-write recovery stay in the actual dialog", async () => {
  // jsdom does not implement top-layer focus; that contract is covered in browsers.
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute("open", "");
  });
  const user = userEvent.setup();
  const lifecycle = capability();
  const completed = vi.fn();
  const close = vi.fn();
  const gate = deferred<void>();
  lifecycle.run.mockImplementationOnce(() =>
    gate.promise.then(() => {
      throw new Error("relay rejected");
    }),
  );
  render(
    <ChannelLifecycleDialog
      channelId="id"
      channelName="Fixture"
      action="delete"
      lifecycle={lifecycle}
      completed={completed}
      close={close}
    />,
  );
  const confirm = screen.getByRole("button", {
    name: "Delete channel",
  }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  await user.type(
    screen.getByRole("textbox", { name: "Channel name confirmation" }),
    "Fixture",
  );
  await user.click(confirm);
  await waitFor(() => expect(lifecycle.run).toHaveBeenCalledOnce());
  expect(confirm.disabled).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  gate.resolve();
  expect((await screen.findByRole("alert")).textContent).toBe("relay rejected");
  expect(completed).not.toHaveBeenCalled();
  expect(confirm.disabled).toBe(false);
  await user.click(confirm);
  await waitFor(() => expect(completed).toHaveBeenCalledOnce());
});

it.each(["leave", "hide", "archive"] as const)(
  "%s requires confirmation and ignores completion after unmount",
  async (action) => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute("open", "");
    });
    const lifecycle = capability();
    const gate = deferred<void>();
    lifecycle.run.mockImplementationOnce(() => gate.promise);
    const completed = vi.fn();
    const user = userEvent.setup();
    const view = render(
      <ChannelLifecycleDialog
        channelId="id"
        channelName="Fixture"
        action={action}
        lifecycle={lifecycle}
        close={() => {}}
        completed={completed}
      />,
    );
    expect(lifecycle.run).not.toHaveBeenCalled();
    const label = {
      leave: "Leave channel",
      hide: "Hide conversation",
      archive: "Archive channel",
    }[action];
    await user.click(screen.getByRole("button", { name: label }));
    expect(lifecycle.run).toHaveBeenCalledWith(
      action,
      "id",
      expect.any(AbortSignal),
    );
    const signal = vi.mocked(lifecycle.run).mock.calls[0]?.[2];
    view.unmount();
    expect(signal?.aborted).toBe(true);
    gate.resolve();
    await gate.promise;
    expect(completed).not.toHaveBeenCalled();
  },
);
it("uncertain delivery keeps the dialog recoverable without offering blind resubmission", async () => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute("open", "");
  });
  const lifecycle = capability();
  lifecycle.run.mockRejectedValueOnce(
    new ChannelLifecycleUnconfirmed("connection lost"),
  );
  const user = userEvent.setup();
  const close = vi.fn();
  render(
    <ChannelLifecycleDialog
      channelId="id"
      channelName="Fixture"
      action="leave"
      lifecycle={lifecycle}
      close={close}
      completed={() => {}}
    />,
  );
  const confirm = screen.getByRole("button", {
    name: "Leave channel",
  }) as HTMLButtonElement;
  await user.click(confirm);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "may have taken effect",
  );
  expect(confirm.disabled).toBe(true);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(close).toHaveBeenCalledOnce();
  expect(lifecycle.run).toHaveBeenCalledOnce();
});
