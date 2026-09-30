// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode, useRef, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { PanelWorkspace, usePanelTabTitle } from "./PanelWorkspace";
import { PanelSubview } from "./PanelSubview";
import { PanelDock } from "./PanelDock";

afterEach(cleanup);
function Profile({ authorized }: { authorized: boolean }) {
  usePanelTabTitle("Ada");
  const [log, setLog] = useState(false);
  return (
    <>
      <input aria-label="Profile draft" />
      <button type="button" onClick={() => setLog(true)}>
        Open log
      </button>
      {log && authorized && (
        <PanelSubview
          title="Harness log"
          backLabel="Back to profile"
          onBack={() => setLog(false)}
        >
          <input aria-label="Log filter" />
        </PanelSubview>
      )}
    </>
  );
}
function Fixture({
  authorized = true,
  focusOnMount = true,
}: {
  authorized?: boolean;
  focusOnMount?: boolean;
}) {
  const [ids, setIds] = useState(["Thread", "Profile"]);
  const [value, select] = useState("Thread");
  return ids.length ? (
    <PanelWorkspace
      focusOnMount={focusOnMount}
      value={value}
      select={select}
      items={ids.map((id) => ({
        id,
        label: id,
        close() {
          const next = ids.filter((item) => item !== id);
          setIds(next);
          if (id === value) select(next[0] ?? "");
        },
        content:
          id === "Thread" ? (
            <input aria-label="Thread draft" />
          ) : (
            <Profile authorized={authorized} />
          ),
      }))}
    />
  ) : (
    <p>No open panels</p>
  );
}
const tabs = () => screen.getByRole("tablist", { name: "Panel tabs" });
const tab = (name: string) => within(tabs()).getByRole("tab", { name });

