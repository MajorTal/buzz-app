import { useEffect, useState, useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";
import type { ThreadView } from "../relay/threads";
import { IconHash, IconLock } from "@tabler/icons-react";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import styles from "./LinkPreview.module.css";
import { messagePreviewText } from "./message-preview-text";

/** Mounted only while a preview is open. The session owns access, edits and deletion. */
export function BuzzLinkPreview({
  session,
  channelId,
  messageId,
}: {
  session: RelaySession;
  channelId: string;
  messageId: string;
}) {
  const [view, setView] = useState<ThreadView>();
  const [error, setError] = useState(false);
  useEffect(() => {
    try {
      const owned = session.thread(channelId, messageId, { exact: true });
      setView(owned);
      void owned.refresh();
      return () => owned.dispose();
    } catch {
      setError(true);
    }
  }, [session, channelId, messageId]);
  if (error) return <span role="status">Message preview unavailable.</span>;
  return view ? (
    <PreviewContent view={view} session={session} messageId={messageId} />
  ) : (
    <span role="status">Loading message…</span>
  );
}

function PreviewContent({
  view,
  session,
  messageId,
}: {
  view: ThreadView;
  session: RelaySession;
  messageId: string;
}) {
  const snapshot = useSyncExternalStore(
    view.subscribe,
    view.snapshot,
    view.snapshot,
  );
  const target =
    snapshot.target?.id === messageId ? snapshot.target : undefined;
  const message =
    target ??
    [snapshot.root, ...snapshot.replies].find((row) => row?.id === messageId);
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  const channels = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
    session.channels.list,
  );
  const authorId = message?.authorId;
  useEffect(() => {
    if (authorId)
      void session.profiles.ensure([authorId], "background").catch(() => {});
  }, [session, authorId]);
  // Only paint reconciled content: a ready exact target is independent of its
  // thread root, while an idle/loading root seed is still the raw event.
  // A terminal state (read error, denied/interrupted purge, or an exhausted
  // read that never found the target) fails honestly instead of loading forever.
  const stopped =
    snapshot.status === "error" ||
    snapshot.targetStatus === "error" ||
    snapshot.targetStatus === "unavailable" ||
    (snapshot.status === "idle" && snapshot.error !== undefined) ||
    (snapshot.status === "ready" && !message && !snapshot.canLoadMore);
  const ready = target
    ? snapshot.targetStatus === "ready"
    : snapshot.status === "ready";
  if (!ready || !message)
    return (
      <span role="status">
        {stopped ? "Message preview unavailable." : "Loading message…"}
      </span>
    );
  const profile = profiles.get(message.authorId);
  const name = profile?.name ?? message.authorId.slice(0, 10);
  const date = new Date(message.createdAt * 1000);
  if (!Number.isFinite(date.getTime()))
    return <span role="status">Message preview unavailable.</span>;
  const channel = channels.channels.find(
    (item) => item.id === message.channelId,
  );
  const channelName =
    channel?.channelType === "dm" && channel.participants
      ? channel.participants
          .map((id) => profiles.get(id)?.name ?? id.slice(0, 10))
          .join(", ") || "Notes to self"
      : (channel?.name ?? "Channel unavailable");
  const ChannelIcon =
    channel?.hidden || channel?.channelType === "dm" ? IconLock : IconHash;
  return (
    <>
      <span className={styles.byline}>
        <Avatar
          alt={name}
          fallback={name}
          src={
            profile?.picture ? (session.media(profile.picture) ?? null) : null
          }
        />
        <span className={styles.metadata}>
          <span className={styles.author}>
            <strong>{name}</strong>
            <time
              dateTime={date.toISOString()}
              title={date.toLocaleString(undefined, {
                dateStyle: "full",
                timeStyle: "short",
              })}
            >
              {relativeTimestamp(message.createdAt)}
            </time>
          </span>
          <span className={styles.channel}>
            {channel && <ChannelIcon aria-hidden="true" size={13} />}
            <span>{channelName}</span>
          </span>
        </span>
      </span>
      <span className={styles.message}>
        {messagePreviewText(message.content) ||
          (message.attachments.length ? "Attachment" : "Empty message")}
      </span>
    </>
  );
}
