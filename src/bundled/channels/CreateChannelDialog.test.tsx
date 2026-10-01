// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import { CreateChannelDialog } from "./CreateChannelDialog";

const providers = {
  snapshot: () => emptyProviders,
  subscribe: () => () => {},
  register: () => {},
};
const emptyProviders = Object.freeze([]);
let store = createRelaySession(null);
const setupProps = () => ({
  session: store.session,
  providers,
  groups: undefined,
  initialGroup: "",
  groupsReady: true,
});
afterEach(() => {
  cleanup();
  store.dispose();
  store = createRelaySession(null);
});

it("reveals description on demand and creates an ongoing open channel", async () => {
  const user = userEvent.setup();
  const onCreate = vi.fn(async () => {});
  const onOpenChange = vi.fn();
  render(
    <CreateChannelDialog
      {...setupProps()}
      open
      onOpenChange={onOpenChange}
      onCreate={onCreate}
    />,
  );
  expect(
    screen.getByRole("dialog", { name: "Create a channel" }),
  ).not.toHaveAccessibleDescription();
  expect(
    screen.queryByRole("textbox", { name: "Description" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Optional")).not.toBeInTheDocument();
  expect(screen.getByText("Duration")).toHaveClass("sr-only");
  expect(screen.getByRole("radiogroup", { name: "Duration" })).toBeVisible();
  expect(screen.getByRole("radio", { name: /Ongoing/ })).toBeChecked();
  const privateSwitch = screen.getByRole("switch", { name: "Private" });
  const privateLabel = screen.getByText("Private", { selector: "label" });
  expect(privateSwitch).not.toBeChecked();
  expect(
    privateSwitch.compareDocumentPosition(privateLabel) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Cancel" }),
  ).not.toBeInTheDocument();
  await user.type(screen.getByRole("textbox", { name: "Name" }), "  launch  ");
  await user.click(screen.getByRole("button", { name: "Add a description" }));
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveFocus();
  await user.type(
    screen.getByRole("textbox", { name: "Description" }),
    "  Release planning  ",
  );
  await user.click(screen.getByRole("button", { name: "Create channel" }));
  await waitFor(() =>
    expect(onCreate).toHaveBeenCalledWith({
      name: "launch",
      description: "Release planning",
      visibility: "open",
    }),
  );
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it("creates a private temporary channel and reports a rejected request", async () => {
  const user = userEvent.setup();
  const onOpenChange = vi.fn();
  const onCreate = vi.fn(async () => {
    throw new Error("Creation rejected");
  });
  render(
    <CreateChannelDialog
      {...setupProps()}
      open
      onOpenChange={onOpenChange}
      onCreate={onCreate}
    />,
  );
  await user.type(screen.getByRole("textbox", { name: "Name" }), "ops");
  await user.click(screen.getByRole("radio", { name: /Temporary/ }));
  await user.click(screen.getByText("Private", { selector: "label" }));
  await user.click(screen.getByRole("button", { name: "Create channel" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Creation rejected",
  );
  expect(onCreate).toHaveBeenCalledWith({
    name: "ops",
    visibility: "private",
    ttlSeconds: 604800,
  });
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(screen.getByRole("radio", { name: /Temporary/ })).toBeChecked();
  expect(screen.getByRole("switch", { name: "Private" })).toBeChecked();
});

it("keeps the visible draft when a pending creation fails", async () => {
  const user = userEvent.setup();
  let rejectCreation!: (reason: Error) => void;
  const onCreate = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectCreation = reject;
      }),
  );
  const onOpenChange = vi.fn();
  const dialog = (pending?: {
    name: string;
    description: string;
    visibility: "private";
    ttlSeconds: number;
  }) => (
    <CreateChannelDialog
      {...setupProps()}
      open
      pending={pending}
      onOpenChange={onOpenChange}
      onCreate={onCreate}
    />
  );
  const view = render(dialog());
  await user.type(screen.getByRole("textbox", { name: "Name" }), "ops");
  await user.click(screen.getByRole("button", { name: "Add a description" }));
  await user.type(
    screen.getByRole("textbox", { name: "Description" }),
    "Incident response",
  );
  await user.click(screen.getByRole("radio", { name: /Temporary/ }));
  await user.click(screen.getByText("Private", { selector: "label" }));
  await user.click(screen.getByRole("button", { name: "Create channel" }));
  await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());

  view.rerender(
    dialog({
      name: "ops",
      description: "Incident response",
      visibility: "private",
      ttlSeconds: 604800,
    }),
  );
  view.rerender(dialog());
  rejectCreation(new Error("Creation rejected"));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Creation rejected",
  );
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("ops");
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
    "Incident response",
  );
  expect(screen.getByRole("radio", { name: /Temporary/ })).toBeChecked();
  expect(screen.getByRole("switch", { name: "Private" })).toBeChecked();
});

it("blocks edits during creation without applying disabled control styles", async () => {
  const user = userEvent.setup();
  let finishCreation!: () => void;
  const onCreate = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishCreation = resolve;
      }),
  );
  const onOpenChange = vi.fn();
  render(
    <CreateChannelDialog
      {...setupProps()}
      open
      onOpenChange={onOpenChange}
      onCreate={onCreate}
    />,
  );
  const name = screen.getByRole("textbox", { name: "Name" });
  const privateSwitch = screen.getByRole("switch", { name: "Private" });
  await user.type(name, "launch");
  await user.click(screen.getByRole("button", { name: "Create channel" }));
  const form = document.getElementById("create-channel-form");
  await waitFor(() => expect(form).toHaveAttribute("inert"));
  expect(form).toHaveAttribute("aria-busy", "true");
  expect(name).not.toBeDisabled();
  expect(privateSwitch).not.toBeDisabled();
  expect(privateSwitch).toHaveAttribute("aria-disabled", "true");
  await user.click(privateSwitch);
  expect(privateSwitch).not.toBeChecked();
  try {
    await user.click(
      document.querySelector(".buzz-dialog-backdrop") as Element,
    );
    await user.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();
  } finally {
    finishCreation();
  }
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
});

