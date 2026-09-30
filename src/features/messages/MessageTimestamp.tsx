import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import styles from "./Messages.module.css";

/** One date source for the byline and the compact continuation clock. */
export function MessageTimestamp({
  createdAt,
  compact = false,
}: {
  createdAt: number;
  compact?: boolean;
}) {
  const date = new Date(createdAt * 1000);
  const clock = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const label = compact
    ? clock
        .formatToParts(date)
        .filter((part) => part.type !== "dayPeriod")
        .map((part) => part.value)
        .join("")
        .trim()
    : clock.format(date);
  const fullDate = date.toLocaleString(undefined, {
    dateStyle: "full",
    timeStyle: "long",
  });
  return (
    // The action bar can sit over the byline; keep the date hint non-interactive
    // so it cannot intercept nearby controls when their paint layers overlap.
    <Tooltip content={fullDate} delay={500} disableHoverablePopup>
      <time
        dateTime={date.toISOString()}
        style={{ cursor: "default" }}
        className={compact ? styles.continuationTime : undefined}
      >
        <span aria-hidden="true">{label}</span>
        <span className="sr-only">{fullDate}</span>
      </time>
    </Tooltip>
  );
}
