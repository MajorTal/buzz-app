/** Verified live-route message only. Not an activity feed, replay, or read intent. */
export type IncomingMessage = Readonly<{
  channelId: string;
  messageId: string;
  createdAt: number;
  authorId: string;
  /** At most 4,096 source characters for a preview, not the complete message. */
  previewContent: string;
}>;
export type IncomingListener = (messages: readonly IncomingMessage[]) => void;
