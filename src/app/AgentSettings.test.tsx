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
import {
  createAgentControl,
  type AgentControlHost,
  type GooseInstallReport,
} from "../features/agents/control";
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

function setupHarnesses(
  piStatus: "ready" | "cli-needed" | "adapter-needed",
  goose: {
    status?: "ready" | "cli-needed";
    installSupported?: boolean;
    installGoose?: NonNullable<AgentControlHost["installGoose"]>;
  } = {},
) {
  const fixture = controlFixture();
  if (goose.installGoose) fixture.host.installGoose = goose.installGoose;
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
      available: goose.status === "ready",
      status: goose.status ?? "cli-needed",
      ...(goose.installSupported !== undefined
        ? { installSupported: goose.installSupported }
        : {}),
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
  const installGoose = vi.fn();
  const { fixture } = setupHarnesses("ready", {
    installSupported: true,
    installGoose,
  });
  expect(await screen.findByText("CLI needed")).toBeVisible();
  const original = fixture.host.snapshot.bind(fixture.host);
  fixture.host.snapshot = vi
    .fn()
    .mockRejectedValueOnce("unavailable")
    .mockImplementation(original);
  await user.click(screen.getByRole("button", { name: "Check again" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("last check");
  expect(screen.getByRole("button", { name: "Install" })).toBeDisabled();
  expect(installGoose).not.toHaveBeenCalled();
  expect(
    within(screen.getByRole("list")).getAllByRole("listitem")[0],
  ).toHaveTextContent("Buzz AgentReady");
  await user.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.getByRole("button", { name: "Install" })).toBeEnabled();
});

it.each([
  ["cli-needed", true, true],
  ["cli-needed", false, false], // Native Windows host keeps guidance but not the bash installer.
  ["ready", true, false],
] as const)(
  "shows Goose Install only for missing CLI on a supported OS (%s, %s)",
  async (status, installSupported, visible) => {
    setupHarnesses("ready", {
      status,
      installSupported,
      installGoose: vi.fn(),
    });
    const row = within(await screen.findByRole("list")).getAllByRole(
      "listitem",
    )[1];
    if (!row) throw new Error("Missing Goose row");
    expect(
      within(row).queryByRole("button", { name: "Install" }) !== null,
    ).toBe(visible);
    expect(row).toHaveTextContent(
      status === "ready" ? "GooseReady" : "GooseCLI needed",
    );
  },
);

it("installs once, then re-detects Goose as Ready after the install settles", async () => {
  const user = userEvent.setup();
  let finish!: (report: GooseInstallReport) => void;
  const pending = new Promise<GooseInstallReport>((resolve) => {
    finish = resolve;
  });
  const installGoose = vi.fn(() => pending);
  const { fixture, control } = setupHarnesses("ready", {
    installSupported: true,
    installGoose,
  });
  const button = await screen.findByRole("button", { name: "Install" });
  await user.click(button);
  expect(screen.getByRole("status")).toHaveTextContent("Installing Goose");
  expect(button).toBeDisabled();
  expect(installGoose).toHaveBeenCalledTimes(1);
  expect(
    fixture.calls.filter((call) => call.action === "snapshot"),
  ).toHaveLength(1);
  cleanup();
  render(<AgentSettings control={control} />, { wrapper: ToastProvider });
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Installing Goose",
  );
  await waitFor(() =>
    expect(
      fixture.calls.filter((call) => call.action === "snapshot"),
    ).toHaveLength(2),
  );
  const goose = fixture.data.harnessOptions?.[1];
  if (!goose) throw new Error("Missing Goose fixture");
  goose.available = true;
  goose.status = "ready";
  finish({
    ready: true,
    restarted: 2,
    restartFailures: 0,
    logPath: "/fixture/goose-install.log",
    output: "done",
    error: null,
  });
  expect(
    await screen.findByText("Goose installed. Restarted 2 waiting agents."),
  ).toBeVisible();
  expect(
    within(screen.getByRole("list")).getAllByRole("listitem")[1],
  ).toHaveTextContent("GooseReady");
  expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  expect(
    fixture.calls.filter((call) => call.action === "snapshot"),
  ).toHaveLength(3);
  cleanup();
  render(<AgentSettings control={control} />, { wrapper: ToastProvider });
  expect(
    await screen.findByText("Goose installed. Restarted 2 waiting agents."),
  ).toBeVisible();
});

it("keeps Install available and shows the recorded output on failure", async () => {
  const user = userEvent.setup();
  let fail!: (report: GooseInstallReport) => void;
  const pending = new Promise<GooseInstallReport>((resolve) => {
    fail = resolve;
  });
  const { control } = setupHarnesses("ready", {
    installSupported: true,
    installGoose: vi.fn(() => pending),
  });
  await user.click(await screen.findByRole("button", { name: "Install" }));
  cleanup();
  render(<AgentSettings control={control} />, { wrapper: ToastProvider });
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Installing Goose",
  );
  fail({
    ready: false,
    restarted: 0,
    restartFailures: 0,
    logPath: "/fixture/goose-install.log",
    output: "curl failed to fetch the installer",
    error: "Goose installer failed. See the install log.",
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Goose installer failed",
  );
  await user.click(screen.getByText("Goose install log"));
  expect(screen.getByText("curl failed to fetch the installer")).toBeVisible();
  expect(screen.getByText("/fixture/goose-install.log")).toBeVisible();
  expect(screen.getByRole("button", { name: "Install" })).toBeEnabled();
  cleanup();
  render(<AgentSettings control={control} />, { wrapper: ToastProvider });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Goose installer failed",
  );
  await user.click(screen.getByText("Goose install log"));
  expect(screen.getByText("curl failed to fetch the installer")).toBeVisible();
});
