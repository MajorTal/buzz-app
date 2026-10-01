import { invoke, isTauri } from "@tauri-apps/api/core";

/** An app a local agent reaches as MCP tools through the app's MCP hub. */
export type ConnectedApp = {
  name: string;
  url: string;
  added_by: "owner" | "agent";
};

/** Native-only: the hub runs beside the desktop app, never in a browser build. */
export interface AgentAppsHost {
  list(id: string): Promise<ConnectedApp[]>;
  connect(id: string, url: string, name?: string): Promise<ConnectedApp[]>;
  disconnect(id: string, name: string): Promise<ConnectedApp[]>;
}

export function nativeAgentAppsHost(): AgentAppsHost | null {
  if (!isTauri()) return null;
  return {
    list: (id) => invoke("agent_apps_list", { id }),
    connect: (id, url, name) =>
      invoke("agent_apps_connect", { id, url, name: name || null }),
    disconnect: (id, name) => invoke("agent_apps_disconnect", { id, name }),
  };
}
