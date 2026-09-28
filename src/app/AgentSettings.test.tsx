// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { ToastProvider } from "../shared/design-system/ui/Toast";
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
import { createAgentControl } from "../features/agents/control";
import { controlFixture } from "../features/agents/control-testing";
import { AgentSettings } from "./AgentSettings";
import {
  rememberAgentsPreference,
  setRememberAgentsPreference,
} from "../features/messages/mention-preferences";

const browserControl = createAgentControl(null);
const disposals: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const dispose of disposals.splice(0)) dispose();
  vi.restoreAllMocks();
  setRememberAgentsPreference(true);
  localStorage.clear();
});

it("defaults on, persists opt-out, and follows another window's preference", async () => {
  const user = userEvent.setup();
  render(<AgentSettings control={browserControl} />, {
    wrapper: ToastProvider,
  });
  const toggle = () =>
    screen.getByRole("switch", { name: "Remember mentioned agents" });
  expect(toggle()).toBeChecked();
  await user.click(toggle());
  expect(rememberAgentsPreference()).toBe(false);
  cleanup();
  render(<AgentSettings control={browserControl} />, {
    wrapper: ToastProvider,
  });
  expect(toggle()).not.toBeChecked();
  act(() => {
    localStorage.removeItem("buzz-remember-mentioned-agents.v1");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "buzz-remember-mentioned-agents.v1" }),
    );
  });
  expect(toggle()).toBeChecked();
});

it("keeps an unsaved opt-out effective and offers retry without changing the choice", async () => {
  const user = userEvent.setup();
  render(<AgentSettings control={browserControl} />, {
    wrapper: ToastProvider,
  });
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("storage unavailable");
    });
  await user.click(
    screen.getByRole("switch", { name: "Remember mentioned agents" }),
  );
  expect(rememberAgentsPreference()).toBe(false);
  expect(screen.getByRole("dialog")).toHaveTextContent("could not be saved");
  write.mockRestore();
  await user.click(screen.getByRole("button", { name: "Retry saving" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(localStorage.getItem("buzz-remember-mentioned-agents.v1")).toBe("off");
});

it("does not prefill when storage cannot be read", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("storage unavailable");
  });
  expect(rememberAgentsPreference()).toBe(false);
});

function setupHarnesses(piStatus: "ready" | "cli-needed" | "adapter-needed") {
  const fixture = controlFixture();
  fixture.data.harnessOptions = [
    {
      command: "buzz-agent",
      label: "Buzz Agent",
      available: true,
      status: "ready",
      providers: [],
    },
    {
      command: "goose",
      label: "Goose",
      available: false,
      status: "cli-needed",
      providers: [],
    },
    {
      command: "buzz-pi-acp",
      label: "Pi",
      available: piStatus === "ready",
      status: piStatus,
      providers: [],
    },
  ];
  const control = createAgentControl(fixture.host);
  disposals.push(() => control.dispose());
  render(<AgentSettings control={control} />, { wrapper: ToastProvider });
  return { fixture, control };
}

it.each(["cli-needed", "adapter-needed", "ready"] as const)(
  "shows the three Harnesses and Pi %s with commands only when needed",
  async (piStatus) => {
    const user = userEvent.setup();
    setupHarnesses(piStatus);
    const list = await screen.findByRole("list");
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Buzz AgentReady");
    expect(rows[1]).toHaveTextContent("GooseCLI needed");
    expect(rows[2]).toHaveTextContent(
      `Pi${piStatus === "ready" ? "Ready" : piStatus === "cli-needed" ? "CLI needed" : "Adapter needed"}`,
    );
    const copyPi = screen.queryByRole("button", { name: "Copy Pi command" });
    if (piStatus === "ready") {
      expect(copyPi).not.toBeInTheDocument();
      expect(screen.queryByText(/npm install -g/)).not.toBeInTheDocument();
    } else {
      expect(copyPi).toBeVisible();
      expect(
        screen.getByText("npm install -g @earendil-works/pi-coding-agent"),
      ).toBeVisible();
      expect(
        screen.getByText(
          /git\+https:\/\/github.com\/salman1993\/buzz-pi-acp.git#86b201e/,
        ),
      ).toBeVisible();
      const write = vi
        .spyOn(navigator.clipboard, "writeText")
        .mockResolvedValue();
      await user.click(
        screen.getByRole("button", { name: "Copy Adapter command" }),
      );
      expect(write).toHaveBeenCalledWith(
        "npm install -g --install-links=true 'git+https://github.com/salman1993/buzz-pi-acp.git#86b201e'",
      );
      expect(await screen.findByRole("status", { name: "" })).toHaveTextContent(
        "Adapter command copied.",
      );
    }
    await user.hover(screen.getByRole("button", { name: "About ACP" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Buzz talks to harnesses through the Agent Client Protocol (ACP). Goose supports it natively. Pi needs a small adapter, `buzz-pi-acp`. Your existing CLI setup and sign-in are left untouched.",
    );
  },
);

it("offers manual copying when clipboard access fails", async () => {
  const user = userEvent.setup();
  setupHarnesses("cli-needed");
  expect(
    await screen.findByRole("button", { name: "Copy Pi command" }),
  ).toBeVisible();
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
    new Error("denied"),
  );
  await user.click(screen.getByRole("button", { name: "Copy Pi command" }));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Select it to copy manually.",
  );
  expect(
    screen.getByText("npm install -g @earendil-works/pi-coding-agent"),
  ).toBeVisible();
});

it("Check again re-reads the native snapshot without restarting the app", async () => {
  const user = userEvent.setup();
  const { fixture } = setupHarnesses("adapter-needed");
  expect(await screen.findByText("Adapter needed")).toBeVisible();
  const before = fixture.calls.filter(
    (call) => call.action === "snapshot",
  ).length;
  const pi = fixture.data.harnessOptions?.[2];
  const goose = fixture.data.harnessOptions?.[1];
  if (!pi || !goose) throw new Error("Missing Harness fixture");
  pi.status = "ready";
  pi.available = true;
  goose.status = "ready";
  goose.available = true;
  await user.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() =>
    expect(
      within(screen.getByRole("list")).getAllByRole("listitem")[2],
    ).toHaveTextContent("PiReady"),
  );
  expect(screen.queryByRole("button", { name: "Copy Pi command" })).toBeNull();
  expect(
    within(screen.getByRole("list")).getAllByRole("listitem")[1],
  ).toHaveTextContent("GooseReady");
  expect(
    fixture.calls.filter((call) => call.action === "snapshot"),
  ).toHaveLength(before + 1);
});

it("keeps the last statuses and offers Check again after a failed read", async () => {
  const user = userEvent.setup();
  const { fixture } = setupHarnesses("ready");
  expect(await screen.findByText("CLI needed")).toBeVisible();
  const original = fixture.host.snapshot.bind(fixture.host);
  fixture.host.snapshot = vi
    .fn()
    .mockRejectedValueOnce("unavailable")
    .mockImplementation(original);
  await user.click(screen.getByRole("button", { name: "Check again" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("last check");
  expect(
    within(screen.getByRole("list")).getAllByRole("listitem")[0],
  ).toHaveTextContent("Buzz AgentReady");
  await user.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});
