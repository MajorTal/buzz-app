// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { createIdentity, nativeIdentityEnabled } from "./service";
import { IdentitySetup } from "./IdentitySetup";
import { PrivateKey } from "./PrivateKey";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));
const viewer = "ab".repeat(32);
const key = "nsec-fixture-only";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("offers alternatives, passes exactly the imported key, and keeps secrets out of snapshots", async () => {
  const imported = deferred<string>();
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_import") return imported.promise;
    throw new Error("Unexpected command");
  });
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <IdentitySetup identity={identity}>
      <p>Signed in</p>
    </IdentitySetup>,
  );
  await user.click(
    await screen.findByRole("button", { name: "Use an existing key" }),
  );
  await user.type(screen.getByLabelText("Private key (nsec)"), key);
  await user.click(screen.getByRole("button", { name: "Use this key" }));
  expect(invoke).toHaveBeenCalledWith("identity_import", { nsec: key });
  expect(screen.getByLabelText("Private key (nsec)")).toHaveValue("");
  expect(screen.getByRole("button", { name: "Use this key" })).toBeDisabled();
  await act(async () => {
    imported.resolve(viewer);
  });
  expect(await screen.findByText("Signed in")).toBeVisible();
  expect(identity.snapshot()).toEqual({ status: "ready", viewer });
  expect(await identity.ready).toBe(viewer);
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "identity_import",
  ]);
  identity.dispose();
});

it("restore denial does not become first run or generate a replacement", async () => {
  vi.mocked(invoke)
    .mockRejectedValueOnce("Keychain access was denied")
    .mockResolvedValueOnce(viewer);
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <IdentitySetup identity={identity}>
      <p>Restored</p>
    </IdentitySetup>,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Keychain access was denied",
  );
  expect(
    screen.queryByRole("button", { name: "Create a new identity" }),
  ).toBeNull();
  await user.click(
    screen.getByRole("button", { name: "Retry secure storage access" }),
  );
  expect(await screen.findByText("Restored")).toBeVisible();
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "identity_restore",
  ]);
  identity.dispose();
});

it("import failure keeps setup open without falling through to creation", async () => {
  vi.mocked(invoke)
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce("Invalid nsec");
  const identity = createIdentity();
  await waitFor(() => expect(identity.snapshot().status).toBe("missing"));
  await identity.importKey(key);
  expect(identity.snapshot()).toEqual({
    status: "missing",
    busy: false,
    error: "Invalid nsec",
  });
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "identity_import",
  ]);
  identity.dispose();
});

it("coalesces pending creation and only creates on explicit request", async () => {
  const created = deferred<string>();
  vi.mocked(invoke)
    .mockResolvedValueOnce(null)
    .mockImplementationOnce(() => created.promise);
  const identity = createIdentity();
  await waitFor(() => expect(identity.snapshot().status).toBe("missing"));
  expect(invoke).toHaveBeenCalledTimes(1);
  const first = identity.create();
  await identity.create();
  expect(invoke).toHaveBeenCalledTimes(2);
  created.resolve(viewer);
  await first;
  expect(identity.snapshot()).toEqual({ status: "ready", viewer });
  identity.dispose();
});

it("fetches a private key only on interaction, masks by absence, and cancels a late reveal", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(viewer);
  const identity = createIdentity();
  await identity.ready;
  const exported = deferred<string>();
  vi.mocked(invoke).mockImplementationOnce(() => exported.promise);
  const user = userEvent.setup();
  const view = render(<PrivateKey identity={identity} />);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText("Private key (nsec)")).toHaveValue(
    "••••••••••••••••",
  );
  await user.click(screen.getByRole("button", { name: "Reveal private key" }));
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await act(async () => {
    exported.resolve(key);
  });
  expect(screen.getByLabelText("Private key (nsec)")).toHaveValue(
    "••••••••••••••••",
  );
  vi.mocked(invoke).mockResolvedValueOnce(key);
  await user.click(screen.getByRole("button", { name: "Reveal private key" }));
  expect(screen.getByLabelText("Private key (nsec)")).toHaveValue(key);
  view.unmount();
  render(<PrivateKey identity={identity} />);
  expect(screen.getByLabelText("Private key (nsec)")).toHaveValue(
    "••••••••••••••••",
  );
  identity.dispose();
});

it("copies without revealing and cancels a pending export on blur before clipboard access", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(viewer);
  const identity = createIdentity();
  await identity.ready;
  const user = userEvent.setup();
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  vi.mocked(invoke).mockResolvedValueOnce(key);
  render(<PrivateKey identity={identity} />);
  await user.click(screen.getByRole("button", { name: "Copy private key" }));
  expect(write).toHaveBeenCalledWith(key);
  expect(screen.getByLabelText("Private key (nsec)")).toHaveValue(
    "••••••••••••••••",
  );
  const exported = deferred<string>();
  vi.mocked(invoke).mockImplementationOnce(() => exported.promise);
  await user.click(screen.getByRole("button", { name: "Copy private key" }));
  fireEvent(window, new Event("blur"));
  await act(async () => {
    exported.resolve(key);
  });
  expect(write).toHaveBeenCalledTimes(1);
  identity.dispose();
});

it("enables packaged identity on desktop platforms but never in the live broker or browser", () => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.stubEnv("VITE_BUZZ_LIVE", "");
  for (const platform of ["MacIntel", "Win32", "Linux x86_64"]) {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    expect(nativeIdentityEnabled()).toBe(true);
  }
  vi.stubEnv("VITE_BUZZ_LIVE", "1");
  expect(nativeIdentityEnabled()).toBe(false);
  vi.stubEnv("VITE_BUZZ_LIVE", "");
  vi.mocked(isTauri).mockReturnValue(false);
  expect(nativeIdentityEnabled()).toBe(false);
  vi.mocked(isTauri).mockReturnValue(true);
  vi.spyOn(navigator, "platform", "get").mockReturnValue("iPhone");
  expect(nativeIdentityEnabled()).toBe(false);
});
