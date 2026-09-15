import { IconButton } from "../../shared/design-system/ui/IconButton";
import { useSyncExternalStore } from "react";
import {
  IconArrowLeft as ArrowLeft,
  IconArrowRight as ArrowRight,
} from "@tabler/icons-react";
import type { Navigation } from "../../features/navigation/controller";
export function NavigationControls({ navigation }: { navigation: Navigation }) {
  const state = useSyncExternalStore(navigation.subscribe, navigation.snapshot);
  return (
    <nav
      className="mr-2 flex shrink-0 items-center gap-0.5"
      aria-label="Navigation history"
    >
      <IconButton
        type="button"
        variant="chrome"
        shape="round"
        aria-label="Go back"
        title="Go back"
        disabled={!state.canGoBack}
        onClick={navigation.back}
        icon={<ArrowLeft size={16} aria-hidden="true" />}
      />
      <IconButton
        type="button"
        variant="chrome"
        shape="round"
        aria-label="Go forward"
        title="Go forward"
        disabled={!state.canGoForward}
        onClick={navigation.forward}
        icon={<ArrowRight size={16} aria-hidden="true" />}
      />
    </nav>
  );
}
