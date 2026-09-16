// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { parse as parseYaml } from "yaml";
import { afterEach, expect, it } from "vitest";
import { WorkflowChannel } from "./WorkflowChannel";
import {
  createWorkflowFixture,
  fixtureChannel,
  fixtureCursor,
  fixtureViewer,
} from "./fixtures";

afterEach(cleanup);

function mount() {
  const fixture = createWorkflowFixture();
  const user = userEvent.setup();
  render(
    <StrictMode>
      <WorkflowChannel
        capability={fixture.capability}
        channelId={fixtureChannel}
        channelName="Fixture channel"
        viewer={fixtureViewer}
      />
    </StrictMode>,
  );
  return { fixture, user };
}

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Message helper" }));
}

const button = (name: string) => screen.getByRole("button", { name });
const nameInput = () => screen.getByRole("textbox", { name: "Workflow name" });

it("loads paged history lazily and acknowledges an unknown run without replay", async () => {
  const { fixture, user } = mount();
  await open(user);
  expect(fixture.calls.runs).toBe(0);
  await user.click(button("Read runs"));
  expect(await screen.findByText("Current step: 1")).toBeVisible();
  await user.click(button("Older runs"));
  expect(
    await screen.findByText("No runs returned on this page."),
  ).toBeVisible();
  expect(fixture.runCursor()).toEqual(fixtureCursor);
  expect(fixture.runViews.slice(0, -1).every((view) => view.disposed())).toBe(
    true,
  );
  await user.click(button("Hide runs"));
  expect(fixture.runViews.every((view) => view.disposed())).toBe(true);

  await user.click(button("Run now"));
  act(() => fixture.finish("unknown"));
  const id = fixture.capability.operations.snapshot().at(-1)?.eventId;
  expect(button("Run now")).toBeDisabled();
  expect(screen.getByText(/The run may have started/)).toBeVisible();
  await user.click(button("Close editor"));
  await open(user);
  expect(button("Run now")).toBeDisabled();
  expect(button("Save workflow")).toBeDisabled();
  expect(fixture.calls.trigger).toBe(1);
  await user.click(button("Dismiss notice"));
  expect(screen.getByRole("alertdialog")).toHaveTextContent(
    "does not undo, cancel or repeat",
  );
  await user.click(button("Dismiss notice and continue"));
  expect(button("Run now")).toBeEnabled();
  expect(button("Save workflow")).toBeEnabled();
  expect(fixture.calls.dismiss).toEqual([id]);
  expect(fixture.calls.trigger).toBe(1);
});

it("adopts an exact lost-save readback without resubmitting", async () => {
  const { fixture, user } = mount();
  await open(user);
  await user.clear(nameInput());
  await user.type(nameInput(), "Saved without response");
  await user.click(button("Save workflow"));
  act(() => {
    fixture.saveOnServer();
    fixture.finish("unknown");
  });
  expect(button("Save workflow")).toBeDisabled();
  await user.click(button("Check saved configuration"));
  expect(button("Save workflow")).toBeEnabled();
  expect(nameInput()).toHaveValue("Saved without response");
  expect(fixture.calls.save).toBe(1);
  await user.type(
    screen.getByRole("textbox", { name: "Message text" }),
    " edit",
  );
  await user.click(button("Save workflow"));
  expect(fixture.calls.save).toBe(2);
});

