// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RegisteredPage } from "../../features/pages/service";
import { createServices, type AppServices } from "../services";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { AppShell } from "./AppShell";

vi.mock("../../bundled", () => ({ bundledPlugins: [] }));

// jsdom has no media queries or layout observers; responsive geometry is
// covered in browser tests.
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
let services: AppServices | undefined;
afterEach(async () => {
  cleanup();
  await services?.dispose();
  services = undefined;
  vi.unstubAllGlobals();
});

it("hides and shows the channel sidebar without re-rendering its content", async () => {
  const current = createServices();
  services = current;
  const renders = vi.fn();
  function Sidebar({ children }: { children: ReactNode }) {
    renders();
    return (
      <aside aria-label="Channel sidebar" className="shell-sidebar">
        {children}
      </aside>
    );
  }
  const sidebar = (pages: ReactNode) => <Sidebar>{pages}</Sidebar>;
  // Stable inputs, so only `selected` changes between the renders below.
  const pages: RegisteredPage[] = [
    {
      id: "channels",
      key: "buzz.channels/channels",
      pluginId: "buzz.channels",
      revision: "1",
      title: "Channels",
      component: () => null,
      primary: true,
    },
  ];
  const onSelect = () => {};
  const shell = (selected: string) => (
    <ToastProvider>
      <AppShell
        pages={pages}
        selected={selected}
        navigationAttempt=""
        onSelect={onSelect}
        tone="default"
        sidebar={sidebar}
        communities={current.communities}
        accountActions={current.accountActions}
      >
        content
      </AppShell>
    </ToastProvider>
  );
  const { rerender } = render(shell("buzz.channels/channels"));
  const content = screen.getByRole("complementary", {
    name: "Channel sidebar",
  });
  const navigation = document.getElementById("shell-navigation");
  const rendered = renders.mock.calls.length;
  const row = () => within(content).getByRole("button", { name: "Messages" });
  expect(row()).toHaveAttribute("aria-current", "page");

  for (const [label, hidden] of [
    ["Hide Channel sidebar", "true"],
    ["Show Channel sidebar", "false"],
    ["Hide Channel sidebar", "true"],
    ["Show Channel sidebar", "false"],
  ] as const) {
    await userEvent.click(screen.getByRole("button", { name: label }));
    expect(navigation).toHaveAttribute("aria-hidden", hidden);
  }
  expect(content).toBeInTheDocument();
  expect(renders).toHaveBeenCalledTimes(rendered);

  // A selection change still reaches the page rows the sidebar renders.
  rerender(shell("buzz.agents/agents"));
  expect(renders.mock.calls.length).toBeGreaterThan(rendered);
  expect(row()).not.toHaveAttribute("aria-current");
});
