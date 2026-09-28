// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  WorkflowDefinitions,
  WorkflowOperation,
  WorkflowView,
} from "../../features/workflows/types";
import { WorkflowOperations } from "./WorkflowOperations";
import { fixtureDefinition } from "./fixtures";

afterEach(cleanup);
const operation: WorkflowOperation = {
  eventId: "deletion",
  workflow: fixtureDefinition,
  action: "delete",
  outcome: "succeeded",
  delivery: "accepted",
};
type Snapshot = ReturnType<WorkflowView<WorkflowDefinitions>["snapshot"]>;

it.each<[string, Snapshot, WorkflowOperation["outcome"]]>([
  [
    "unknown receipt",
    { status: "ready", data: { items: [], partial: false } },
    "unknown",
  ],
  [
    "partial read",
    { status: "ready", data: { items: [], partial: true } },
    "succeeded",
  ],
  [
    "read error",
    { status: "error", data: { items: [], partial: false } },
    "succeeded",
  ],
  [
    "unavailable read",
    { status: "unavailable", data: { items: [], partial: false } },
    "succeeded",
  ],
  [
    "cleared read",
    { status: "idle", data: { items: [], partial: false } },
    "succeeded",
  ],
])(
  "does not claim deletion after %s and checks without resubmitting",
  async (_name, snapshot, outcome) => {
    const onCheckSaved = vi.fn().mockResolvedValue(undefined);
    render(
      <WorkflowOperations
        operations={[{ ...operation, outcome }]}
        snapshot={snapshot}
        onCheckSaved={onCheckSaved}
        onReviewSaved={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Couldn't confirm deletion. Check saved configuration before deleting again.",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Check saved configuration" }),
    );
    expect(onCheckSaved).toHaveBeenCalledOnce();
    expect(
      await screen.findByRole("button", { name: "Check saved configuration" }),
    ).toBeInTheDocument();
  },
);

it("explains deletion dismissal without claiming cancellation or repeating deletion", async () => {
  const onDismiss = vi.fn().mockResolvedValue(undefined);
  render(
    <WorkflowOperations
      operations={[{ ...operation, outcome: "unknown" }]}
      snapshot={{
        status: "ready",
        data: { items: [fixtureDefinition], partial: false },
      }}
      onCheckSaved={vi.fn()}
      onReviewSaved={vi.fn()}
      onDismiss={onDismiss}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
  const dialog = await screen.findByRole("alertdialog", {
    name: "Dismiss this notice?",
  });
  expect(dialog).toHaveTextContent(
    "Your draft is kept and editing is unlocked. Dismissing this notice does not confirm, cancel, or repeat deletion.",
  );
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Dismiss notice and continue" }),
  );
  expect(onDismiss).toHaveBeenCalledWith("deletion");
});
