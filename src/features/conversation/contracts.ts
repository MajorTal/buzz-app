// FOUNDATION: Preview conversation contribution contract; data and delivery stay session-owned.
import type { ComponentType, ReactNode } from "react";
import type { Contribution } from "../../plugins/contributions";
import type { ChannelMessage } from "../relay/contracts";
import type { RelaySession } from "../relay/session";

export type ComposerToolProps = Readonly<{
  session: RelaySession;
  scope: string;
  channelId: string;
  threadRootId?: string | undefined;
  disabled: boolean;
  /** False after removal, destination change, read-only state or a rejected edit. */
  insertText(text: string): boolean;
  /** Atomically insert display text and explicit notification intent at the caret.
   * Prose never resolves to identities. Membership is checked by session delivery.
   * Like insertText, this command is revoked with the tool/destination lifetime. */
  insertMention(recipient: Readonly<{ pubkey: string; name: string }>): boolean;
  focus(): void;
}>;
export type ReactionToolProps = Readonly<{
  session: RelaySession;
  scope: string;
  disabled: boolean;
  /** Host-owned reaction intent; revoked when the tool or target is removed. */
  select(emoji: string): boolean;
}>;
export type ComposerTool = Readonly<{
  id: string;
  title: string;
  /** Lower values appear first; defaults to zero. Equal values sort by contribution key. */
  order?: number;
  component: ComponentType<ComposerToolProps>;
  /** Optional emoji-only chooser for the message reaction row. */
  reactionComponent?: ComponentType<ReactionToolProps>;
}>;
export type InlineContent = Readonly<{
  text: string;
  /** True when text is a Markdown link destination, not message prose. */
  link?: boolean;
  message: ChannelMessage;
  reaction?: ChannelMessage["reactions"][number] | undefined;
}>;
export type InlineRange = Readonly<{ start: number; end: number }>;
/** Plugin-owned annotations beneath a message. Never alter its signed body or timeline identity. */
export type MessageAttachmentProps = Readonly<{
  message: ChannelMessage;
  session: RelaySession;
  scope: string;
}>;
export type MessageAttachment = Readonly<{
  id: string;
  title: string;
  /** Synchronous eligibility only; the component owns reactive plugin data. */
  matches(message: ChannelMessage): boolean;
  /** Stable key for all data affecting this channel's annotation heights. Null or omitted disables cached geometry. */
  cacheKey?(scope: string, channelId: string): string | null;
  component: ComponentType<MessageAttachmentProps>;
}>;
export type InlineRenderer = Readonly<{
  id: string;
  title: string;
  /** Opt in to complete Markdown link destinations; partial matches retain the original link.
   * Destinations are raw, unvalidated, author-controlled input; validate before using as a URL. */
  links?: boolean;
  /** UTF-16 ranges within this segment. Link destinations require explicit opt-in. */
  matches(content: InlineContent): readonly InlineRange[];
  component: ComponentType<{
    text: string;
    content: InlineContent;
    /** Host-rendered original link, for renderers without data for this destination. */
    fallback?: ReactNode;
    media(url: string): string | undefined;
  }>;
}>;
export type ContributionReader<T> = Readonly<{
  snapshot(): readonly Contribution<T>[];
  subscribe(listener: () => void): () => void;
}>;
export type ConversationExtensions = Readonly<{
  tools: ContributionReader<ComposerTool>;
  inline: ContributionReader<InlineRenderer>;
  completions?: ContributionReader<ComposerCompletion>;
  attachments?: ContributionReader<MessageAttachment>;
}>;

/** Immutable host-issued evidence, scoped to one live editor observation. */
export type ComposerObservation = Readonly<{
  revision: number;
  text: string;
  start: number;
  end: number;
}>;
export type CompletionContext = Pick<
  ComposerToolProps,
  "session" | "scope" | "channelId" | "threadRootId"
>;
export type CompletionQuery = Readonly<{
  start: number;
  end: number;
  query: string;
}>;
export type CompletionEdit =
  | Readonly<{ text: string; mention?: never }>
  | Readonly<{
      mention: Readonly<{ pubkey: string; name: string }>;
      text?: never;
    }>;
export type CompletionSuggestion = Readonly<{
  id: string;
  label: string;
  detail?: string;
  /** Decorative presentation only; the host owns option semantics and interaction. */
  preview?: import("react").ReactNode;
  edit: CompletionEdit;
}>;
export type CompletionResult = Readonly<{
  items: readonly CompletionSuggestion[];
  status?: string;
  /** Optional explicit recovery. A new query or disposal revokes this action. */
  retry?: () => void;
}>;
export type ComposerCompletionProps = CompletionContext &
  Readonly<{
    observation: ComposerObservation;
    query: CompletionQuery;
    /** Publishes only for this query/lifetime; returns false after revocation.
     * Cleanup of the returned disposer withdraws that exact publication. */
    publish(result: CompletionResult): (() => void) | false;
  }>;
export type ComposerCompletion = Readonly<{
  id: string;
  title: string;
  order?: number;
  /** Pure syntax matcher. Host prefers the closest trigger; order/key break ties. */
  match(
    observation: ComposerObservation,
    context: CompletionContext,
  ): CompletionQuery | null;
  component: ComponentType<ComposerCompletionProps>;
}>;
