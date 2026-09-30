// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode, useEffect, useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { PanelSubview, PanelSubviewHost } from "./PanelSubview";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";

afterEach(cleanup);
function Fixture({
  authorized = true,
  close,
  removeTrigger = false,
}: {
  authorized?: boolean;
  removeTrigger?: boolean;
  close(): void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!authorized) setOpen(false);
  }, [authorized]);
  return (
    <PanelSubviewHost close={close}>
      <PanelHeader title="Profile" />
      <input aria-label="Draft" defaultValue="Keep me" />
      {(!removeTrigger || authorized) && (
        <button type="button" onClick={() => setOpen(true)}>
          Open log
        </button>
      )}
      {open && authorized && (
        <PanelSubview
          title="Harness log"
          backLabel="Back to profile"
          onBack={() => setOpen(false)}
        >
          <p>Private log</p>
        </PanelSubview>
      )}
    </PanelSubviewHost>
  );
}

test("a local subview owns the only accessible header and restores its retained trigger", async () => {
  const user = userEvent.setup();
  const close = vi.fn();
  render(
    <StrictMode>
      <Fixture close={close} />
    </StrictMode>,
  );
  const draft = screen.getByRole("textbox");
  const trigger = screen.getByRole("button", { name: "Open log" });
  await user.type(draft, " edited");
  await user.click(trigger);
  expect(screen.getByRole("button", { name: "Back to profile" })).toHaveFocus();
  expect(screen.queryByRole("heading", { name: "Profile" })).toBeNull();
  expect(draft).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(screen.getByRole("textbox")).toBe(draft);
  expect(draft).toHaveValue("Keep me edited");
  expect(trigger).toHaveFocus();
  expect(close).not.toHaveBeenCalled();
  await user.click(trigger);
  await user.click(
    screen.getByRole("button", { name: "Close harness log panel" }),
  );
  expect(close).toHaveBeenCalledOnce();
});

test("revoking a local detail removes its chrome and returns focus to the covered view", async () => {
  const user = userEvent.setup();
  const close = vi.fn();
  const view = render(
    <StrictMode>
      <Fixture close={close} />
    </StrictMode>,
  );
  const trigger = screen.getByRole("button", { name: "Open log" });
  await user.click(trigger);
  view.rerender(
    <StrictMode>
      <Fixture authorized={false} close={close} />
    </StrictMode>,
  );
  expect(screen.queryByRole("region", { name: "Harness log" })).toBeNull();
  expect(screen.getByRole("heading", { name: "Profile" })).toBeVisible();
  expect(trigger).toHaveFocus();
});

test("a removed trigger does not prevent focus restoration after access recovers", async () => {
  const user = userEvent.setup();
  const close = vi.fn();
  const view = render(<Fixture close={close} removeTrigger />);
  const original = screen.getByRole("button", { name: "Open log" });
  await user.click(original);
  view.rerender(<Fixture close={close} removeTrigger authorized={false} />);
  expect(original).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Harness log" })).toBeNull();
  view.rerender(<Fixture close={close} removeTrigger />);
  const restored = screen.getByRole("button", { name: "Open log" });
  await user.click(restored);
  await user.click(screen.getByRole("button", { name: "Back to profile" }));
  expect(restored).toHaveFocus();
});
