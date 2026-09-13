import { invoke, isTauri } from "@tauri-apps/api/core";
import type { IdentityBackend } from "./contracts";

/** No attach, reload handler or credential IPC. One controller per host composition. */
export function createNativeIdentityBackend(): IdentityBackend | undefined {
  if (!isTauri()) return undefined;
  return {
    status: () => invoke("identity_status"),
    importLegacy: (request) => invoke("identity_import_legacy", { request }),
    unlockSaved: (request) => invoke("identity_unlock_saved", { request }),
    signOut: (request) => invoke("identity_sign_out", { request }),
  };
}
