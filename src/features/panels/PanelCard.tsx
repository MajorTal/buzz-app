import { Panel } from "../../shared/design-system/ui/Panel";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { XIcon } from "../../shared/design-system/icons/index";
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
      className={styles.cardLayout}
      aria-label={panel.title}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          props.close();
        }
      }}
    >
      <Panel as="div">
        <div className={styles.card}>
          <PanelHeader
            title={panel.title}
            actions={
              <IconButton
                size="toolbar"
                aria-label={closeLabel ?? `Close ${panel.title} panel`}
                onClick={props.close}
                icon={<XIcon size={18} aria-hidden="true" />}
              />
            }
          />
          <div className={styles.content}>
            <PanelView panel={panel} {...props} />
          </div>
        </div>
      </Panel>
    </aside>
  );
}
