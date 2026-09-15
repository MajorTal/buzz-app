import type { ReactNode } from "react";
import { IconPlus } from "@tabler/icons-react";
import styles from "./SessionsWorkspace.module.css";

/** Presentation only. The caller supplies authorized, saved sessions. */
export type SessionListItem = Readonly<{
  id: string;
  title: string;
  parentName?: string;
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
    <section className={styles.workspace} aria-label="Sessions">
      <aside className={styles.sidebar} aria-label="Session history">
        <button className={styles.newSession} type="button" onClick={onNew}>
          <IconPlus size={18} aria-hidden="true" />
          New session
        </button>
        <h2 className={styles.historyHeading}>Previous sessions</h2>
        <nav className={styles.history} aria-label="Previous sessions">
          {sessions.map((session) => (
            <button
              type="button"
              key={session.id}
              aria-current={session.id === selected ? "page" : undefined}
              onClick={() => onSelect(session.id)}
            >
              <span>{session.title}</span>
              {session.parentName && <small>{session.parentName}</small>}
            </button>
          ))}
          {listStatus ??
            (!sessions.length && (
              <p className={styles.listMessage}>
                Your conversations will appear here after your first message.
              </p>
            ))}
        </nav>
      </aside>
      <div className={styles.content}>{children}</div>
    </section>
  );
}
