import { Tooltip } from "../../shared/design-system/ui/Tooltip";
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
      <Tooltip content="Go back">
        <IconButton
          type="button"
          variant="chrome"
          shape="round"
          aria-label="Go back"
          disabled={!state.canGoBack}
          onClick={navigation.back}
          icon={<ArrowLeft size={16} aria-hidden="true" />}
        />
      </Tooltip>
      <Tooltip content="Go forward">
        <IconButton
          type="button"
          variant="chrome"
          shape="round"
          aria-label="Go forward"
          disabled={!state.canGoForward}
          onClick={navigation.forward}
          icon={<ArrowRight size={16} aria-hidden="true" />}
        />
      </Tooltip>
    </nav>
  );
}
