import { useMemo, useSyncExternalStore } from "react";
import type { WorkflowView } from "../../features/workflows/types";

/** Allocate host interest on subscription, not render. StrictMode may discard a
 * render or unsubscribe/resubscribe without constructing a new component. */
export function useWorkflowView<T>(create: () => WorkflowView<T>) {
  const store = useMemo(() => {
    let view: WorkflowView<T> | undefined;
    return {
      snapshot: () => view?.snapshot(),
      refresh: () => view?.refresh() ?? Promise.resolve(),
      subscribe(listener: () => void) {
        const owned = create();
        view = owned;
        const stop = owned.subscribe(listener);
        void owned.refresh();
        return () => {
          stop();
          owned.dispose();
          if (view === owned) view = undefined;
        };
      },
    };
  }, [create]);
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
    store.snapshot,
  );
  return { snapshot, refresh: store.refresh };
}
