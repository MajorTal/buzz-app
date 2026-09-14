import { memo } from "react";
import type { Profile } from "../relay/contracts";
import { membershipDescription, type TimelineRow } from "./membership-rows";
import styles from "./Messages.module.css";

/** Quiet, non-conversational activity. Avatars are decorative; prose owns the label. */
export const MembershipRow = memo(function MembershipRow({
  row,
  profiles,
  viewer,
  media,
  day,
}: {
  row: TimelineRow;
  profiles: ReadonlyMap<string, Profile>;
  viewer?: string | undefined;
  media(url: string): string | undefined;
  day: boolean;
}) {
  const { targets, text, title } = membershipDescription(
    row.membershipRows ?? [row],
    profiles,
    viewer,
  );
  return (
    <div data-message-id={row.id} data-membership-row="">
      {day && (
        <div className={styles.day}>
          <span>
            {new Date(row.createdAt * 1000).toLocaleDateString(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
          </span>
        </div>
      )}
      <div className={styles.membership}>
        <span className={styles.membershipAvatars} aria-hidden="true">
          {targets.slice(0, 3).map((id) => {
            const profile = profiles.get(id);
            const name = profile?.name ?? id.slice(0, 10);
            const picture = profile?.picture
              ? media(profile.picture)
              : undefined;
            return (
              <span className={styles.membershipAvatar} key={id}>
                {name.slice(0, 2).toUpperCase()}
                {picture && (
                  <img
                    key={picture}
                    src={picture}
                    alt=""
                    loading="lazy"
                    onError={(event) => {
                      event.currentTarget.hidden = true;
                    }}
                  />
                )}
              </span>
            );
          })}
          {targets.length > 3 && (
            <span className={styles.membershipAvatar}>
              +{targets.length - 3}
            </span>
          )}
        </span>
        <p title={title}>{text}</p>
      </div>
    </div>
  );
});
