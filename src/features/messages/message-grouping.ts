import type { ChannelMessage } from "../relay/contracts";

type Groupable = Pick<ChannelMessage, "authorId" | "createdAt" | "membership">;

export function startsMessageDay(
  previous: Groupable | undefined,
  row: Groupable,
) {
  return (
    !previous ||
    new Date(previous.createdAt * 1000).toDateString() !==
      new Date(row.createdAt * 1000).toDateString()
  );
}

/** Pulse groups adjacent messages from one author for up to ten minutes.
 * Call with ordered data, never just the rows mounted by the virtualizer. */
export function continuesMessage(
  previous: Groupable | undefined,
  row: Groupable | undefined,
) {
  if (
    !previous ||
    !row ||
    previous.membership ||
    row.membership ||
    previous.authorId !== row.authorId
  )
    return false;
  const gap = row.createdAt - previous.createdAt;
  return gap >= 0 && gap <= 600 && !startsMessageDay(previous, row);
}