it("requires explicit different-head recovery and restores a failed dismissal", async () => {
  const { fixture, user } = mount();
  await open(user);
  await user.clear(nameInput());
  await user.type(nameInput(), "Retained local draft");
  await user.click(button("Save workflow"));
  act(() => {
    fixture.saveOnServer(false);
    fixture.finish("unknown");
  });
  await user.click(button("Check saved configuration"));
  expect(button("Save workflow")).toBeDisabled();
  expect(button("Review current configuration")).toBeVisible();
  await user.click(button("Dismiss notice"));
  await user.keyboard("{Escape}");
  expect(fixture.calls.dismiss).toEqual([]);
  expect(button("Save workflow")).toBeDisabled();

  fixture.setDismissError("Fixture dismissal failed");
  await user.click(button("Dismiss notice"));
  await user.click(button("Dismiss notice and continue"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Fixture dismissal failed",
  );
  await user.keyboard("{Escape}");
  expect(button("Save workflow")).toBeDisabled();
  fixture.setDismissError();
  await user.click(button("Dismiss notice"));
  await user.click(button("Dismiss notice and continue"));
  expect(button("Save workflow")).toBeEnabled();
  expect(nameInput()).toHaveValue("Retained local draft");
  expect(fixture.calls.save).toBe(1);
  await user.click(button("Save workflow"));
  expect(fixture.calls.save).toBe(2);
});

it("keeps optimistic dismissal modal and ownership locked until settlement", async () => {
  const { fixture, user } = mount();
  await open(user);
  await user.clear(nameInput());
  await user.type(nameInput(), "Kept draft");
  await user.click(button("Save workflow"));
  act(() => fixture.finish("unknown"));
  const operationId = fixture.capability.operations.snapshot()[0]?.eventId;

  for (const failure of ["Journal unavailable", undefined]) {
    fixture.setDismissError(failure);
    fixture.holdDismiss();
    await user.click(button("Dismiss notice"));
    const dialog = screen.getByRole("alertdialog", {
      name: "Dismiss this notice?",
    });
    try {
      await user.click(
        within(dialog).getByRole("button", {
          name: "Dismiss notice and continue",
        }),
      );
      expect(fixture.capability.operations.snapshot()).toHaveLength(0);
      expect(dialog).toBeVisible();
      expect(
        within(dialog).getByRole("button", { name: "Dismissing…" }),
      ).toBeDisabled();
      expect(
        within(dialog).getByRole("button", { name: "Keep editing" }),
      ).toBeDisabled();
      await user.keyboard("{Escape}");
      expect(dialog).toBeVisible();
      expect(
        screen.queryByRole("button", { name: "Close editor" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "New workflow" }),
      ).not.toBeInTheDocument();
      expect(fixture.calls.save).toBe(1);
    } finally {
      await act(async () => fixture.releaseDismiss());
    }
    if (failure) {
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(
        failure,
      );
      expect(
        fixture.capability.operations.snapshot().map((op) => op.eventId),
      ).toEqual([operationId]);
      await user.keyboard("{Escape}");
      expect(button("Save workflow")).toBeDisabled();
      expect(nameInput()).toHaveValue("Kept draft");
    } else {
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(button("Save workflow")).toBeEnabled();
      expect(nameInput()).toHaveValue("Kept draft");
    }
  }
  expect(fixture.calls.dismiss).toEqual([operationId, operationId]);
  expect(fixture.calls.save).toBe(1);
  await user.click(button("Save workflow"));
  expect(fixture.calls.save).toBe(2);
});

it("treats legacy deletion as a request rather than verified removal", async () => {
  const { fixture, user } = mount();
  await open(user);
  await user.click(button("Delete workflow"));
  expect(screen.getByRole("alertdialog")).toHaveTextContent(
    "does not confirm runtime deletion",
  );
  await user.click(button("Request deletion"));
  act(() => fixture.finish("succeeded"));
  expect(
    screen.getByText(/Deletion request accepted\. The saved configuration/),
  ).toBeVisible();
  expect(button("Message helper")).toBeVisible();
  await user.click(button("Dismiss notice"));
  await user.click(button("Dismiss notice and continue"));
  expect(button("Save workflow")).toBeEnabled();
  expect(fixture.calls.delete).toBe(1);
});

it("retains invalid timeout boundaries in both modes and saves exact valid YAML", async () => {
  const { fixture, user } = mount();
  await open(user);
  await user.click(screen.getByText("Step options", { exact: true }));
  for (const input of ["oops", "0s", "1.5", "9007199254740992"]) {
    const timeout = screen.getByRole("textbox", {
      name: "Step timeout (optional)",
    });
    await user.clear(timeout);
    await user.type(timeout, input);
    expect(timeout).toHaveValue(input);
    expect(button("Save workflow")).toBeDisabled();
    expect(screen.getByText(/positive whole number/)).toHaveAttribute(
      "role",
      "status",
    );
    await user.click(screen.getByRole("tab", { name: "YAML" }));
    const yaml = screen.getByRole("textbox", { name: "Workflow YAML" });
    expect(
      parseYaml((yaml as HTMLTextAreaElement).value).steps[0].timeout_secs,
    ).toBe(input);
    expect(button("Save workflow")).toBeDisabled();
    await user.click(screen.getByRole("tab", { name: "Form" }));
    await user.click(screen.getByText("Step options", { exact: true }));
    expect(
      screen.getByRole("textbox", { name: "Step timeout (optional)" }),
    ).toHaveValue(input);
  }
  await user.click(button("Close editor"));
  expect(
    screen.getByRole("alertdialog", { name: "Leave this draft?" }),
  ).toBeVisible();
  await user.click(button("Keep editing"));
  const timeout = screen.getByRole("textbox", {
    name: "Step timeout (optional)",
  });
  expect(timeout).toHaveValue("9007199254740992");
  await user.clear(timeout);
  await user.type(timeout, "5m");
  expect(button("Save workflow")).toBeEnabled();
  await user.click(button("Save workflow"));
  expect(fixture.calls.save).toBe(1);
  expect(parseYaml(fixture.input()?.yaml ?? "").steps[0].timeout_secs).toBe(
    300,
  );
  act(() => fixture.finish("succeeded"));
  expect(button("Save workflow")).toBeEnabled();
  if (!timeout.isConnected)
    await user.click(screen.getByText("Step options", { exact: true }));
  const currentTimeout = screen.getByRole("textbox", {
    name: "Step timeout (optional)",
  });
  await user.clear(currentTimeout);
  await user.type(currentTimeout, " ");
  await user.click(button("Save workflow"));
  expect(fixture.calls.save).toBe(2);
  expect(parseYaml(fixture.input()?.yaml ?? "").steps[0]).not.toHaveProperty(
    "timeout_secs",
  );
});

it("allocates unused IDs after a parsed ID beyond the safe integer boundary", async () => {
  const { user } = mount();
  await open(user);
  await user.click(screen.getByRole("tab", { name: "YAML" }));
  const yaml = screen.getByRole("textbox", { name: "Workflow YAML" });
  const definition = parseYaml((yaml as HTMLTextAreaElement).value);
  definition.steps[0].id = "step_9007199254740992";
  fireEvent.change(yaml, { target: { value: JSON.stringify(definition) } });
  await user.click(screen.getByRole("tab", { name: "Form" }));
  await user.click(button("Add Send Message"));
  const messages = screen.getAllByRole("textbox", { name: "Message text" });
  expect(messages).toHaveLength(2);
  const addedMessage = messages[1];
  if (!addedMessage) throw new Error("Expected the added message field");
  await user.type(addedMessage, "Another message");
  await user.click(button("Add Delay"));
  await user.click(screen.getByRole("tab", { name: "YAML" }));
  expect(
    parseYaml(
      (
        screen.getByRole("textbox", {
          name: "Workflow YAML",
        }) as HTMLTextAreaElement
      ).value,
    ).steps.map((step: { id: string }) => step.id),
  ).toEqual(["step_9007199254740992", "step_1", "step_2"]);
});