test("switches retained panels, associates their tabs, and closes inactive or active tabs with focus recovery", async () => {
  const user = userEvent.setup();
  render(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
  const draft = screen.getByRole("textbox", { name: "Thread draft" });
  await user.type(draft, "Keep this draft");
  expect(screen.getByRole("tabpanel", { name: "Thread" })).toContainElement(
    draft,
  );
  await user.click(tab("Ada"));
  expect(screen.queryByRole("textbox", { name: "Thread draft" })).toBeNull();
  expect(draft).toBeInTheDocument();
  await user.click(tab("Thread"));
  expect(screen.getByRole("textbox", { name: "Thread draft" })).toBe(draft);
  expect(draft).toHaveValue("Keep this draft");
  await user.click(screen.getByRole("button", { name: "Close Ada tab" }));
  expect(tab("Thread")).toHaveFocus();
  await user.keyboard("{Delete}");
  expect(screen.getByText("No open panels")).toBeVisible();
});

test("local details are retained sibling tabs and close without dismissing the profile", async () => {
  const user = userEvent.setup();
  render(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
  await user.click(tab("Ada"));
  await user.click(screen.getByRole("button", { name: "Open log" }));
  expect(tab("Harness log")).toHaveFocus();
  const filter = screen.getByRole("textbox", { name: "Log filter" });
  await user.type(filter, "warning");
  await user.click(tab("Ada"));
  expect(screen.getByRole("textbox", { name: "Profile draft" })).toBeVisible();
  expect(filter).toBeInTheDocument();
  await user.click(tab("Harness log"));
  expect(screen.getByRole("textbox", { name: "Log filter" })).toBe(filter);
  expect(filter).toHaveValue("warning");
  await user.keyboard("{Escape}");
  expect(within(tabs()).queryByRole("tab", { name: "Harness log" })).toBeNull();
  expect(tab("Ada")).toHaveFocus();
  expect(filter).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Open log" }));
  await user.click(tab("Ada"));
  await user.click(
    screen.getByRole("button", { name: "Close Harness log tab" }),
  );
  expect(tab("Ada")).toHaveFocus();
  expect(within(tabs()).queryByRole("tab", { name: "Harness log" })).toBeNull();
});

test("revoking access removes the local tab; closing its owner also removes retained local content", async () => {
  const user = userEvent.setup();
  const view = render(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
  await user.click(tab("Ada"));
  await user.click(screen.getByRole("button", { name: "Open log" }));
  view.rerender(
    <StrictMode>
      <Fixture authorized={false} />
    </StrictMode>,
  );
  expect(
    screen.queryByRole("textbox", { name: "Log filter", hidden: true }),
  ).toBeNull();
  expect(tab("Ada")).toHaveFocus();
  view.rerender(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
  await user.click(tab("Thread"));
  await user.click(screen.getByRole("button", { name: "Close Ada tab" }));
  expect(
    screen.queryByRole("textbox", { name: "Log filter", hidden: true }),
  ).toBeNull();
  expect(within(tabs()).getAllByRole("tab")).toHaveLength(1);
  expect(tab("Thread")).toHaveFocus();
});

for (const action of ["close", "escape"]) {
  test(`reopening the last tab during its ${action} exit restores focus`, async () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const original = HTMLElement.prototype.getAnimations;
    Object.defineProperty(HTMLElement.prototype, "getAnimations", {
      configurable: true,
      writable: true,
      value: () => [{ finished }],
    });
    function Host() {
      const [opening, setOpening] = useState<object | null>(null);
      const open = !!opening;
      const trigger = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={trigger} type="button" onClick={() => setOpening({})}>
            Open profile
          </button>
          <PanelDock open={open} className="">
            {opening && (
              <PanelWorkspace
                value="profile"
                select={() => {}}
                items={[
                  {
                    id: "profile",
                    instance: opening,
                    label: "Profile",
                    content: <input aria-label="Profile draft" />,
                    close() {
                      setOpening(null);
                      trigger.current?.focus();
                    },
                  },
                ]}
              />
            )}
          </PanelDock>
        </>
      );
    }
    try {
      render(<Host />);
      const trigger = screen.getByRole("button", { name: "Open profile" });
      fireEvent.click(trigger);
      expect(tab("Profile")).toHaveFocus();
      if (action === "close")
        fireEvent.click(
          screen.getByRole("button", { name: "Close Profile tab" }),
        );
      else fireEvent.keyDown(tab("Profile"), { key: "Escape" });
      expect(trigger).toHaveFocus();
      expect(
        screen
          .getByRole("textbox", { name: "Profile draft", hidden: true })
          .closest("[inert]"),
      ).not.toBeNull();
      fireEvent.click(trigger);
      expect(tab("Profile")).toHaveFocus();
      await act(async () => finish());
      expect(tab("Profile")).toHaveFocus();
    } finally {
      finish();
      if (original) HTMLElement.prototype.getAnimations = original;
      else Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
    }
  });
}

test("a restored workspace leaves existing focus alone but fresh selections and local details take focus", async () => {
  const user = userEvent.setup();
  const view = render(<input aria-label="Main draft" />);
  const main = screen.getByRole("textbox", { name: "Main draft" });
  main.focus();
  view.rerender(
    <>
      <input aria-label="Main draft" />
      <StrictMode>
        <Fixture focusOnMount={false} />
      </StrictMode>
    </>,
  );
  expect(main).toHaveFocus();
  await user.click(tab("Ada"));
  expect(tab("Ada")).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Open log" }));
  expect(tab("Harness log")).toHaveFocus();
});

test("Escape cancelling IME composition does not close the tab", () => {
  render(<Fixture />);
  const draft = screen.getByRole("textbox", { name: "Thread draft" });
  draft.focus();
  fireEvent.keyDown(draft, { key: "Escape", isComposing: true });
  expect(draft).toHaveFocus();
  fireEvent.keyDown(draft, { key: "Escape", keyCode: 229 });
  expect(draft).toHaveFocus();
  fireEvent.keyDown(draft, { key: "Escape" });
  expect(draft).not.toBeInTheDocument();
  expect(tab("Ada")).toHaveFocus();
});
