// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { Dialog } from "./Dialog";
import { Button } from "./Button";
import { Input } from "./Input";
import { Field } from "./Field";
import { Tooltip } from "./Tooltip";
import { Tabs } from "./Tabs";
import { NavigationItem } from "./NavigationItem";

afterEach(cleanup);

test("pending dialogs reject close and Escape, then allow dismissal once released", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  const content = (pending: boolean) => (
    <Dialog
      open
      onOpenChange={change}
      preventClose={pending}
      title="Edit notes"
    >
      <Field label="Name">
        <Input />
      </Field>
    </Dialog>
  );
  const view = render(content(true));
  expect(screen.getByRole("dialog", { name: "Edit notes" })).toBeVisible();
  expect(screen.getByRole("dialog", { name: "Edit notes" })).toHaveAttribute(
    "aria-modal",
    "true",
  );
  expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
  await user.click(screen.getByRole("textbox", { name: "Name" }));
  await user.keyboard("{Escape}");
  expect(change).not.toHaveBeenCalled();
  view.rerender(content(false));
  await user.keyboard("{Escape}");
  expect(change).toHaveBeenCalledWith(false);
});

test("dialog close button closes the controlled frame", async () => {
  const user = userEvent.setup();
  function Example() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Edit notes</Button>
        <Dialog
          open={open}
          onOpenChange={setOpen}
          title="Note details"
          description="Edit this example."
        >
          <Field label="Name">
            <Input />
          </Field>
        </Dialog>
      </>
    );
  }
  render(<Example />);
  await user.click(screen.getByRole("button", { name: "Edit notes" }));
  expect(
    screen.getByRole("dialog", { name: "Note details" }),
  ).toHaveAccessibleDescription("Edit this example.");
  await user.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});

test("tabs link each trigger to its visible panel", async () => {
  const user = userEvent.setup();
  function Example() {
    const [value, setValue] = useState("notes");
    return (
      <Tabs
        value={value}
        onValueChange={setValue}
        label="Workspace"
        variant="panel"
        items={[
          { value: "notes", label: "Notes" },
          { value: "activity", label: "Activity" },
        ]}
        renderPanel={(tab) => (
          <p>{tab === "notes" ? "Your notes" : "Recent activity"}</p>
        )}
      />
    );
  }
  render(<Example />);
  const notes = screen.getByRole("tab", { name: "Notes" });
  expect(notes).toHaveAttribute(
    "aria-controls",
    screen.getByRole("tabpanel").id,
  );
  expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Notes");
  await user.click(screen.getByRole("tab", { name: "Activity" }));
  expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Activity");
  expect(screen.getByRole("tabpanel")).toHaveTextContent("Recent activity");
  expect(screen.queryByText("Your notes")).not.toBeInTheDocument();
});

test("navigation keeps warm-read events and data attributes on the focusable button", async () => {
  const user = userEvent.setup();
  const warm = vi.fn();
  const select = vi.fn();
  render(
    <NavigationItem
      label="Notes"
      selected
      data-channel-id="example"
      onPointerEnter={warm}
      onFocus={warm}
      onClick={select}
    />,
  );
  const row = screen.getByRole("button", { name: "Notes" });
  expect(row).toHaveAttribute("data-channel-id", "example");
  expect(row).toHaveAttribute("aria-current", "page");
  await user.hover(row);
  expect(warm).toHaveBeenCalled();
  await user.click(row);
  expect(select).toHaveBeenCalledTimes(1);
});

test("tooltip adds a dismissible hint without replacing the control name", async () => {
  const user = userEvent.setup();
  render(
    <Tooltip content="Create a new note">
      <Button aria-label="Create note">+</Button>
    </Tooltip>,
  );
  const button = screen.getByRole("button", { name: "Create note" });
  await user.hover(button);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "Create a new note",
  );
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument(),
  );
  expect(button).toHaveAccessibleName("Create note");
});
