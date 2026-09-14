import type {
  ChannelMessage,
  MembershipChange,
  Profile,
} from "../relay/contracts";

export type TimelineRow = ChannelMessage & {
  membershipRows?: readonly ChannelMessage[];
};
const sameDay = (a: ChannelMessage, b: ChannelMessage) =>
  new Date(a.createdAt * 1000).toDateString() ===
  new Date(b.createdAt * 1000).toDateString();
function compatible(older: MembershipChange, newest: MembershipChange) {
  if (newest.type === "member_joined") return older.type === "member_joined";
  if (newest.type === "member_removed")
    return older.type === newest.type && older.actor === newest.actor;
  return older.type === "member_left";
}

/** Newest-anchored groups keep loaded keys stable when history is prepended.
 * Messages, local days and adjacent gaps over one hour always break a group. */
export function membershipRows(
  rows: readonly ChannelMessage[],
): readonly TimelineRow[] {
  const result: TimelineRow[] = [];
  for (let end = rows.length - 1; end >= 0; ) {
    const newest = rows[end];
    if (!newest) break;
    let start = end;
    const change = newest.membership;
    // Like the existing desktop, repeated self-joins followed by that person's
    // departure describe one lifecycle, not an arrival that silently hides a leave.
    const previous = rows[end - 1]?.membership;
    const lifecycle =
      change?.type === "member_left" &&
      previous?.type === "member_joined" &&
      previous.actor === previous.target &&
      previous.target === change.target;
    while (change && start > 0) {
      const candidate = rows[start - 1],
        next = rows[start];
      const older = candidate?.membership;
      if (
        !candidate ||
        !next ||
        !older ||
        !sameDay(candidate, next) ||
        next.createdAt - candidate.createdAt > 3600 ||
        !(lifecycle
          ? older.type === "member_joined" &&
            older.actor === older.target &&
            older.target === change.target
          : compatible(older, change))
      )
        break;
      start--;
    }
    result.push(
      start === end
        ? newest
        : {
            ...newest,
            createdAt: rows[start]?.createdAt ?? newest.createdAt,
            membershipRows: rows.slice(start, end + 1),
          },
    );
    end = start - 1;
  }
  return result.reverse();
}

export function membershipDescription(
  rows: readonly ChannelMessage[],
  profiles: ReadonlyMap<string, Profile>,
  viewer?: string,
) {
  const changes = rows.flatMap((row) =>
    row.membership ? [row.membership] : [],
  );
  const first = changes[0];
  if (!first) return { targets: [], text: "", title: "" };
  const targets = [...new Set(changes.map((change) => change.target))];
  const name = (id: string, subject = false) =>
    id === viewer
      ? subject
        ? "You"
        : "you"
      : (profiles.get(id)?.name ?? id.slice(0, 10));
  const joinNames = (ids: readonly string[]) =>
    new Intl.ListFormat(undefined, { type: "conjunction" }).format(
      ids.map((id) => name(id)),
    );
  const lead = name(first.target, true);
  const others = targets.slice(1, 3);
  const overflow =
    targets.length > 3
      ? `${targets.length - 3} ${targets.length === 4 ? "other" : "others"}`
      : undefined;
  const rest = new Intl.ListFormat(undefined, { type: "conjunction" }).format([
    ...others.map((id) => name(id)),
    ...(overflow ? [overflow] : []),
  ]);
  const subjects = rest ? `${lead}, along with ${rest},` : lead;
  let text: string;
  if (
    first.type === "member_joined" &&
    changes.at(-1)?.type === "member_left"
  ) {
    text = `${lead} joined and left the channel`;
  } else if (first.type === "member_left") {
    text = `${subjects} left the channel`;
  } else if (first.type === "member_removed") {
    text = `${lead} ${first.target === viewer ? "were" : "was"} removed by ${name(first.actor)}${rest ? `, along with ${rest}` : ""}`;
  } else {
    const allSelf = changes.every(({ actor, target }) => actor === target);
    const allAdded = changes.every(({ actor, target }) => actor !== target);
    const sameAdder =
      allAdded && changes.every(({ actor }) => actor === first.actor);
    const action = allSelf
      ? "joined"
      : sameAdder
        ? `${first.target === viewer ? "were added" : "added"} by ${name(first.actor)}`
        : allAdded
          ? `${first.target === viewer ? "were" : "was"} added`
          : "arrived";
    text = `${lead} ${action}${rest ? `${sameAdder ? "," : ""} along with ${rest}` : ""}`;
  }
  return { targets, text, title: joinNames(targets) };
}
