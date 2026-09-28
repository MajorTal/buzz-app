import { useState, useSyncExternalStore, type RefObject } from "react";
import type { RelaySession } from "../relay/session";
import type { ConversationExtensions } from "../conversation/contracts";
import { ReactionTool } from "../conversation/ReactionTool";
import { mediaTimeReply } from "./media-timecode";
import styles from "./VideoPlayer.module.css";

/** Quick review reactions are timecoded comments, using the existing reply writer. */
export function VideoReviewReactions({
  session,
  scope,
  channelId,
  rootId,
  videoRef,
  extensions,
}: {
  session: RelaySession;
  scope: string;
  channelId: string;
  rootId: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  extensions?: ConversationExtensions | undefined;
}) {
  const channels = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
    session.channels.list,
  );
  const disabled = !channels.channels.some(
    (channel) => channel.id === channelId && !channel.readOnly,
  );
  const [error, setError] = useState<string>();
  const select = (emoji: string) => {
    if (disabled) return false;
    try {
      videoRef.current?.pause();
      session.messages.reply(
        channelId,
        rootId,
        mediaTimeReply(videoRef.current?.currentTime ?? 0, emoji),
      );
      setError(undefined);
      return true;
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not post reaction.",
      );
      return false;
    }
  };
  return (
    <div className={styles.reactions} data-review-chrome="">
      <fieldset aria-label="React at current frame">
        {["😂", "😍", "😮", "🙌", "👍", "👎"].map((emoji) => (
          <button
            data-buzz-ui=""
            type="button"
            key={emoji}
            disabled={disabled}
            aria-label={`React ${emoji} at current frame`}
            onClick={() => select(emoji)}
          >
            <span
              className={`${styles.reactionEmoji}${emoji === "🙌" ? ` ${styles.raisedHandsEmoji}` : ""}`}
              aria-hidden="true"
            >
              {emoji}
            </span>
          </button>
        ))}
        {extensions && (
          <ReactionTool
            registry={extensions.tools}
            session={session}
            scope={scope}
            messageId={rootId}
            disabled={disabled}
            select={select}
            showDelivery={false}
          />
        )}
      </fieldset>
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
