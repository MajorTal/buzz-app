import { useState } from "react";
import { PanelHeaderActionsContext } from "./PanelHeaderActions";
import { IconX } from "@tabler/icons-react";
import { IconButton } from "../../shared/design-system/ui/IconButton";
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
  const [actions, setActions] = useState<HTMLDivElement | null>(null);
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
      <header className={styles.heading}>
        <strong>{panel.title}</strong>
        <div className={styles.actions}>
          <div ref={setActions} className={styles.actions} />
          <IconButton
            icon={<IconX size={18} />}
            aria-label={closeLabel ?? `Close ${panel.title} panel`}
            onClick={props.close}
          />
        </div>
      </header>
      <div className={styles.content}>
        <PanelHeaderActionsContext value={actions}>
          <PanelView panel={panel} {...props} />
        </PanelHeaderActionsContext>
      </div>
    </aside>
  );
}
