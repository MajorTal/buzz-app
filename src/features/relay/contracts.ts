import type { CustomEmoji } from "./emoji";
import type { Delivery } from "./outbox";
/** Folded, read-only channel state. Rows are domain data, not wire events or presentation. */
export type ChannelSummary = Readonly<{
  id: string;
  name: string;
  preview?: string | undefined;
  /** Members-only channel omitted from directories (NIP-29 `hidden`), such as a DM. */
  hidden?: true;
  /** Relay-authored metadata; absent while metadata is unavailable. */
  channelType?: "stream" | "forum" | "dm";
  archived?: true;
  /** Exact members from the relay-signed roster; absent means unknown. */
  members?: readonly string[];
  /** Other DM members from the authorized roster; empty for a self-DM. */
  participants?: readonly string[];
}>;
export type Profile = Readonly<{
  name: string;
  picture?: string;
  about?: string;
  /** Self-declared display hint, not proof of ownership, membership or authority. */
  isAgent?: true;
}>;
export type Attachment = Readonly<{
  url: string;
  video: boolean;
  dimensions?: Readonly<{ width: number; height: number }>;
  /** Validated message-carried BlurHash; decoded locally only for presentation. */
  blurhash?: string;
}>;
/** Relay-authored membership activity, not a membership grant or user message. */
export type MembershipChange = Readonly<{
  type: "member_joined" | "member_left" | "member_removed";
  actor: string;
  target: string;
}>;
export type ChannelMessage = Readonly<{
  id: string;
  channelId: string;
  delivery?: Delivery | undefined;
  deliveryError?: string | undefined;
  authorId: string;
  /** Unix seconds from the signed event. Ordering is (createdAt asc, id desc); no clock inference. */
  createdAt: number;
  content: string;
  /** Original kind 40002, regardless of edits; self-declared display evidence, not authority. */
  agentEnvelope?: true;
  membership?: MembershipChange;
  /** Current body came from a replacement edit; original recipients do not bind its prose. */
  edited?: true;
  /** Attachment removal changed the signed body; new text adjacency cannot bind identities. */
  attachmentContentRemoved?: true;
  /** Pubkeys named by signed `p` tags. Identity never comes from prose. */
  mentions: readonly string[];
  attachments: readonly Attachment[];
  /** Event-local mappings, never the current community palette. */
  emoji?: readonly CustomEmoji[];
  reactions: readonly Readonly<{ content: string; emoji?: CustomEmoji }>[];
  /** Canonical thread-opening target from signed reply/root tags; absent on root messages. */
  threadRootId?: string | undefined;
  /** Relay-signed thread summary for this row; zero when the row has no replies. */
  replyCount: number;
  /** Pubkeys the relay reports as thread participants (may be empty even with replies). */
  participants: readonly string[];
}>;
export type ListStatus = "unavailable" | "idle" | "loading" | "ready" | "error";
export type ChannelList = Readonly<{
  status: ListStatus;
  /** Set when the viewer's roster read hit its cap; omitted channels are then not evidence of removal. */
  coverage?: "partial";
  asOf?: number;
  channels: readonly ChannelSummary[];
  error?: string;
}>;
export type WindowStatus = "idle" | "loading" | "ready" | "error";
/** One bounded, chronologically ordered history window. Not the whole channel. */
export type ChannelWindow = Readonly<{
  channelId: string;
  status: WindowStatus;
  rows: readonly ChannelMessage[];
  /** False only after the relay's window bounds reported no more history. */
  hasMore: boolean;
  loadingOlder: boolean;
  error: string | undefined;
  /** Cached rows are immediately readable, but not claimed fresh until revalidated. */
  freshness?: "cached" | "verified";
  historyLimited?: boolean;
}>;
/** Reads are side-effect-free; snapshots retain identity until their value changes.
 * Commands are idempotent requests; the store decides whether network work is needed. */
export interface ChannelQueries {
  list(): ChannelList;
  subscribeList(listener: () => void): () => void;
  window(channelId: string): ChannelWindow;
  subscribeWindow(channelId: string, listener: () => void): () => void;
  ensureList(): void;
  ensure(channelId: string): void;
  loadOlder(channelId: string): void;
  /** Explicit same-scope head revalidation; replaces the bounded head, not a realtime tail. */
  refresh?(channelId: string): void;
  /** Intent warming is optional for fixture-only query implementations. */
  prepare?(channelId: string): void;
  /** Roster warming is optional for fixture-only query implementations. The
   * caller supplies preferred (e.g. starred) ids; the store orders the rest. */
  warm?(preferred: readonly string[]): void;
  refreshList?(): void;
}
