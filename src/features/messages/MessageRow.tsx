import { memo, useCallback, useSyncExternalStore } from "react";
import type { UnreadCapability } from "../relay/unread";
import { profileTarget } from "../profiles/target";
import { InlineText } from "../conversation/InlineText";
import type { ConversationExtensions } from "../conversation/contracts";
import type { ChannelMessage, Profile } from "../relay/contracts";
import { AttachmentImage } from "./AttachmentImage";
import { DeliveryNotice } from "./DeliveryNotice";
import { MessageMarkdown } from "./MessageMarkdown";
import { safeMessageUrl } from "../relay/message-content";
import styles from "./Messages.module.css";
import { usesLargeEmojiPresentation } from "./emoji-size";

export type MessageRowProps = {
  row: ChannelMessage;
  unread?: UnreadCapability | undefined;
  extensions?: ConversationExtensions | undefined;
  profile: Profile | undefined;
  participantProfiles?: ReadonlyMap<string, Profile> | undefined;
  agentPubkeys?: ReadonlySet<string> | undefined;
  canOpenLink?: ((target: string) => boolean) | undefined;
  media(url: string): string | undefined;
  onOpenLink(url: string): boolean;
  day: boolean;
  retry: ((id: string) => void) | undefined;
  onOpenThread?: ((messageId: string) => void) | undefined;
};

export const MessageRow = memo(function MessageRow({
  row,
  unread,
  extensions,
  profile,
  media,
  onOpenLink,
  canOpenLink,
  day,
  retry,
  onOpenThread,
  participantProfiles,
  agentPubkeys,
}: MessageRowProps) {
  const threadUnread = useThreadUnread(
    row.replyCount > 0 && onOpenThread ? unread : undefined,
    row.channelId,
    row.threadRootId ?? row.id,
  );
  const unreadLabel =
    threadUnread?.manual === "local-only"
      ? "Thread marked unread on this device only"
      : threadUnread?.manual === "remote"
        ? "Thread marked unread"
        : (threadUnread?.observedCount ?? 0) > 0
          ? `Observed unread replies${threadUnread?.freshness === "stale" ? "; may be out of date" : ""}. Not an exact total.`
          : undefined;
  const name = profile?.name ?? row.authorId.slice(0, 10);
  const picture = profile?.picture ? media(profile.picture) : undefined;
  const target = profileTarget(row.authorId);
  const clickable = target && canOpenLink?.(target);
  const AvatarTag = clickable ? "button" : "div";
  const emojiOnly = usesLargeEmojiPresentation(row.content, row.emoji);
  return (
    <div data-message-id={row.id}>
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
      <div className={styles.message}>
        <AvatarTag
          className={styles.avatarButton}
          {...(clickable
            ? {
                type: "button" as const,
                "aria-label": `View ${name} profile`,
                onClick: (event: import("react").MouseEvent<HTMLElement>) => {
                  event.currentTarget.focus();
                  onOpenLink(target);
                },
              }
            : {})}
        >
          <span
            className={styles.avatar}
            data-avatar-shape={
              row.agentEnvelope || agentPubkeys?.has(row.authorId)
                ? "squircle"
                : "circle"
            }
          >
            {picture ? (
              <img src={picture} alt="" loading="lazy" />
            ) : (
              name.slice(0, 2).toUpperCase()
            )}
          </span>
        </AvatarTag>
        <div className={styles.messageBody}>
          <div className={styles.byline}>
            <strong>{name}</strong>
            <time dateTime={new Date(row.createdAt * 1000).toISOString()}>
              {new Date(row.createdAt * 1000).toLocaleTimeString(undefined, {
                hour: "numeric",
                minute: "2-digit",
              })}
            </time>
          </div>
          <MessageMarkdown
            row={row}
            extensions={extensions}
            media={media}
            onOpenLink={onOpenLink}
            canOpenLink={canOpenLink}
            participantProfiles={participantProfiles}
            largeEmoji={emojiOnly}
          />
          <DeliveryNotice row={row} retry={retry} />
          {row.attachments.map((attachment) => {
            const url = safeMessageUrl(attachment.url);
            if (!url) return null;
            const source = media(url);
            return attachment.video || !source ? (
              <a
                className={styles.attachment}
                key={url}
                href={url}
                target="_blank"
                rel="noreferrer"
              >
                {attachment.video ? "Video attachment" : "Image attachment"} ↗
              </a>
            ) : (
              <AttachmentImage
                key={url}
                attachment={attachment}
                url={url}
                source={source}
                onOpenLink={onOpenLink}
              />
            );
          })}
          {row.reactions.length > 0 && (
            <div className={styles.reactions}>
              {row.reactions.map((reaction) => (
                <span key={JSON.stringify(reaction)}>
                  {extensions ? (
                    <InlineText
                      registry={extensions.inline}
                      content={{
                        text: reaction.content,
                        message: row,
                        reaction,
                      }}
                      media={media}
                    />
                  ) : (
                    reaction.content
                  )}
                </span>
              ))}
            </div>
          )}
          {row.replyCount > 0 && onOpenThread && (
            <button
              type="button"
              className={styles.replies}
              aria-label={`View thread: ${row.replyCount} ${row.replyCount === 1 ? "reply" : "replies"}${unreadLabel ? `. ${unreadLabel}` : ""}`}
              onClick={(event) => {
                event.currentTarget.focus();
                onOpenThread(row.id);
              }}
            >
              {row.participants.length > 0 && (
                <span className={styles.threadAvatars} aria-hidden="true">
                  {row.participants.slice(0, 3).map((id) => {
                    const participant = participantProfiles?.get(id);
                    const name = participant?.name ?? id.slice(0, 10);
                    const picture = participant?.picture
                      ? media(participant.picture)
                      : undefined;
                    return (
                      <span
                        key={id}
                        className={styles.threadAvatar}
                        data-avatar-shape={
                          agentPubkeys?.has(id) ? "squircle" : "circle"
                        }
                        title={name}
                      >
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
                  {row.participants.length > 3 && (
                    <span
                      className={styles.threadAvatar}
                      data-avatar-shape="circle"
                    >
                      +{row.participants.length - 3}
                    </span>
                  )}
                </span>
              )}
              <span>
                {row.replyCount} {row.replyCount === 1 ? "reply" : "replies"}
              </span>
              {unreadLabel && (
                <span
                  className={styles.threadUnread}
                  aria-hidden="true"
                  title={unreadLabel}
                />
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
// Subscribe only for mounted thread buttons. Evidence and reading remain session-owned;
// rendering a row must not initiate per-thread reads or acknowledge unseen replies.
function useThreadUnread(
  unread: UnreadCapability | undefined,
  channelId: string,
  rootId: string,
) {
  const subscribe = useCallback(
    (listener: () => void) =>
      unread?.subscribe({ kind: "thread", channelId, rootId }, listener) ??
      (() => {}),
    [unread, channelId, rootId],
  );
  const get = useCallback(
    () => unread?.snapshot({ kind: "thread", channelId, rootId }),
    [unread, channelId, rootId],
  );
  return useSyncExternalStore(subscribe, get, get);
}
