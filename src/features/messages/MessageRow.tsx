import { memo, useCallback, useSyncExternalStore } from "react";
import type { UnreadCapability } from "../relay/unread";
import { MediaAttachment, type MediaPlayback } from "./MediaAttachment";
import { parseMediaTimeReply } from "./media-timecode";
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
import { ReactionTool } from "../conversation/ReactionTool";
import type { RelaySession } from "../relay/session";

const emptySubscribe = () => () => {};
const EMPTY_CHANNEL_LIST = Object.freeze({
  status: "unavailable" as const,
  channels: Object.freeze([]),
});
const emptyChannelList = () => EMPTY_CHANNEL_LIST;

export type MessageRowProps = {
  row: ChannelMessage;
  session?: RelaySession | undefined;
  scope?: string | undefined;
  unread?: UnreadCapability | undefined;
  extensions?: ConversationExtensions | undefined;
  profile: Profile | undefined;
  participantProfiles?: ReadonlyMap<string, Profile> | undefined;
  canOpenLink?: ((target: string) => boolean) | undefined;
  media(url: string): string | undefined;
  onOpenLink(url: string): boolean;
  day: boolean;
  retry: ((id: string) => void) | undefined;
  onOpenThread?: ((messageId: string) => void) | undefined;
  mediaMode?: "inline" | "thread";
  mediaSeekTo?: number;
  mediaSeekRequest?: number;
  onMediaPlayback?: (playback: MediaPlayback) => void;
  onMediaTime?: (seconds: number) => void;
  onOpenMediaReview?: (
    messageId: string,
    attachment: ChannelMessage["attachments"][number],
    seconds: number,
  ) => void;
};

export const MessageRow = memo(function MessageRow({
  row,
  session,
  scope,
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
  mediaMode = "inline",
  mediaSeekTo,
  mediaSeekRequest,
  onMediaPlayback,
  onMediaTime,
  onOpenMediaReview,
}: MessageRowProps) {
  const threadUnread = useThreadUnread(
    row.replyCount > 0 && onOpenThread ? unread : undefined,
    row.channelId,
    row.threadRootId ?? row.id,
  );
  const channelList = useSyncExternalStore(
    session?.channels.subscribeList ?? emptySubscribe,
    session?.channels.list ?? emptyChannelList,
    session?.channels.list ?? emptyChannelList,
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
  const timeReply = parseMediaTimeReply(row.content);
  const replaceTime = !!timeReply && !!onMediaTime;
  const displayRow = replaceTime ? { ...row, content: timeReply.content } : row;
  const emojiOnly = usesLargeEmojiPresentation(displayRow.content, row.emoji);
  const canReact = !!(
    extensions &&
    session &&
    scope &&
    session.outbox?.supports(7) &&
    !channelList.channels.find((channel) => channel.id === row.channelId)
      ?.archived
  );
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
          className={styles.avatar}
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
          {picture ? (
            <img src={picture} alt="" loading="lazy" />
          ) : (
            name.slice(0, 2).toUpperCase()
          )}
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
          {timeReply && onMediaTime && (
            <button
              type="button"
              className={styles.mediaTimeLink}
              onClick={() => onMediaTime(timeReply.anchor.seconds)}
            >
              {timeReply.label}
            </button>
          )}
          <MessageMarkdown
            row={displayRow}
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
            if (!attachment.video && source)
              return (
                <AttachmentImage
                  key={url}
                  attachment={{ ...attachment, url }}
                  url={url}
                  source={source}
                  onOpenLink={onOpenLink}
                  {...(onOpenMediaReview
                    ? {
                        onOpenReview: (item, seconds) =>
                          onOpenMediaReview(row.id, item, seconds),
                      }
                    : {})}
                />
              );
            return (
              <MediaAttachment
                key={url}
                attachment={{ ...attachment, url }}
                media={media}
                mode={mediaMode}
                {...(attachment.video && mediaSeekTo !== undefined
                  ? {
                      seekTo: mediaSeekTo,
                      ...(mediaSeekRequest !== undefined
                        ? { seekRequest: mediaSeekRequest }
                        : {}),
                    }
                  : {})}
                {...(onMediaPlayback ? { onPlayback: onMediaPlayback } : {})}
                {...(onOpenMediaReview
                  ? {
                      onOpenReview: (item, seconds) =>
                        onOpenMediaReview(row.id, item, seconds),
                    }
                  : {})}
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
              {canReact && extensions && session && scope && (
                <ReactionTool
                  registry={extensions.tools}
                  session={session}
                  scope={scope}
                  messageId={row.id}
                  disabled={
                    !!row.delivery &&
                    !["accepted", "seen"].includes(row.delivery)
                  }
                />
              )}
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
                    <span className={styles.threadAvatar}>
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
