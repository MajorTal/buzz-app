// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { formStateToYaml, yamlToFormState } from "./workflowFormTypes";
import type { RelaySession } from "../../features/relay/session";
import { WorkflowCommunity } from "./WorkflowsPage";
import {
  createWorkflowFixture,
  fixtureChannel,
  fixtureDefinition,
  fixtureViewer,
  fixtureYaml,
} from "./fixtures";
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);
afterEach(cleanup);

function mount(initialYaml = fixtureYaml, owner = fixtureViewer, save = true) {
  const fixture = createWorkflowFixture();
  fixture.definitions.update({
    status: "ready",
    data: {
      partial: false,
      items: [{ ...fixtureDefinition, owner, yaml: initialYaml }],
    },
  });
  const list = {
    status: "ready",
    coverage: "complete",
    channels: [{ id: fixtureChannel, name: "Fixture channel" }],
  };
  const session = {
    workflows: {
      ...fixture.capability,
      availability: { ...fixture.capability.availability, save },
    },
    channels: {
      list: () => list,
      ensureList: () => {},
      subscribeList: () => () => {},
    },
  } as unknown as RelaySession;
  render(<WorkflowCommunity session={session} viewer={fixtureViewer} />);
  return fixture;
}

it("delivers a late webhook secret on the landing page after confirmed navigation", async () => {
  const fixture = mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Open Message helper" }),
  );
  fireEvent.click(screen.getByRole("tab", { name: "YAML" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Workflow YAML" }), {
    target: { value: fixtureYaml.replace("message_posted", "webhook") },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(fixture.calls.save).toBe(1);
  expect(fixture.capability.operations.snapshot()[0]?.outcome).toBe("pending");
  fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
  const confirm = await screen.findByRole("alertdialog", {
    name: "Leave this draft?",
  });
  fireEvent.click(within(confirm).getByRole("button", { name: "Leave draft" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("region", { name: "Workflow editor" }),
    ).toBeNull(),
  );
  await act(async () => {
    fixture.finish("succeeded", true, "DISPOSABLE-NAVIGATION-SECRET");
  });
  expect(screen.getByRole("dialog", { name: "Webhook ready" })).toBeVisible();
  expect(screen.getByTestId("webhook-secret")).toHaveTextContent(
    "•".repeat(24),
  );
  expect(fixture.calls.take).toBe(1);
  expect(document.body.textContent).not.toContain(
    "DISPOSABLE-NAVIGATION-SECRET",
  );
});

it("labels landing controls as configuration and retains the runtime caveat in detail", async () => {
  mount();
  expect(
    await screen.findByRole("switch", {
      name: "Enabled in configuration: Message helper",
    }),
  ).not.toBeChecked();
  expect(screen.queryByText("Configuration: Off")).not.toBeInTheDocument();
  expect(
    screen.getByText(/Turning off does not confirm runs have stopped/),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Open Message helper" }));
  expect(
    await screen.findByRole("region", { name: "Workflow editor" }),
  ).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Workflow settings & activity" }),
  );
  expect(
    within(screen.getByRole("dialog", { name: "Edit workflow" })).getByText(
      /Turning off does not confirm runs have stopped/,
    ),
  ).toBeVisible();
});

it("explains another author's disabled controls from the landing through the read-only dialog", async () => {
  const user = userEvent.setup();
  const fixture = mount(fixtureYaml, "22".repeat(32));
  const toggle = await screen.findByRole("switch", {
    name: "Enabled in configuration: Message helper",
  });
  expect(toggle).toHaveAttribute("aria-disabled", "true");
  expect(toggle).toHaveAccessibleDescription(
    "Only the author can change this workflow.",
  );
  const reason = screen.getByText("Only the author can change this workflow.");
  expect(reason).not.toBeVisible();
  expect(screen.queryByText("Read-only")).not.toBeInTheDocument();
  await user.click(toggle);
  await user.click(screen.getByRole("button", { name: "Open Message helper" }));
  const dialog = screen.getByRole("dialog", { name: "View workflow" });
  const controls = within(dialog);
  expect(controls.getByText("Message helper")).toBeVisible();
  await user.click(controls.getByRole("button", { name: "Workflow actions" }));
  expect(
    await screen.findByRole("menuitemcheckbox", { name: "Enable" }),
  ).toHaveAttribute("aria-disabled", "true");
  await user.keyboard("{Escape}");
  expect(
    controls.getByRole("button", { name: "Edit workflow name" }),
  ).toBeDisabled();
  expect(controls.queryByText("Read-only")).not.toBeInTheDocument();
  expect(
    controls.getByText("Only the author can change this workflow."),
  ).not.toBeVisible();
  expect(
    controls.queryByRole("button", { name: "Save changes" }),
  ).not.toBeInTheDocument();
  expect(
    controls.queryByRole("button", { name: /^(Close|Cancel)$/ }),
  ).not.toBeInTheDocument();
  expect(controls.getByRole("tab", { name: "Form" })).toBeVisible();
  await user.click(controls.getByRole("tab", { name: "YAML" }));
  expect(
    controls.getByRole("textbox", { name: "Workflow YAML" }),
  ).toHaveAttribute("readonly");
  await user.click(controls.getByRole("button", { name: "Close editor" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(fixture.calls.save).toBe(0);
});

it("explains a pending toggle until exact readback and then shows the saved state", async () => {
  const user = userEvent.setup();
  const fixture = mount();
  const toggle = await screen.findByRole("switch", {
    name: "Enabled in configuration: Message helper",
  });
  await user.click(toggle);
  await user.click(screen.getByRole("button", { name: "Turn on" }));
  expect(fixture.calls.save).toBe(1);
  expect(toggle).toHaveAttribute("aria-disabled", "true");
  expect(toggle).toHaveAccessibleDescription(
    "Waiting for the submitted change to be resolved.",
  );
  expect(toggle).not.toBeChecked();
  await act(async () => fixture.finish("succeeded"));
  const savedToggle = screen.getByRole("switch", {
    name: "Enabled in configuration: Message helper",
  });
  expect(savedToggle).not.toHaveAttribute("aria-disabled", "true");
  expect(savedToggle).toBeChecked();
  expect(savedToggle).not.toHaveAccessibleDescription();
});

it("describes unavailable host saving without a disclosure", async () => {
  const reason = "Saving is unavailable from this host.";
  const fixture = mount(fixtureYaml, fixtureViewer, false);
  const toggle = await screen.findByRole("switch");
  expect(toggle).toHaveAttribute("aria-disabled", "true");
  expect(toggle).toHaveAccessibleDescription(reason);
  const user = userEvent.setup();
  expect(screen.queryByText("Saving unavailable")).not.toBeInTheDocument();
  expect(screen.getByText(reason)).not.toBeVisible();
  await user.click(toggle);
  expect(fixture.calls.save).toBe(0);
});

it("does not show unreadable YAML as an enabled configuration", async () => {
  const fixture = mount("name: [");
  const restriction = await screen.findByText("Unreadable configuration");
  expect(restriction).toBeVisible();
  expect(restriction.closest("details")).toBeNull();
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  expect(fixture.calls.save).toBe(0);
});

it("shows valid omitted-enabled configuration as on", async () => {
  mount(fixtureYaml.replace("enabled: false\n", ""));
  expect(
    await screen.findByRole("switch", {
      name: "Enabled in configuration: Message helper",
    }),
  ).toBeChecked();
});

it("keeps the editor mounted through exact readback beneath the one-time secret", async () => {
  const fixture = mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Open Message helper" }),
  );
  const editor = screen.getByRole("dialog", { name: "Edit workflow" });
  fireEvent.click(screen.getByRole("tab", { name: "YAML" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Workflow YAML" }), {
    target: { value: fixtureYaml.replace("message_posted", "webhook") },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await act(async () => {
    fixture.finish("succeeded", true, "DISPOSABLE-SAVE-SECRET");
  });
  expect(editor).toBeInTheDocument();
  expect(screen.getByRole("dialog", { name: "Webhook ready" })).toBeVisible();
  expect(fixture.calls.take).toBe(1);
  expect(document.body.textContent).not.toContain("DISPOSABLE-SAVE-SECRET");
  fireEvent.click(
    screen.getByRole("button", { name: "Reveal webhook secret" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByRole("dialog", { name: "Edit workflow" })).toBe(editor);
  expect(screen.getByRole("textbox", { name: "Workflow YAML" })).toHaveValue(
    fixtureYaml.replace("message_posted", "webhook"),
  );
});

it.each(["discard", "remove"])(
  "guards canonical YAML's incomplete local condition until %s",
  async (finish) => {
    const parsed = yamlToFormState(fixtureYaml);
    if (!parsed.ok) throw new Error(parsed.error);
    const canonical = formStateToYaml(parsed.state);
    const fixture = mount(canonical);
    const user = userEvent.setup();
    const warnsOnUnload = () =>
      !window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
    await user.click(
      await screen.findByRole("button", { name: "Open Message helper" }),
    );
    expect(warnsOnUnload()).toBe(false);
    await user.click(
      screen.getByRole("button", { name: "Edit trigger: Message posted" }),
    );
    await user.click(screen.getByRole("combobox", { name: "Add condition" }));
    await user.click(await screen.findByRole("option", { name: "Author" }));
    await user.type(
      screen.getByRole("textbox", { name: "Value" }),
      "partial-pubkey",
    );
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(warnsOnUnload()).toBe(true);
    await user.click(screen.getByRole("button", { name: "Close inspector" }));
    await user.click(screen.getByRole("button", { name: "Close editor" }));
    const confirm = screen.getByRole("alertdialog", {
      name: "Leave this draft?",
    });
    await user.click(
      within(confirm).getByRole("button", { name: "Keep editing" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Edit trigger: Message posted" }),
    );
    expect(screen.getByRole("textbox", { name: "Value" })).toHaveValue(
      "partial-pubkey",
    );
    if (finish === "remove") {
      await user.click(
        screen.getByRole("button", { name: "Remove Author condition" }),
      );
      expect(warnsOnUnload()).toBe(false);
      await user.click(screen.getByRole("tab", { name: "YAML" }));
      // Prove this was a form-only edit, not incidental YAML reformatting.
      expect(
        screen.getByRole("textbox", { name: "Workflow YAML" }),
      ).toHaveValue(canonical);
    } else {
      await user.click(screen.getByRole("button", { name: "Close inspector" }));
    }
    await user.click(screen.getByRole("button", { name: "Close editor" }));
    if (finish === "discard") {
      await user.click(
        within(
          screen.getByRole("alertdialog", { name: "Leave this draft?" }),
        ).getByRole("button", { name: "Leave draft" }),
      );
    }
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Edit workflow" }),
      ).toBeNull(),
    );
    expect(warnsOnUnload()).toBe(false);
    expect(fixture.calls.save).toBe(0);
    await user.click(
      screen.getByRole("button", { name: "Open Message helper" }),
    );
    await user.click(screen.getByRole("tab", { name: "YAML" }));
    expect(screen.getByRole("textbox", { name: "Workflow YAML" })).toHaveValue(
      canonical,
    );
  },
);

it("discards form-only state on same-revision review and re-arms the next draft's guards", async () => {
  const parsed = yamlToFormState(fixtureYaml);
  if (!parsed.ok) throw new Error(parsed.error);
  const canonical = formStateToYaml(parsed.state);
  const fixture = mount(canonical);
  // Retain an older successful operation whose current head is a different revision.
  await act(async () => {
    fixture.capability.save({
      channelId: fixtureChannel,
      existing: fixtureDefinition,
      yaml: canonical,
    });
    fixture.finish("succeeded", false);
  });
  const user = userEvent.setup();
  const warnsOnUnload = () =>
    !window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
  await user.click(
    await screen.findByRole("button", { name: "Open Message helper" }),
  );
  // Repeat so replacement keys must be fresh, not merely differ from the first key.
  for (const value of ["first-partial", "second-partial"]) {
    const editor = screen.getByRole("dialog", { name: "Edit workflow" });
    expect(warnsOnUnload()).toBe(false);
    await user.click(
      screen.getByRole("button", { name: "Edit trigger: Message posted" }),
    );
    await user.click(screen.getByRole("combobox", { name: "Add condition" }));
    await user.click(await screen.findByRole("option", { name: "Author" }));
    await user.type(screen.getByRole("textbox", { name: "Value" }), value);
    expect(warnsOnUnload()).toBe(true);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Close inspector" }));
    await user.click(
      screen.getByRole("button", { name: "Workflow settings & activity" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Review current configuration" }),
    );
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("dialog", { name: "Edit workflow" })).toBe(editor);
    expect(warnsOnUnload()).toBe(true);
    await user.click(
      screen.getByRole("button", { name: "Edit trigger: Message posted" }),
    );
    expect(screen.getByRole("textbox", { name: "Value" })).toHaveValue(value);
    await user.click(screen.getByRole("button", { name: "Close inspector" }));
    await user.click(
      screen.getByRole("button", { name: "Review current configuration" }),
    );
    await user.click(screen.getByRole("button", { name: "Leave draft" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(warnsOnUnload()).toBe(false);
    await user.click(
      screen.getByRole("button", { name: "Edit trigger: Message posted" }),
    );
    expect(screen.queryByRole("textbox", { name: "Value" })).toBeNull();
    expect(editor).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
    await user.click(screen.getByRole("tab", { name: "YAML" }));
    expect(screen.getByRole("textbox", { name: "Workflow YAML" })).toHaveValue(
      canonical,
    );
    await user.click(screen.getByRole("tab", { name: "Form" }));
  }
  await user.click(screen.getByRole("button", { name: "Close editor" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Edit workflow" })).toBeNull(),
  );
  expect(warnsOnUnload()).toBe(false);
  expect(fixture.calls.save).toBe(1);
});
