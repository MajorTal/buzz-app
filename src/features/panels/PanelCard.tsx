import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { X } from "lucide-react";
import type { PanelProps, RegisteredPanel } from "./service";
import { PanelView } from "./PanelView";
import styles from "./Panels.module.css";

// Ordinary shared UI: the caller still owns placement and selection.
export function PanelCard({
  panel,
  closeLabel,
  ...props
}: PanelProps & {
  panel: RegisteredPanel;
  closeLabel?: string;
}) {
  return (
    <aside
      className={styles.card}
      aria-label={panel.title}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          props.close();
        }
      }}
    >
      <PanelHeader
        variant="compact"
        title={panel.title}
        actions={
          <IconButton
            size="toolbar"
            aria-label={closeLabel ?? `Close ${panel.title} panel`}
            onClick={props.close}
            icon={<X size={18} aria-hidden="true" />}
          />
        }
      />
      <div className={styles.content}>
        <PanelView panel={panel} {...props} />
      </div>
    </aside>
  );
}
