// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelKit } from "../../features/channel-templates/capability";
import type { KitEntry } from "../../features/channel-templates/model";
import { ChannelTemplatesDialog } from "./ChannelTemplatesDialog";

afterEach(cleanup);
const entry: KitEntry = {
  eventId: "head",
  createdAt: 1,
  record: {
    version: 1,
    community: "https://relay.example.test",
    deleted: false,
    value: { type: "team", id: "team", name: "Saved team", agents: [] },
  },
};
function fixture() {
  const state = { status: "ready" as const, entries: [entry] };
  const save = vi.fn<ChannelKit["save"]>();
  const kit: ChannelKit = {
    available: true,
    snapshot: () => state,
    subscribe: () => () => {},
    ensure: vi.fn(),
    refresh: vi.fn(),
    save,
  };
  const close = vi.fn();
  render(
    <ChannelTemplatesDialog
      open
      onOpenChange={close}
      kit={kit}
      agents={[]}
      active={() => true}
    />,
  );
  return { save, close };
}
it("delete cancellation closes only the nested layer without deleting or closing the library", async () => {
  const user = userEvent.setup();
  const { save, close } = fixture();
  const trigger = screen.getByRole("button", { name: "Delete" });
  for (const dismissal of ["backdrop", "escape", "close", "cancel"]) {
    await user.click(trigger);
    const confirmation = screen.getByRole("dialog", {
      name: "Delete “Saved team”?",
    });
    await waitFor(() =>
      expect(
        within(confirmation).getByRole("button", { name: "Cancel" }),
      ).toHaveFocus(),
    );
    await user.click(within(confirmation).getByRole("heading"));
    expect(confirmation).toBeInTheDocument();
    if (dismissal === "backdrop")
      await user.click(
        confirmation.parentElement?.querySelector(
          ".buzz-dialog-backdrop",
        ) as Element,
      );
    else if (dismissal === "escape") await user.keyboard("{Escape}");
    else
      await user.click(
        within(confirmation).getByRole("button", {
          name: dismissal === "close" ? "Close" : "Cancel",
        }),
      );
    await waitFor(() => expect(confirmation).not.toBeInTheDocument());
    // jsdom lacks focus({ preventScroll }) detection; browser coverage checks pointer return.
    if (dismissal !== "backdrop")
      await waitFor(() => expect(trigger).toHaveFocus());
    expect(
      screen.getByRole("dialog", { name: "Templates & teams" }),
    ).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  }
  await user.click(document.querySelector(".buzz-dialog-backdrop") as Element);
  expect(close).toHaveBeenCalledExactlyOnceWith(false);
});
it("confirmed deletion preserves the expected revision and locks dismissal until failure", async () => {
  const user = userEvent.setup();
  const { save, close } = fixture();
  let reject!: (error: Error) => void;
  const pending = new Promise<never>((_, no) => {
    reject = no;
  });
  save.mockReturnValueOnce(pending);
  await user.click(screen.getByRole("button", { name: "Delete" }));
  const confirmation = screen.getByRole("dialog", {
    name: "Delete “Saved team”?",
  });
  await user.click(
    within(confirmation).getByRole("button", { name: "Delete" }),
  );
  try {
    expect(save).toHaveBeenCalledExactlyOnceWith(
      entry.record.value,
      "head",
      true,
    );
    await waitFor(() => expect(confirmation).not.toBeInTheDocument());
    expect(
      screen.getByRole("button", { name: "Close templates" }),
    ).toBeDisabled();
    await user.click(
      document.querySelector(".buzz-dialog-backdrop") as Element,
    );
    await user.keyboard("{Escape}");
    expect(close).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      reject(new Error("Delete rejected"));
      await pending.catch(() => {});
    });
  }
  expect(await screen.findByRole("alert")).toHaveTextContent("Delete rejected");
  expect(screen.getByRole("button", { name: "Close templates" })).toBeEnabled();
  await user.click(document.querySelector(".buzz-dialog-backdrop") as Element);
  expect(close).toHaveBeenCalledExactlyOnceWith(false);
  expect(save).toHaveBeenCalledOnce();
});
