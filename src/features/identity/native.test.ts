import { beforeEach, expect, it, vi } from "vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { createNativeIdentityBackend } from "./native";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
});
it("has no native backend in a browser", () => {
  vi.mocked(isTauri).mockReturnValue(false);
  expect(createNativeIdentityBackend()).toBeUndefined();
  expect(invoke).not.toHaveBeenCalled();
});
it("uses only documented commands and public request wrappers, without attach or reload calls", async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  const backend = createNativeIdentityBackend();
  const request = {
    expectedPubkey: "a".repeat(64),
    generation: "0",
    revocation: "00000000-0000-4000-8000-000000000001",
  };
  await backend?.status();
  await backend?.unlockSaved(request);
  await backend?.importLegacy({
    ...request,
    source: "buzzDesktopBlob",
    consent: true,
  });
  await backend?.signOut({ revocation: request.revocation });
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ["identity_status"],
    ["identity_unlock_saved", { request }],
    [
      "identity_import_legacy",
      { request: { ...request, source: "buzzDesktopBlob", consent: true } },
    ],
    ["identity_sign_out", { request: { revocation: request.revocation } }],
  ]);
});
