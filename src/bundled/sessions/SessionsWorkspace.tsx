import { Button } from "../../shared/design-system/ui/Button";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { Panel } from "../../shared/design-system/ui/Panel";
import { PlusIcon } from "../../shared/design-system/icons/index";
import { channelIcon } from "../../features/channels/channel-icon";
import type { ReactNode } from "react";
import styles from "./SessionsWorkspace.module.css";

/** Presentation only. The caller supplies authorized, saved sessions. */
export type SessionListItem = Readonly<{
  id: string;
  title: string;
  parentName?: string;
  parentPrivate?: true;
  content?: ReactNode;
}>;

export function SessionsWorkspace({
  sessions,
  selected,
  onSelect,
  onNew,
  listStatus,
  children,
}: {
  sessions: readonly SessionListItem[];
  selected?: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  listStatus?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={styles.container} aria-label="Sessions">
      <div className={styles.workspace}>
        <Panel as="aside" aria-label="Session history">
          <div className={styles.sidebar}>
            <Button variant="prominent" type="button" onClick={onNew}>
              <PlusIcon size={18} aria-hidden="true" />
              New session
            </Button>
            <h2 className={styles.historyHeading}>Previous sessions</h2>
            <nav className={styles.history} aria-label="Previous sessions">
              {sessions.map((session) => {
                const ParentChannelIcon = channelIcon({
                  private: session.parentPrivate,
                });
                return (
                  <NavigationItem
                    type="button"
                    key={session.id}
                    aria-current={session.id === selected ? "page" : undefined}
                    selected={session.id === selected}
                    onClick={() => onSelect(session.id)}
                    label={
                      <span className={styles.historyLabel}>
                        {session.parentName && (
                          <small className={styles.parentChannel}>
                            <ParentChannelIcon size={12} aria-hidden="true" />
                            <span>{session.parentName}</span>
                          </small>
                        )}
                        <span className={styles.sessionRow}>
                          {session.content ?? <span>{session.title}</span>}
                        </span>
                      </span>
                    }
                  />
                );
              })}
              {listStatus ??
                (!sessions.length && (
                  <p className={styles.listMessage}>
                    Your conversations will appear here after your first
                    message.
                  </p>
                ))}
            </nav>
          </div>
        </Panel>
        <Panel as="div">
          <div className={styles.content}>{children}</div>
        </Panel>
      </div>
    </section>
  );
}
