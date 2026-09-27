import { useEffect, useSyncExternalStore } from "react";
import type { AgentControl } from "./control";

/** View lifetime owns observation only; native execution remains app-owned. */
export function useAgentControl(control: AgentControl) {
  return useSyncExternalStore(
    control.subscribe,
    control.snapshot,
    control.snapshot,
  );
}

/** One mounted surface owns periodic refresh; child controls may request reads. */
export function useAgentControlRefresh(control: AgentControl | undefined) {
  useEffect(() => {
    if (!control) return;
    void control.refresh();
    const timer = setInterval(() => {
      const status = control.snapshot().status;
      if (
        document.visibilityState !== "hidden" &&
        (status === "ready" || status === "error")
      )
        void control.refresh();
    }, 5000);
    return () => clearInterval(timer);
  }, [control]);
}
