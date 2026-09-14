import { IconCornerUpLeft } from "@tabler/icons-react";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Button } from "../../shared/design-system/ui/Button";
import { Avatar } from "../../shared/design-system/ui/Avatar";
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
  viewer?: string | undefined;
  continuation?: boolean;
  groupEnd?: boolean;
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
};

export const MessageRow = memo(function MessageRow({
  row,
  viewer,
  continuation = false,
  groupEnd = true,
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
}: MessageRowProps) {
  const outgoing = !!viewer && row.authorId === viewer;
  const canOpenThread =
    onOpenThread && (!row.delivery || row.delivery === "seen");
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
  const emojiOnly = usesLargeEmojiPresentation(row.content, row.emoji);
  const canReact = !!(
    extensions &&
    session &&
    scope &&
    session.outbox?.supports(7) &&
    !channelList.channels.find((channel) => channel.id === row.channelId)
      ?.archived
  );
  return (
    <div data-message-id={row.id} data-buzz-ui="">
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
      <div
        className={`${styles.message} ${continuation && !day ? styles.continuation : ""}`}
        data-bubble-direction={outgoing ? "outgoing" : "incoming"}
      >
        {!outgoing && <div className={styles.avatarSpace} />}
        <div className={styles.messageBody}>
          <div className={continuation && !day ? styles.srOnly : styles.byline}>
            <strong className={outgoing ? styles.srOnly : undefined}>
              {outgoing ? "You" : name}
            </strong>
            <time
              className={styles.timestamp}
              dateTime={new Date(row.createdAt * 1000).toISOString()}
            >
              {new Date(row.createdAt * 1000).toLocaleTimeString(undefined, {
                hour: "numeric",
                minute: "2-digit",
              })}
            </time>
          </div>
          <div className={styles.bubbleAnchor}>
            {row.content && (
              <MessageMarkdown
                row={row}
                extensions={extensions}
                media={media}
                onOpenLink={onOpenLink}
                canOpenLink={canOpenLink}
                participantProfiles={participantProfiles}
                largeEmoji={emojiOnly}
              />
            )}
            {row.attachments.length > 0 && (
              <div className={styles.attachments}>
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
                      {attachment.video
                        ? "Video attachment"
                        : "Image attachment"}{" "}
                      ↗
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
              </div>
            )}
            {!outgoing && groupEnd && (
              <div className={styles.avatar}>
                {clickable ? (
                  <IconButton
                    size="toolbar"
                    shape="round"
                    aria-label={`View ${name} profile`}
                    onClick={(event) => {
                      event.currentTarget.focus();
                      onOpenLink(target);
                    }}
                    icon={
                      <Avatar
                        src={picture ?? null}
                        alt={name}
                        fallback={name}
                      />
                    }
                  />
                ) : (
                  <Avatar src={picture ?? null} alt={name} fallback={name} />
                )}
              </div>
            )}
            {(canOpenThread || canReact) && (
              <fieldset
                className={styles.bubbleActions}
                aria-label="Message actions"
              >
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
                {canOpenThread && (
                  <IconButton
                    size="compact"
                    shape="round"
                    icon={<IconCornerUpLeft size={16} aria-hidden="true" />}
                    aria-label="Reply in thread"
                    title="Reply in thread"
                    onClick={(event) => {
                      event.currentTarget.focus();
                      onOpenThread(row.id);
                    }}
                  />
                )}
              </fieldset>
            )}
          </div>
          {row.reactions.length > 0 && (
            <div className={styles.reactions}>
              <div className={styles.reactionChips}>
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
            </div>
          )}
          <DeliveryNotice row={row} retry={retry} />
          {row.replyCount > 0 && onOpenThread && (
            <div className={styles.replies}>
              <Button
                variant="ghost"
                size="compact"
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
                          <Avatar
                            src={picture ?? null}
                            alt={name}
                            fallback={name}
                            size="small"
                          />
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
              </Button>
            </div>
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
