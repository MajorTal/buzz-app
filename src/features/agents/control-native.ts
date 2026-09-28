import { invoke, isTauri } from "@tauri-apps/api/core";
import { createAgentControl, type AgentControlHost } from "./control";

// Mirror snapshot refresh's bounded busy wait without retrying a failed proof.
const HOST_BUSY = "Another native agent operation is in progress";
async function logInvoke<T>(
  command: string,
  args: Record<string, string>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await invoke<T>(command, args);
    } catch (error) {
      if (error !== HOST_BUSY || attempt === 20) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  }
}

export function nativeAgentControlHost(): AgentControlHost | null {
  if (!isTauri()) return null;
  return {
    models: {
      begin: () => invoke("agent_models_begin"),
      run: (ticket, request) => invoke("agent_models_run", { ticket, request }),
      cancel: (ticket) => invoke("agent_models_cancel", { ticket }),
    },
    prepareCreate: (requestId, destination, owner) =>
      invoke("agent_control_create_prepare", { requestId, destination, owner }),
    commitCreate: (requestId, edit, auth) =>
      invoke("agent_control_create_commit", { requestId, edit, auth }),
    publishProfile: (id) => invoke("agent_control_creation_profile", { id }),
    setStartOnAppLaunch: (id, enabled) =>
      invoke("agent_control_start_on_app_launch", { id, enabled }),
    snapshot: () => invoke("agent_control_snapshot"),
    readLog: async ({ id, pubkey, relayUrl, authorize }) => {
      const nonce = await logInvoke<string>("agent_control_log_challenge", {
        id,
        pubkey,
        relayUrl,
      });
      const signature = await authorize({ id, pubkey, relayUrl }, nonce);
      return logInvoke<string>("agent_control_read_log", {
        id,
        pubkey,
        relayUrl,
        nonce,
        signature,
      });
    },
    installGoose: () => invoke("goose_install"),
    save: (id, expectedRevision, edit) =>
      invoke("agent_control_save", { id, expectedRevision, edit }),
    delete: (id, expectedRevision) =>
      invoke("agent_control_delete", { id, expectedRevision }),
    action: (id, action, replayFloor) =>
      invoke("agent_control_action", {
        id,
        action,
        ...(replayFloor === undefined ? {} : { replayFloor }),
      }),
    previewImport: (source, destination) =>
      invoke("agent_control_import_preview", { source, destination }),
    commitImport: (token, ids) =>
      invoke("agent_control_import_commit", { token, ids }),
  };
}

/** Composition owns this, not the Agents page or selected community. */
export function createNativeAgentControl() {
  return createAgentControl(nativeAgentControlHost());
}