it("restores an unconfirmed channel draft after closing and reopening", () => {
  const pending = {
    name: "release-notes",
    description: "Updates for the team",
    visibility: "private" as const,
    ttlSeconds: 604800,
  };
  const onOpenChange = vi.fn();
  const onCreate = vi.fn(async () => {});
  const { rerender } = render(
    <CreateChannelDialog
      {...setupProps()}
      open
      pending={pending}
      onOpenChange={onOpenChange}
      onCreate={onCreate}
    />,
  );
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
    "release-notes",
  );
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
    "Updates for the team",
  );
  expect(screen.getByRole("radio", { name: /Temporary/ })).toBeChecked();
  expect(screen.getByRole("switch", { name: "Private" })).toBeChecked();

  rerender(
    <CreateChannelDialog
      {...setupProps()}
      open={false}
      pending={pending}
      onOpenChange={onOpenChange}
      onCreate={onCreate}
    />,
  );
  rerender(
    <CreateChannelDialog
      {...setupProps()}
      open
      pending={pending}
      onOpenChange={onOpenChange}
      onCreate={onCreate}
    />,
  );
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
    "release-notes",
  );
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
    "Updates for the team",
  );
});

it("resumes frozen setup with the plugin off and unavailable catalogs without recalculating it", async () => {
  const user = userEvent.setup();
  const pending = {
    name: "Recovery",
    visibility: "private" as const,
    setup: {
      agents: ["ab".repeat(32)],
      canvas: "# Frozen plan",
      groupId: "removed-group",
      templateId: "unavailable",
    },
  };
  const onCreate = vi.fn(async () => {});
  render(
    <CreateChannelDialog
      {...setupProps()}
      groupsReady={false}
      open
      pending={pending}
      onOpenChange={() => {}}
      onCreate={onCreate}
    />,
  );
  expect(
    screen.getByRole("region", { name: "Channel setup summary" }),
  ).toHaveTextContent("1 selected agent.");
  expect(document.body.textContent).not.toContain("ab".repeat(32));
  expect(screen.getByRole("textbox", { name: "Name" })).toBeDisabled();
  expect(
    screen.queryByRole("button", {
      name: "Review / customize teams, agents & Canvas",
    }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Retry channel" }));
  await waitFor(() => expect(onCreate).toHaveBeenCalledWith(pending));
});

it("outside dismissal cancels an ordinary create draft without creating", async () => {
  const user = userEvent.setup();
  const onCreate = vi.fn(async () => {});
  const onOpenChange = vi.fn();
  render(
    <CreateChannelDialog
      {...setupProps()}
      open
      onCreate={onCreate}
      onOpenChange={onOpenChange}
    />,
  );
  await user.type(
    screen.getByRole("textbox", { name: "Name" }),
    "Unsent draft",
  );
  expect(onOpenChange).not.toHaveBeenCalled();
  await user.click(document.querySelector(".buzz-dialog-backdrop") as Element);
  expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  expect(onCreate).not.toHaveBeenCalled();
});
