import type { ReactNode, RefObject } from "react";
import { Hash } from "lucide-react";
import type { ChannelSummary } from "../relay/contracts";
import styles from "./Sessions.module.css";

export function NewSessionView({
  children,
  parentName,
}: {
  children: ReactNode;
  parentName?: string | undefined;
}) {
  return (
    <section
      className={styles.work}
      aria-label={parentName ? `New session in ${parentName}` : "New session"}
    >
      <SessionHeading channel={{ name: "New session" }} />
      <div className={styles.start}>
        <div className={styles.startContent}>{children}</div>
      </div>
    </section>
  );
}

/** Keep session messages and their composer in the same column as a new draft. */
export function SessionColumn({
  children,
  enabled = true,
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  return enabled ? <div className={styles.column}>{children}</div> : children;
}

export function SessionHeading({
  channel,
  headingRef,
  children,
}: {
  channel: Pick<ChannelSummary, "name" | "archived">;
  parentName?: string | undefined;
  headingRef?: RefObject<HTMLHeadingElement | null> | undefined;
  children?: ReactNode;
}) {
  return (
    <header className={styles.workHeader}>
      <div className={styles.workTitle}>
        <Hash size={20} aria-hidden="true" />
        <h2 ref={headingRef} tabIndex={-1}>
          {channel.name}
        </h2>
      </div>
      {channel.archived ? <span>Archived</span> : children}
    </header>
  );
}
