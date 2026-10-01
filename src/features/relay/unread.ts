import type { ChannelQueries } from "./contracts";
import type { RelayEvent } from "./events";
import {
  effectiveFrontier,
  overrideActive,
  targetKey,
  type ReadTarget,
  type ReadState,
} from "./read-state-model";
import type {
  createReadState,
  ReadMutationResult,
  ReadSyncSnapshot,
} from "./read-state";
import type { Priority, RelayReader } from "./reader";
import { foldMessages } from "./fold";
import { threadReference } from "./thread-reference";

export type UnreadSnapshot = Readonly<{
  target: ReadTarget;
  /** Latest verified content evidence, including read and self-authored messages. */
  latestMessage?: Readonly<{ id: string; createdAt: number }>;
  /** null means unobserved/denied, never a fabricated zero or an exact relay total. */
  observedCount: number | null;
  attentionCount: number | null;
  coverage: "unknown" | "observed";
  freshness: "unknown" | "observed" | "stale";
  manual: "none" | "local-only" | "remote";
  error?: string | undefined;
}>;
export type MessageAttention = Readonly<{
  status: "unknown" | "ineligible" | "eligible";
  category?: "mention" | "direct" | "thread";
  /** The event explicitly p-tags the viewer, even inside DM channels. */
  mentioned?: boolean;
  rootId?: string;
  /** The reply's conversation is still being looked up; it may become thread
   * attention when the lookup finishes. */
  pending?: boolean;
  unread: boolean;
  /** This row is explicitly forced unread during the current channel visit. */
  forced: boolean;
  viewing: boolean;
}>;
export type ThreadActivityItem = Readonly<{
  channelId: string;
  rootId: string;
  latestMessageId: string;
  authorId: string;
  createdAt: number;
  preview: string;
  unreadCount: number;
}>;
export type ThreadActivitySnapshot = Readonly<{
  channelId: string;
  /** null means activity evidence is unknown or access is denied. */
  items: readonly ThreadActivityItem[] | null;
  coverage: "unknown" | "observed";
  freshness: "unknown" | "observed" | "stale";
  error?: string | undefined;
}>;
export type ReadingHandle = Readonly<{
  /** Qualified visible rows only. This publishes no read intent and ends with the lease. */
  view(messageIds: readonly string[], visible: () => boolean): void;
  /** Only message IDs actually visible to the active consumer; no caller timestamps. */
  observe(messageIds: readonly string[]): Promise<void>;
  /** Bottom dwell through verified evidence; channel catch-up excludes attention. */
  catchUp(messageId: string, rootId?: string): Promise<void>;
  dispose(): void;
}>;
export interface UnreadCapability {
  snapshot(target: ReadTarget): UnreadSnapshot;
  /** Same verified attention/frontier policy as badges, not a notification event source. */
  attention(channelId: string, messageId: string): MessageAttention;
  subscribe(target: ReadTarget, listener: () => void): () => void;
  activity(channelId: string): ThreadActivitySnapshot;
  subscribeActivity(channelId: string, listener: () => void): () => void;
  sync(): ReadSyncSnapshot;
  subscribeSync(listener: () => void): () => void;
  ensure(): Promise<void>;
  refresh(): Promise<void>;
  retrySync(): Promise<void>;
  reading(channelId: string): ReadingHandle;
  /** Explicit prefix intent, unlike individual-message visibility observations. */
  markThrough(
    target: ReadTarget,
    messageId: string,
  ): Promise<ReadMutationResult>;
  /** One immediate menu action over the selected verified message and loaded reply subtree. */
  markMessageUnread(
    channelId: string,
    messageId: string,
  ): Promise<ReadMutationResult>;
  markMessageRead(
    channelId: string,
    messageId: string,
  ): Promise<ReadMutationResult>;
  /** End the channel visit; the device-local sidebar force remains until next open. */
  leaveChannel(channelId: string): void;
  /** Reconcile the previous visit's sidebar force without clearing independent channel intent. */
  enterChannel(channelId: string): Promise<void>;
  /** Explicit channel prefix through retained verified evidence, including replies. */
  markChannelRead(channelId: string): Promise<ReadMutationResult>;
  /** `markChannelRead` serialised over every accessible listed channel that still
   * shows unread evidence or a local mark. Channels with nothing to clear are
   * skipped, so an already-read community costs no writes. One failing channel
   * does not stop the rest; the first failure is rethrown after the sweep. */
  markAllChannelsRead(): Promise<readonly ReadMutationResult[]>;
  markUnreadLocal(target: ReadTarget): Promise<ReadMutationResult>;
  clearUnreadLocal(target: ReadTarget): Promise<ReadMutationResult>;
  readonly syncedManualUnread: false;
}
const contentKind = (event: RelayEvent) =>
  event.kind === 9 || event.kind === 40002 || event.kind === 40008;
const channelIds = new WeakMap<RelayEvent, string | undefined>();
/** Verified events are frozen, and every evidence index asks for each one. */
const channelOf = (event: RelayEvent) => {
  if (channelIds.has(event)) return channelIds.get(event);
  const tags = event.tags.filter(([name]) => name === "h");
  const channelId = tags.length === 1 ? tags[0]?.[1] : undefined;
  channelIds.set(event, channelId);
  return channelId;
};
const auxiliaryKind = (event: RelayEvent) =>
  event.kind === 40003 || event.kind === 5 || event.kind === 9005;
/** Resolve every owning channel through bounded reference-only auxiliary ancestry.
 * A missing target, cycle, or unsupported intermediary fails closed. */
function channelOwnership(find: (id: string) => RelayEvent | undefined) {
  const memo = new Map<string, ReadonlySet<string> | undefined>();
  const visiting = new Set<string>();
  function owners(event: RelayEvent): ReadonlySet<string> | undefined {
    if (memo.has(event.id)) return memo.get(event.id);
    if (visiting.has(event.id) || visiting.size >= 32) return;
    visiting.add(event.id);
    const direct = channelOf(event);
    let resolved: Set<string> | undefined;
    if (contentKind(event)) {
      if (direct) resolved = new Set([direct]);
    } else if (auxiliaryKind(event)) {
      resolved = direct ? new Set([direct]) : new Set();
      const targets = event.tags.flatMap(([name, id]) =>
        name === "e" && id ? [id] : [],
      );
      if (!direct && !targets.length) resolved = undefined;
      for (const id of targets) {
        const target = find(id);
        const inherited = target && owners(target);
        if (!inherited) {
          resolved = undefined;
          break;
        }
        for (const channel of inherited) resolved?.add(channel);
      }
      if (!resolved?.size) resolved = undefined;
    }
    visiting.delete(event.id);
    memo.set(event.id, resolved);
    return resolved;
  }
  return owners;
}
/** Bounded verified evidence and one projection; no sidebar counters, sockets or implicit reads. */
export function createUnread({
  reads,
  channels,
  reader,
  viewer,
  notify = (listener) => listener(),
}: {
  reads: ReturnType<typeof createReadState>;
  channels: ChannelQueries;
  reader: RelayReader;
  viewer: string;
  notify?: (listener: () => void) => void;
}) {
  let closed = false,
    epoch = 0;
  let requested = false;
  let repairAgain = false;
  let freshness: UnreadSnapshot["freshness"] = "unknown";
  let error: string | undefined;
  let refresh: Promise<void> | undefined;
  const lifetime = new AbortController();
  const events = new Map<string, RelayEvent>();
  const known = new Set<string>();
  const listeners = new Map<string, Set<() => void>>();
  const snapshots = new Map<string, UnreadSnapshot>();
  const dirty = new Set<string>();
  const activityListeners = new Map<string, Set<() => void>>();
  const activitySnapshots = new Map<string, ThreadActivitySnapshot>();
  const activityDirty = new Set<string>();
  const handles = new Set<() => void>();
  const views = new Map<
    () => void,
    { ids: ReadonlySet<string>; visible: () => boolean }
  >();
  // Per-visit message overlay; only the sidebar hint is persisted in read state.
  const forcedMessages = new Map<string, Set<string>>();
  const entered = new Set<string>();
  const messageForceKey = (channelId: string) => `message-force:${channelId}`;
  const visits = new Map<string, number>();
  const mutations = new Map<string, Promise<unknown>>();
  // Explicit channel reads survive unrelated roster changes, but never their
  // own revoke/regrant or a session/cache reset. Tokens cannot be revived.
  const channelReadGenerations = new Map<string, object>();
  function serialize<T>(
    channelId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const prior = mutations.get(channelId) ?? Promise.resolve();
    const next = prior.then(operation, operation);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    mutations.set(channelId, settled);
    void settled.then(() => {
      if (mutations.get(channelId) === settled) mutations.delete(channelId);
    });
    return next;
  }

  let bytes = 0;
  const allowed = (id: string) =>
    channels
      .list()
      .channels.some(
        (channel) =>
          channel.id === id &&
          !channel.cached &&
          channel.members?.includes(viewer),
      );
  const keyFor = (target: ReadTarget) =>
    `${target.channelId}:${targetKey(target)}`;
  /** Counted evidence, or a fetched parent/root kept only for structure. */
  const structural = (id: string) => events.get(id) ?? lookupEvents.get(id);
  function root(event: RelayEvent): string | undefined {
    const channel = channelOf(event);
    let current = event;
    const seen = new Set<string>();
    for (let depth = 0; depth < 32; depth++) {
      if (seen.has(current.id)) return;
      seen.add(current.id);
      const reference = threadReference(current);
      if (!reference) return current.id;
      const next = structural(reference.rootId);
      if (!next || !contentKind(next) || channelOf(next) !== channel) return;
      current = next;
    }
  }
  type Evidence = {
    event: RelayEvent;
    channelId: string;
    rootId: string | undefined;
    /** Direct parent of a reply; undefined for top-level messages. */
    parentId: string | undefined;
    mentioned: boolean;
    broadcast: boolean;
  };
  let indexed = false;
  const byChannel = new Map<string, Evidence[]>();
  const tombstones = new Set<string>();
  // Conversation membership: the viewer's own messages, and the parents the
  // viewer has replied to, each keyed by channel. A conversation is the set of
  // replies to one parent.
  const own = new Map<string, string>();
  const joined = new Set<string>();
  // Relay lookups for parents the sampled window cannot decide. They are kept
  // apart from counted evidence: fetched events never count, never fill the
  // window and survive its overflow reset, because whether the viewer wrote or
  // answered a message does not change with the sample. Bounded, oldest first.
  // Keyed by channel and parent, like `joined`. `evidence` is one of the
  // viewer's messages that make the viewer a member (the parent itself, or a
  // reply to it), held as a witness; `more` records that the viewer has
  // others. The viewer's own parent is preferred, and the first witness is
  // kept. Deleting the witness ends the membership, or asks again if `more`.
  // One witness per lookup keeps every positive lookup within the witness
  // bound, however many replies one batch returns.
  type Lookup = {
    channelId: string;
    done: boolean;
    evidence: string | undefined;
    more: boolean;
  };
  const lookups = new Map<string, Lookup>();
  const lookupEvents = new Map<string, RelayEvent>();
  const queued = new Map<
    string,
    { channelId: string; parentId: string; ids: Set<string> }
  >();
  // The viewer's own deleted messages, so neither a stored lookup result nor
  // one still in flight can outlive them.
  const retracted = new Set<string>();
  // The viewer's messages behind positive lookups, kept so a deletion from
  // another client can be verified (see `event`) after the window drops them.
  // They are not counted evidence. Evicting one forgets the lookups it backs,
  // so a membership never outlives the means to observe its deletion. Callers
  // remember a lookup before witnessing it, so eviction always sees it.
  const witnesses = new Map<string, RelayEvent>();
  const conversationKey = (channelId: string, parentId: string) =>
    `${channelId}:${parentId}`;
  function witness(lookup: Lookup, event: RelayEvent) {
    // Keep the first witness: replacing it could hide the deletion of a
    // cached parent that a later lookup would reuse.
    if (lookup.evidence !== undefined && lookup.evidence !== event.id) {
      lookup.more = true;
      return;
    }
    lookup.evidence = event.id;
    witnesses.delete(event.id);
    witnesses.set(event.id, event);
    for (const [oldest] of witnesses) {
      if (witnesses.size <= 4096) break;
      witnesses.delete(oldest);
      for (const [key, other] of lookups)
        if (other.evidence === oldest) lookups.delete(key);
    }
  }
  let scheduled = false;
  let failures = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const membershipListeners = new Set<() => void>();
  function indexEvidence() {
    if (indexed) return;
    indexed = true;
    byChannel.clear();
    tombstones.clear();
    own.clear();
    joined.clear();
    for (const event of events.values()) {
      if (event.kind !== 5 && event.kind !== 9005) continue;
      for (const [name, id] of event.tags)
        if (name === "e" && id && events.get(id)?.pubkey === event.pubkey)
          tombstones.add(id);
    }
    for (const event of events.values()) {
      if (!contentKind(event) || tombstones.has(event.id)) continue;
      const channel = channelOf(event);
      if (!channel) continue;
      const rootId = root(event);
      const parentId = threadReference(event)?.parentId;
      if (event.pubkey === viewer) {
        own.set(event.id, channel);
        if (parentId) {
          joined.add(`${channel}:${parentId}`);
          // A later reply of the viewer outlives the window that showed it.
          const lookup = lookups.get(conversationKey(channel, parentId));
          if (lookup?.done) witness(lookup, event);
        }
      }
      const rows = byChannel.get(channel) ?? [];
      rows.push({
        event,
        channelId: channel,
        rootId: parentId ? rootId : undefined,
        parentId,
        mentioned: event.tags.some(
          ([name, value]) => name === "p" && value === viewer,
        ),
        broadcast: event.tags.some(
          ([name, value]) => name === "broadcast" && value === "1",
        ),
      });
      byChannel.set(channel, rows);
    }
  }
  function deleted(event: RelayEvent): boolean {
    indexEvidence();
    return tombstones.has(event.id);
  }
  /** Evidence of the target's channel: the index already resolved its channel
   * and reply root, which every selector would otherwise derive per event. */
  function inTarget({ event, rootId }: Evidence, target: ReadTarget) {
    return (
      target.kind === "channel" ||
      (target.kind === "message" && target.messageId === event.id) ||
      (target.kind === "thread" && rootId === target.rootId)
    );
  }
  const isDm = (channelId: string) =>
    channels.list().channels.find((channel) => channel.id === channelId)
      ?.channelType === "dm";
  /** The reply is in a conversation the viewer is part of in its own channel:
   * it answers the viewer's message, or the viewer also replied to the same
   * parent. Undecided parents are not members until their lookup finishes. */
  const conversation = ({ parentId, channelId }: Evidence) => {
    if (!parentId) return false;
    const key = conversationKey(channelId, parentId);
    return (
      own.get(parentId) === channelId ||
      joined.has(key) ||
      lookups.get(key)?.evidence !== undefined
    );
  };
  /** Top-level posts always count. A reply counts only in the viewer's own
   * conversations, or when it is a DM, mentions the viewer, or is broadcast. */
  const relevant = (entry: Evidence, dm: boolean) =>
    !entry.parentId ||
    dm ||
    entry.mentioned ||
    entry.broadcast ||
    conversation(entry);
  /** Retained evidence cannot decide this reply's conversation yet. */
  const undecided = (entry: Evidence, dm: boolean) =>
    !!entry.parentId &&
    !relevant(entry, dm) &&
    !lookups.get(conversationKey(entry.channelId, entry.parentId))?.done;
  function isUnread(entry: Evidence, state: ReadState, dm: boolean) {
    const { event, channelId } = entry;
    if (event.pubkey === viewer) return false;
    // Explicit per-message unread intent wins; otherwise replies outside the
    // viewer's conversations are not unread.
    if (
      forcedMessages.get(channelId)?.has(event.id) ||
      reads.localUnread(`msg:${event.id}`)
    )
      return true;
    return relevant(entry, dm) && afterFrontier(entry, state, dm);
  }
  /** The read-state half of unread, before conversation relevance. */
  function afterFrontier(entry: Evidence, state: ReadState, dm: boolean) {
    const { event, channelId, rootId } = entry;
    const frontier = effectiveFrontier(
      state,
      `msg:${event.id}`,
      channelId,
      rootId,
    );
    const forced =
      overrideActive(state.overrides[`msg:${event.id}`], frontier) ||
      overrideActive(
        state.overrides[channelId],
        effectiveFrontier(state, channelId),
      ) ||
      (rootId !== undefined &&
        overrideActive(
          state.overrides[`thread:${rootId}`],
          effectiveFrontier(state, `thread:${rootId}`, channelId),
        ));
    // Channel catch-up never acknowledges thread replies: retained evidence
    // cannot prove nonparticipation, especially after reload. Only ordinary
    // top-level messages inherit it; reply attention/direct thread dots survive.
    const ordinary =
      !threadReference(event) && !priority(entry, dm)
        ? state.frontiers[`activity:${channelId}`]
        : undefined;
    const thread = rootId
      ? state.frontiers[`thread-activity:${rootId}`]
      : undefined;
    const caughtUp = Math.max(frontier ?? -1, ordinary ?? -1, thread ?? -1);
    return event.created_at > caughtUp || !!forced;
  }
  function category(
    entry: Evidence,
    dm: boolean,
  ): MessageAttention["category"] {
    // DM events p-tag the recipient, so a mention check would classify every
    // direct message as a mention. Direct wins inside DM channels. Thread
    // attention follows the direct parent, even when the root is unknown.
    return dm
      ? "direct"
      : entry.mentioned
        ? "mention"
        : conversation(entry)
          ? "thread"
          : undefined;
  }
  function priority(entry: Evidence, dm: boolean) {
    return !!category(entry, dm) || entry.broadcast;
  }
  function attention(channelId: string, messageId: string): MessageAttention {
    const unknown = Object.freeze({
      status: "unknown",
      unread: false,
      forced: false,
      viewing: false,
    } as const);
    if (closed || !allowed(channelId)) return unknown;
    indexEvidence();
    const event = events.get(messageId);
    if (!event || channelOf(event) !== channelId || !contentKind(event))
      return unknown;
    const entry = byChannel
      .get(channelId)
      ?.find((row) => row.event.id === messageId);
    if (!entry || event.pubkey === viewer)
      return Object.freeze({
        status: "ineligible",
        unread: false,
        forced: forcedMessages.get(channelId)?.has(messageId) ?? false,
        viewing: false,
      });
    const dm = isDm(channelId);
    const kind = category(entry, dm);
    // A queued or running lookup may still make this reply thread attention.
    // A read reply is never looked up, so it is undecided but not pending.
    const open = undecided(entry, dm);
    if (open) want(entry, dm);
    const pending =
      open &&
      lookups.get(conversationKey(channelId, entry.parentId ?? ""))?.done ===
        false;
    const viewing = [...views.values()].some(
      (view) => view.ids.has(messageId) && view.visible(),
    );
    return Object.freeze({
      status: kind
        ? "eligible"
        : open || (threadReference(event) && !entry.rootId)
          ? "unknown"
          : "ineligible",
      ...(kind ? { category: kind } : {}),
      ...(pending ? { pending: true } : {}),
      ...(entry.mentioned ? { mentioned: true } : {}),
      ...(entry.rootId ? { rootId: entry.rootId } : {}),
      unread: isUnread(entry, reads.state(), dm),
      forced: forcedMessages.get(channelId)?.has(messageId) ?? false,
      viewing,
    });
  }
  function compute(target: ReadTarget): UnreadSnapshot {
    const key = targetKey(target);
    const accessible =
      allowed(target.channelId) &&
      (target.kind === "channel" ||
        (() => {
          const event =
            target.kind === "thread"
              ? structural(target.rootId)
              : events.get(target.messageId);
          return (
            !!event &&
            channelOf(event) === target.channelId &&
            contentKind(event)
          );
        })());
    if (!accessible)
      return Object.freeze({
        target,
        observedCount: null,
        attentionCount: null,
        coverage: "unknown",
        freshness: "unknown",
        manual: "none",
      });
    const evidence = known.has(target.channelId);
    const state = reads.state();
    let count = 0,
      attention = 0;
    const dm = isDm(target.channelId);
    indexEvidence();
    let latest: RelayEvent | undefined;
    for (const entry of byChannel.get(target.channelId) ?? []) {
      const event = entry.event;
      if (
        target.kind === "channel" &&
        (!latest ||
          event.created_at > latest.created_at ||
          (event.created_at === latest.created_at && event.id < latest.id))
      )
        latest = event;
      if (!inTarget(entry, target)) continue;
      want(entry, dm);
      if (!isUnread(entry, state, dm)) continue;
      count++;
      if (priority(entry, dm)) attention++;
    }
    const manual = reads.localUnread(key)
      ? "local-only"
      : target.kind === "message" &&
          forcedMessages.get(target.channelId)?.has(target.messageId)
        ? "local-only"
        : target.kind === "channel" &&
            reads.localUnread(messageForceKey(target.channelId))
          ? "local-only"
          : overrideActive(
                state.overrides[key],
                effectiveFrontier(state, key, target.channelId),
              )
            ? "remote"
            : "none";
    return Object.freeze({
      target,
      ...(latest
        ? { latestMessage: { id: latest.id, createdAt: latest.created_at } }
        : {}),
      observedCount: evidence ? count : null,
      attentionCount: evidence ? attention : null,
      coverage: evidence ? "observed" : "unknown",
      freshness,
      manual,
      ...(error ? { error } : {}),
    });
  }
  const equal = (a: UnreadSnapshot, b: UnreadSnapshot) =>
    a.latestMessage?.id === b.latestMessage?.id &&
    a.observedCount === b.observedCount &&
    a.attentionCount === b.attentionCount &&
    a.coverage === b.coverage &&
    a.freshness === b.freshness &&
    a.manual === b.manual &&
    a.error === b.error;
  function computeActivity(channelId: string): ThreadActivitySnapshot {
    if (!allowed(channelId) || !known.has(channelId))
      return Object.freeze({
        channelId,
        items: null,
        coverage: "unknown",
        freshness: "unknown",
      });
    indexEvidence();
    const state = reads.state();
    const dm = isDm(channelId);
    const grouped = new Map<string, ThreadActivityItem>();
    // Only unread thread activity is presented; most publishes have none.
    let presented: Map<string, string> | undefined;
    for (const evidence of byChannel.get(channelId) ?? []) {
      const { event, rootId, mentioned, broadcast } = evidence;
      want(evidence, dm);
      if (
        !rootId ||
        (!mentioned && !broadcast && !conversation(evidence)) ||
        !isUnread(evidence, state, dm)
      )
        continue;
      const current = grouped.get(rootId);
      presented ??= new Map(
        foldMessages(channelId, "", [...events.values()], {
          includeReplies: true,
        }).map((message) => [message.id, message.content]),
      );
      const preview = presented.get(event.id) ?? event.content;
      if (!current) {
        grouped.set(
          rootId,
          Object.freeze({
            channelId,
            rootId,
            latestMessageId: event.id,
            authorId: event.pubkey,
            createdAt: event.created_at,
            preview,
            unreadCount: 1,
          }),
        );
        continue;
      }
      const latest =
        event.created_at > current.createdAt ||
        (event.created_at === current.createdAt &&
          event.id < current.latestMessageId);
      grouped.set(
        rootId,
        Object.freeze({
          channelId,
          rootId,
          latestMessageId: latest ? event.id : current.latestMessageId,
          authorId: latest ? event.pubkey : current.authorId,
          createdAt: latest ? event.created_at : current.createdAt,
          preview: latest ? preview : current.preview,
          unreadCount: current.unreadCount + 1,
        }),
      );
    }
    return Object.freeze({
      channelId,
      items: Object.freeze(
        [...grouped.values()].sort(
          (a, b) =>
            b.createdAt - a.createdAt ||
            a.latestMessageId.localeCompare(b.latestMessageId),
        ),
      ),
      coverage: "observed",
      freshness,
      ...(error ? { error } : {}),
    });
  }
  const equalActivity = (
    a: ThreadActivitySnapshot,
    b: ThreadActivitySnapshot,
  ) =>
    a.coverage === b.coverage &&
    a.freshness === b.freshness &&
    a.error === b.error &&
    ((a.items === null && b.items === null) ||
      (a.items !== null &&
        b.items !== null &&
        a.items.length === b.items.length &&
        a.items.every((item, index) => {
          const other = b.items?.[index];
          return (
            item.rootId === other?.rootId &&
            item.latestMessageId === other.latestMessageId &&
            item.authorId === other.authorId &&
            item.createdAt === other.createdAt &&
            item.preview === other.preview &&
            item.unreadCount === other.unreadCount
          );
        })));
  function activity(channelId: string) {
    const previous = activitySnapshots.get(channelId);
    if (previous && !activityDirty.delete(channelId)) return previous;
    const value = computeActivity(channelId);
    if (previous && equalActivity(previous, value)) return previous;
    activitySnapshots.set(channelId, value);
    return value;
  }
  function snapshot(target: ReadTarget) {
    const key = keyFor(target),
      previous = snapshots.get(key);
    if (previous && !dirty.delete(key)) return previous;
    const value = compute(previous?.target ?? Object.freeze({ ...target }));
    if (previous && equal(previous, value)) return previous;
    if (!previous && snapshots.size >= 4096) {
      for (const key of snapshots.keys())
        if (!listeners.has(key)) {
          snapshots.delete(key);
          dirty.delete(key);
        }
      if (snapshots.size >= 4096)
        throw new Error("Unread selector capacity reached");
    }
    snapshots.set(key, value);
    return value;
  }
  function addActivityListener(channelId: string, listener: () => void) {
    activity(channelId);
    const set = activityListeners.get(channelId) ?? new Set();
    set.add(listener);
    activityListeners.set(channelId, set);
    return () => {
      set.delete(listener);
      if (!set.size) activityListeners.delete(channelId);
    };
  }
  function publish(channelIds?: ReadonlySet<string>) {
    if (closed) return;
    const changed: string[] = [];
    const changedActivity: string[] = [];
    for (const [key, old] of snapshots) {
      if (channelIds && !channelIds.has(old.target.channelId)) continue;
      // Revisit dormant selectors lazily, retaining identity if unchanged.
      if (!listeners.has(key)) {
        dirty.add(key);
        continue;
      }
      const next = compute(old.target);
      if (!equal(old, next)) {
        snapshots.set(key, next);
        changed.push(key);
      }
    }
    for (const [channelId, old] of activitySnapshots) {
      if (channelIds && !channelIds.has(channelId)) continue;
      if (!activityListeners.has(channelId)) {
        activityDirty.add(channelId);
        continue;
      }
      const next = computeActivity(channelId);
      if (!equalActivity(old, next)) {
        activitySnapshots.set(channelId, next);
        changedActivity.push(channelId);
      }
    }
    // Replace/invalidate ALL affected projections before any reentrant callback.
    for (const key of changed)
      for (const listener of listeners.get(key) ?? []) notify(listener);
    for (const channelId of changedActivity)
      for (const listener of activityListeners.get(channelId) ?? [])
        notify(listener);
  }
  const stopRead = reads.subscribe(publish);
  function purge() {
    // A revoke/regrant must not revive a transaction accepted under the old access epoch.
    epoch++;
    for (const channelId of channelReadGenerations.keys())
      if (!allowed(channelId)) channelReadGenerations.delete(channelId);
    for (const [key, lookup] of lookups)
      if (!allowed(lookup.channelId)) lookups.delete(key);
    for (const [id, event] of lookupEvents)
      if (!allowed(channelOf(event) ?? "")) lookupEvents.delete(id);
    for (const [id, event] of witnesses)
      if (!allowed(channelOf(event) ?? "")) witnesses.delete(id);
    for (const [key, { channelId }] of queued)
      if (!allowed(channelId)) queued.delete(key);
    const denied = new Set(
      [...known, ...forcedMessages.keys()].filter(
        (channel) => !allowed(channel),
      ),
    );
    for (const channel of denied) {
      known.delete(channel);
      forcedMessages.delete(channel);
      entered.delete(channel);
    }
    const retained = new Map(events);
    const owners = channelOwnership((targetId) => retained.get(targetId));
    for (const [id, event] of retained) {
      const channels = owners(event);
      if (!channels || [...channels].some((channel) => !allowed(channel)))
        events.delete(id);
    }
    indexed = false;
    // Reference-only tombstones are retained only with a still-accessible target.
    bytes = [...events.values()].reduce(
      (total, event) =>
        total + new TextEncoder().encode(JSON.stringify(event)).byteLength,
      0,
    );
    publish();
  }
  // Names/previews do not affect unread. Read membership once, without a
  // roster scan for every channel, and retain only the invalidation inputs.
  const types = (list: ReturnType<ChannelQueries["list"]>) =>
    new Map(
      list.channels
        .filter(
          (channel) => !channel.cached && channel.members?.includes(viewer),
        )
        .map((channel) => [channel.id, channel.channelType]),
    );
  const cachedIds = (list: ReturnType<ChannelQueries["list"]>) =>
    new Set(
      list.channels
        .filter((channel) => channel.cached)
        .map((channel) => channel.id),
    );
  const initialList = channels.list();
  let cachedChannels = cachedIds(initialList);
  let channelTypes = types(initialList);
  let accessKey = [...channelTypes.keys()].sort().join(",");
  const stopChannels = channels.subscribeList(() => {
    const list = channels.list();
    const nextTypes = types(list);
    const next = [...nextTypes.keys()].sort().join(",");
    const changed = new Set(
      [...nextTypes].flatMap(([id, type]) =>
        channelTypes.get(id) !== type ? [id] : [],
      ),
    );
    const confirmed = [...nextTypes.keys()].some((id) =>
      cachedChannels.has(id),
    );
    cachedChannels = cachedIds(list);
    channelTypes = nextTypes;
    if (next === accessKey) {
      if (changed.size) publish(changed);
    } else {
      accessKey = next;
      purge();
      // An initial observation made against a display-only roster still owes
      // evidence when membership becomes fresh, including during an active repair.
      if (requested && confirmed) {
        repairAgain = true;
        if (!refresh) void repair();
      }
    }
  });
  // Conversation membership for unread replies whose parent conversation is
  // not decided by retained evidence: the parent may be the viewer's own older
  // message, or the viewer may have replied to it outside the sampled window.
  // A selector that evaluates an otherwise-unread reply asks the relay once per
  // parent. Selectors only queue the parent; the fetch starts in a microtask,
  // so channels nobody observes cost nothing. Fetched events are structure
  // only: they never count and never start another lookup, so a lookup cannot
  // walk up an old thread.
  function want(entry: Evidence, dm: boolean) {
    const { event, channelId, parentId } = entry;
    if (!parentId || event.pubkey === viewer) return;
    const key = conversationKey(channelId, parentId);
    if (
      lookups.has(key) ||
      !undecided(entry, dm) ||
      !afterFrontier(entry, reads.state(), dm)
    )
      return;
    lookups.set(key, {
      channelId,
      done: false,
      evidence: undefined,
      more: false,
    });
    const ids = new Set([parentId]);
    // Also fetch the root so a reply to a fetched parent still groups and opens.
    const rootId = threadReference(event)?.rootId;
    if (rootId && !structural(rootId)) ids.add(rootId);
    queued.set(key, { channelId, parentId, ids });
    if (scheduled || retry) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      void resolveConversations();
    });
  }
  function resetLookups() {
    lookups.clear();
    lookupEvents.clear();
    queued.clear();
    retracted.clear();
    witnesses.clear();
    failures = 0;
    if (retry) clearTimeout(retry);
    retry = undefined;
  }
  function remember(key: string, lookup: Lookup) {
    lookups.delete(key);
    lookups.set(key, lookup);
    for (const [oldest] of lookups) {
      if (lookups.size <= 4096) break;
      lookups.delete(oldest);
    }
  }
  function keep(event: RelayEvent) {
    lookupEvents.set(event.id, event);
    for (const [oldest] of lookupEvents) {
      if (lookupEvents.size <= 1024) break;
      lookupEvents.delete(oldest);
    }
  }
  const contentKinds = [9, 40002, 40008];
  /** The viewer's replies under these parents, with their deletions. `#e`
   * also matches root tags, so a busy thread can fill one page: split a full
   * page, and page one parent back in time until its direct reply appears. */
  async function viewerReplies(
    channelId: string,
    parents: readonly string[],
    signal: AbortSignal,
    until?: number,
    pages = 0,
  ): Promise<RelayEvent[]> {
    const rows = await reader.read(
      [
        {
          kinds: contentKinds,
          authors: [viewer],
          "#h": [channelId],
          "#e": [...parents],
          include_aux: true,
          limit: 500,
          ...(until === undefined ? {} : { until }),
        },
      ],
      { signal, priority: "background" },
    );
    const content = rows.filter((event) => contentKinds.includes(event.kind));
    if (content.length < 500) return [...rows];
    if (parents.length > 1) {
      const half = Math.ceil(parents.length / 2);
      return [
        ...(await viewerReplies(channelId, parents.slice(0, half), signal)),
        ...(await viewerReplies(channelId, parents.slice(half), signal)),
      ];
    }
    // `until` is inclusive: stop when a page makes no progress, and after ten
    // pages (5,000 replies under one root) as a cost bound.
    const oldest = Math.min(...content.map((event) => event.created_at));
    if (
      content.some(
        (event) => threadReference(event)?.parentId === parents[0],
      ) ||
      oldest === until ||
      pages >= 9
    )
      return [...rows];
    return [
      ...rows,
      ...(await viewerReplies(channelId, parents, signal, oldest, pages + 1)),
    ];
  }
  let resolving = false;
  async function resolveConversations() {
    if (closed || resolving || !queued.size) return;
    resolving = true;
    try {
      while (!closed && queued.size) {
        const channelId = queued.values().next().value?.channelId;
        if (!channelId) return;
        const chunk = [...queued]
          .filter(([, item]) => item.channelId === channelId)
          .slice(0, 50);
        for (const [key] of chunk) queued.delete(key);
        const parents = chunk.map(([, item]) => item.parentId);
        // A reset or access change during the read makes its answer stale.
        // Re-queue only lookups the reset kept; cleared ones are asked again
        // by the next selector that needs them.
        const generation = epoch;
        const requeue = () => {
          for (const [key, item] of chunk)
            if (lookups.get(key)?.done === false) queued.set(key, item);
        };
        const ids = [
          ...new Set(chunk.flatMap(([, item]) => [...item.ids])),
        ].filter((id) => !structural(id));
        const signal = AbortSignal.any([
          lifetime.signal,
          AbortSignal.timeout(10000),
        ]);
        let fetched: readonly RelayEvent[];
        let replies: readonly RelayEvent[];
        try {
          [fetched, replies] = await Promise.all([
            ids.length
              ? reader.read(
                  [
                    {
                      kinds: contentKinds,
                      ids,
                      include_aux: true,
                      limit: ids.length,
                    },
                  ],
                  { signal, priority: "background" },
                )
              : Promise.resolve([]),
            viewerReplies(channelId, parents, signal),
          ]);
        } catch {
          if (closed) return;
          requeue();
          // A reset retires its requests; that is not a relay failure.
          if (generation !== epoch) continue;
          // Keep the parents pending, so they are not asked twice, and retry
          // the batch with backoff while the relay is unavailable.
          const delay = Math.min(60000, 1000 * 2 ** failures++);
          retry = setTimeout(() => {
            retry = undefined;
            void resolveConversations();
          }, delay);
          return;
        }
        failures = 0;
        if (closed) return;
        if (generation !== epoch) {
          requeue();
          continue;
        }
        if (!allowed(channelId)) continue;
        const removed = new Set<string>();
        for (const event of [...fetched, ...replies])
          if (event.kind === 5 || event.kind === 9005)
            for (const [name, id] of event.tags)
              if (name === "e" && id) removed.add(`${event.pubkey}:${id}`);
        const live = (event: RelayEvent) =>
          contentKind(event) &&
          channelOf(event) === channelId &&
          !removed.has(`${event.pubkey}:${event.id}`) &&
          !(event.pubkey === viewer && retracted.has(event.id));
        for (const event of fetched) if (live(event)) keep(event);
        const mine = new Map(parents.map((id) => [id, [] as RelayEvent[]]));
        for (const event of replies) {
          const parentId = threadReference(event)?.parentId;
          if (event.pubkey === viewer && live(event))
            mine.get(parentId ?? "")?.push(event);
        }
        for (const [id, found] of mine) {
          const parent = structural(id);
          const ownParent = parent?.pubkey === viewer && live(parent);
          const lookup: Lookup = {
            channelId,
            done: true,
            evidence: undefined,
            more: found.length + (ownParent ? 1 : 0) > 1,
          };
          remember(conversationKey(channelId, id), lookup);
          // The viewer's own parent is the witness when there is one: it may
          // come from the structural cache, which a later lookup reuses, so
          // its deletion must stay observable. Replies are always refetched.
          const newest = found.reduce<RelayEvent | undefined>(
            (best, event) =>
              !best || event.created_at > best.created_at ? event : best,
            undefined,
          );
          const chosen = ownParent ? parent : newest;
          if (chosen) witness(lookup, chosen);
        }
        indexed = false;
        publish(new Set([channelId]));
        // Live notifications wait on pending replies; let them re-check.
        for (const listener of [...membershipListeners]) listener();
      }
    } finally {
      resolving = false;
    }
  }
  async function repair(priority: Priority = "foreground") {
    requested = true;
    if (closed) return;
    if (refresh) return refresh;
    repairAgain = false;
    const generation = epoch;
    refresh = (async () => {
      await reads.ensure();
      if (closed || generation !== epoch) return;
      const ids = channels
        .list()
        .channels.filter(
          (channel) => !channel.cached && channel.members?.includes(viewer),
        )
        .map((channel) => channel.id);
      if (!ids.length) return;
      try {
        // The relay caps aggregate explicit #h values at 128 per request.
        // Keep roster scope: an unscoped read also includes unjoined open channels.
        // Each bounded batch owns its queue-inclusive deadline after marker sync;
        // optional profiles must not block the initial user-visible observation.
        for (let offset = 0; offset < ids.length; offset += 128) {
          const signal = AbortSignal.any([
            lifetime.signal,
            AbortSignal.timeout(10000),
          ]);
          const result = await reader.read(
            [
              {
                kinds: [9, 40002, 40008],
                "#h": ids.slice(offset, offset + 128),
                include_aux: true,
                limit: 500,
              },
            ],
            { signal, priority },
          );
          if (closed || generation !== epoch) return;
          if (!accept(result) || closed || generation !== epoch) return;
        }
        freshness = "observed";
        error = undefined;
        publish();
      } catch (cause) {
        if (closed || generation !== epoch) return;
        freshness = "stale";
        error =
          cause instanceof Error ? cause.message : "Unread observation failed";
        publish();
      }
    })().finally(() => {
      refresh = undefined;
      if (!closed && repairAgain) void repair();
    });
    return refresh;
  }
  /** The viewer's deletions end lookup memberships they were evidence for,
   * including ones decided before the deletion, and even when the deletion
   * itself is not retained as counted evidence. */
  function retract(batch: readonly RelayEvent[]) {
    const ids = batch.flatMap((event) =>
      (event.kind === 5 || event.kind === 9005) && event.pubkey === viewer
        ? event.tags.flatMap(([name, id]) => (name === "e" && id ? [id] : []))
        : [],
    );
    if (!ids.length) return;
    const changed = new Set<string>();
    for (const id of ids) {
      retracted.delete(id);
      retracted.add(id);
      witnesses.delete(id);
      // A deleted message must be fetched again, not reused from the cache.
      lookupEvents.delete(id);
      for (const [key, lookup] of lookups) {
        if (lookup.evidence !== id) continue;
        changed.add(lookup.channelId);
        // Other messages of the viewer may still hold the membership: ask
        // again (the retracted message stays excluded) rather than end it.
        if (lookup.more) lookups.delete(key);
        else lookup.evidence = undefined;
      }
    }
    for (const id of retracted) {
      if (retracted.size <= 1024) break;
      retracted.delete(id);
    }
    if (changed.size) publish(changed);
  }
  function accept(batch: readonly RelayEvent[]) {
    if (closed) return false;
    retract(batch);
    const changed = new Set<string>();
    indexed = false;
    const incoming = new Map(batch.map((event) => [event.id, event]));
    const owners = channelOwnership((id) => incoming.get(id) ?? events.get(id));
    for (const event of batch) {
      if (
        ![9, 40002, 40008, 40003, 5, 9005].includes(event.kind) ||
        events.has(event.id)
      )
        continue;
      const channels = owners(event);
      if (!channels || [...channels].some((channel) => !allowed(channel)))
        continue;
      const size = new TextEncoder().encode(JSON.stringify(event)).byteLength;
      if (events.size >= 4096 || bytes + size > 8 * 1024 * 1024) {
        events.clear();
        known.clear();
        bytes = 0;
        error = "Unread observation capacity reached; refresh available";
        freshness = "stale";
        publish();
        return false;
      }
      events.set(event.id, event);
      bytes += size;
      for (const channel of channels) {
        known.add(channel);
        changed.add(channel);
      }
      // The recursively resolved owner set already includes every activity
      // projection affected by a deletion, including delete-of-edit chains.
    }
    if (changed.size) {
      const global = freshness !== "observed";
      freshness = "observed";
      publish(global ? undefined : changed);
    }
    return true;
  }
  function requireMessage(target: ReadTarget, id: string) {
    targetKey(target);
    const event = events.get(id);
    if (
      closed ||
      !allowed(target.channelId) ||
      !event ||
      !contentKind(event) ||
      deleted(event) ||
      channelOf(event) !== target.channelId
    )
      throw new Error("Verified readable message evidence unavailable");
    if (
      (target.kind === "thread" && root(event) !== target.rootId) ||
      (target.kind === "message" && target.messageId !== id)
    )
      throw new Error("Message does not belong to the read target");
    if (
      target.kind === "channel" &&
      threadReference(event) &&
      !event.tags.some(([name, value]) => name === "broadcast" && value === "1")
    )
      throw new Error("A thread reply cannot advance the channel frontier");
    return event;
  }
  function messageSubtree(channelId: string, messageId: string) {
    const selected = requireMessage(
      { kind: "message", channelId, messageId },
      messageId,
    );
    indexEvidence();
    const children = new Map<string, string[]>();
    for (const { event } of byChannel.get(channelId) ?? []) {
      const parent = threadReference(event)?.parentId;
      if (!parent || event.id === selected.id || !root(event)) continue;
      const siblings = children.get(parent) ?? [];
      siblings.push(event.id);
      children.set(parent, siblings);
    }
    const ids = new Set<string>([messageId]);
    const stack = [messageId];
    while (stack.length) {
      const parent = stack.pop();
      if (!parent) break;
      for (const id of children.get(parent) ?? []) {
        if (ids.has(id)) continue;
        ids.add(id);
        stack.push(id);
      }
    }
    return [...ids].flatMap((id) => {
      const event = events.get(id);
      return event ? [event] : [];
    });
  }
  // Queued explicit reads and manual intent share the same access fence.
  function channelIntentValid(channelId: string) {
    const generation = channelReadGenerations.get(channelId) ?? {};
    channelReadGenerations.set(channelId, generation);
    return () =>
      !closed &&
      channelReadGenerations.get(channelId) === generation &&
      allowed(channelId);
  }
  // Capture evidence and time once per click, including every channel in a sweep.
  function channelReadIntent(channelId: string, clickedAt: number) {
    if (closed || !allowed(channelId))
      throw new Error("Read target unavailable");
    indexEvidence();
    const rows = byChannel.get(channelId) ?? [];
    // Explicit catch-up covers everything posted up to this click, including
    // messages this client has not loaded: a cut at the newest retained message
    // lets older activity arrive later and relight the channel. Snapshot it at
    // invocation, not after a queued storage write. Frontiers merge by maximum,
    // so a device clock running ahead also covers arrivals until real time
    // passes it; automatic reading must never use the clock.
    const cut = rows.reduce(
      (newest, { event }) => Math.max(newest, event.created_at),
      clickedAt,
    );
    const keys = new Set([channelId, messageForceKey(channelId)]);
    for (const { event, rootId } of rows) {
      keys.add(`msg:${event.id}`);
      if (rootId) keys.add(`thread:${rootId}`);
      // A retained top-level message establishes its thread's channel even
      // when that thread's replies are outside our bounded evidence window.
      if (!threadReference(event)) keys.add(`thread:${event.id}`);
    }
    const valid = channelIntentValid(channelId);
    return async () => {
      const result =
        rows.length || reads.snapshot().capability === "frontier-sync"
          ? await reads.read(channelId, cut, valid, true, [...keys])
          : await reads.clearLocalUnread(channelId, [...keys], valid);
      if (valid() && forcedMessages.delete(channelId))
        publish(new Set([channelId]));
      return result;
    };
  }
  const capability: UnreadCapability = Object.freeze<UnreadCapability>({
    snapshot,
    attention,
    subscribe(target, listener) {
      snapshot(target);
      const key = keyFor(target),
        set = listeners.get(key) ?? new Set();
      set.add(listener);
      listeners.set(key, set);
      return () => {
        set.delete(listener);
        if (!set.size) listeners.delete(key);
      };
    },
    activity,
    subscribeActivity: addActivityListener,
    sync: reads.snapshot,
    subscribeSync(listener) {
      const stop = reads.subscribe(listener);
      membershipListeners.add(listener);
      return () => {
        stop();
        membershipListeners.delete(listener);
      };
    },
    ensure: () => refresh ?? (requested ? Promise.resolve() : repair()),
    refresh: async () => {
      await reads.refresh("foreground");
      await repair();
    },
    retrySync: async () => {
      await reads.refresh();
      await reads.flush();
    },
    syncedManualUnread: false,
    reading(channelId) {
      if (closed || !allowed(channelId) || handles.size >= 64)
        throw new Error("Reading handle unavailable");
      let active = true;
      const generation = epoch;
      const manualRevision = reads.revision();
      const observed = new Set<string>();
      const dispose = () => {
        active = false;
        handles.delete(dispose);
        views.delete(dispose);
      };
      const valid = () =>
        active &&
        !closed &&
        generation === epoch &&
        allowed(channelId) &&
        (reads.localUnread(channelId) ?? 0) <= manualRevision;
      handles.add(dispose);
      return Object.freeze({
        dispose,
        view(ids: readonly string[], visible: () => boolean) {
          if (!valid() || ids.length > 128) return;
          const verified = ids.filter((id) => {
            try {
              requireMessage({ kind: "message", channelId, messageId: id }, id);
              return true;
            } catch {
              return false;
            }
          });
          views.set(dispose, {
            ids: new Set(verified),
            visible: () => valid() && visible(),
          });
        },
        async catchUp(id: string, rootId?: string) {
          if (!valid()) return;
          const target = rootId
            ? { kind: "thread" as const, channelId, rootId }
            : { kind: "channel" as const, channelId };
          const event = requireMessage(target, id);
          const key = rootId
            ? `thread-activity:${rootId}`
            : `activity:${channelId}`;
          // A historical window is not the live bottom. Check retained evidence
          // at invocation, not after a later arrival queues behind this intent.
          indexEvidence();
          const rows = byChannel.get(channelId) ?? [];
          const newer = rows.some(
            (entry) =>
              entry.event.created_at > event.created_at &&
              (rootId
                ? entry.rootId === rootId
                : !threadReference(entry.event) ||
                  entry.event.tags.some(
                    ([name, value]) => name === "broadcast" && value === "1",
                  )),
          );
          if (newer) return;
          // Replies can be newer than the last top-level row. Quiet that already
          // retained activity too, without acknowledging the replies themselves.
          const cut = rootId
            ? event.created_at
            : rows.reduce(
                (latest, row) => Math.max(latest, row.event.created_at),
                event.created_at,
              );
          if ((reads.state().frontiers[key] ?? -1) >= cut) return;
          await reads.read(
            key,
            cut,
            () =>
              valid() &&
              requireMessage(target, id) === event &&
              (!rootId ||
                (reads.localUnread(`thread:${rootId}`) ?? 0) <= manualRevision),
          );
        },
        async observe(ids: readonly string[]) {
          if (!valid() || ids.length > 128) return;
          for (const id of ids) {
            if (!valid() || observed.has(id)) continue;
            const target = {
              kind: "message" as const,
              channelId,
              messageId: id,
            };
            const event = requireMessage(target, id);
            if (
              (effectiveFrontier(
                reads.state(),
                targetKey(target),
                channelId,
                threadReference(event) ? root(event) : undefined,
              ) ?? -1) >= event.created_at
            ) {
              observed.add(id);
              continue;
            }
            await reads.read(
              targetKey(target),
              event.created_at,
              () => valid() && requireMessage(target, id) === event,
            );
            observed.add(id);
          }
        },
      });
    },
    async markThrough(target, id) {
      const event = requireMessage(target, id),
        generation = epoch;
      return serialize(target.channelId, () =>
        reads.read(
          targetKey(target),
          event.created_at,
          () =>
            !closed &&
            generation === epoch &&
            requireMessage(target, id) === event,
          true,
        ),
      );
    },
    async markMessageUnread(channelId, messageId) {
      const visit = visits.get(channelId) ?? 0;
      const rows = messageSubtree(channelId, messageId);
      const generation = epoch;
      return serialize(channelId, async () => {
        const valid = () =>
          !closed &&
          generation === epoch &&
          (visits.get(channelId) ?? 0) === visit &&
          allowed(channelId) &&
          rows.every((row) => events.get(row.id) === row && !deleted(row));
        if (!valid()) throw new Error("Unread channel visit expired");
        const result = await reads.markLocalUnread(
          messageForceKey(channelId),
          valid,
        );
        // A leave after persistence must not restore a previous visit's overlay.
        if (valid()) {
          const forced = forcedMessages.get(channelId) ?? new Set<string>();
          for (const row of rows) forced.add(row.id);
          forcedMessages.set(channelId, forced);
          publish(new Set([channelId]));
        }
        return result;
      });
    },
    async markMessageRead(channelId, messageId) {
      const visit = visits.get(channelId) ?? 0;
      const rows = messageSubtree(channelId, messageId);
      const generation = epoch;
      return serialize(channelId, async () => {
        const valid = () =>
          !closed &&
          generation === epoch &&
          (visits.get(channelId) ?? 0) === visit &&
          allowed(channelId) &&
          rows.every((row) => events.get(row.id) === row && !deleted(row));
        if (!valid()) throw new Error("Unread channel visit expired");
        const forced = forcedMessages.get(channelId);
        const ids = new Set(rows.map((row) => row.id));
        const remaining = forced && [...forced].some((id) => !ids.has(id));
        const result = await reads.readMessages(
          rows
            .filter((row) => row.pubkey !== viewer)
            .map((row) => ({
              key: `msg:${row.id}`,
              timestamp: row.created_at,
              channelId,
              ...(threadReference(row) && root(row)
                ? { rootId: root(row) }
                : {}),
            })),
          remaining ? undefined : messageForceKey(channelId),
          valid,
        );
        if (valid()) {
          for (const row of rows) forced?.delete(row.id);
          if (!forced?.size) forcedMessages.delete(channelId);
          publish(new Set([channelId]));
        }
        return result;
      });
    },
    leaveChannel(channelId) {
      visits.set(channelId, (visits.get(channelId) ?? 0) + 1);
      if (forcedMessages.delete(channelId)) publish(new Set([channelId]));
      entered.delete(channelId);
    },
    enterChannel(channelId) {
      const visit = visits.get(channelId) ?? 0;
      return serialize(channelId, async () => {
        await reads.ready;
        if (entered.has(channelId)) return;
        const valid = () =>
          !closed &&
          allowed(channelId) &&
          (visits.get(channelId) ?? 0) === visit;
        if (!valid()) throw new Error("Unread channel visit expired");
        // A prior visit's message force is reconciled on open; independent channel intent remains.
        if (reads.localUnread(messageForceKey(channelId)))
          await reads.clearLocalUnread(
            messageForceKey(channelId),
            [messageForceKey(channelId)],
            valid,
          );
        if (valid()) entered.add(channelId);
      });
    },
    async markChannelRead(channelId) {
      const read = channelReadIntent(channelId, Math.floor(Date.now() / 1000));
      return serialize(channelId, read);
    },
    async markAllChannelsRead() {
      if (closed) throw new Error("Read target unavailable");
      // Decide the sweep from the list at invocation; channels granted later wait
      // for the next explicit action, like arrivals after a per-channel cut.
      const clickedAt = Math.floor(Date.now() / 1000);
      const pending = channels
        .list()
        .channels.filter((channel) => allowed(channel.id))
        .filter((channel) => {
          const current = compute({ kind: "channel", channelId: channel.id });
          // The sidebar can be quiet while unopened replies still have receipts.
          // Explicit Mark all must consume retained unread intent, not styling.
          return (
            current.manual !== "none" ||
            (byChannel.get(channel.id) ?? []).some(
              (entry) =>
                isUnread(entry, reads.state(), channel.channelType === "dm") ||
                !!(
                  entry.rootId && reads.localUnread(`thread:${entry.rootId}`)
                ) ||
                (!threadReference(entry.event) &&
                  !!reads.localUnread(`thread:${entry.event.id}`)),
            )
          );
        })
        .map((channel) => ({
          channelId: channel.id,
          read: channelReadIntent(channel.id, clickedAt),
        }));
      const results: ReadMutationResult[] = [];
      let failure: unknown;
      let failed = false;
      let prior = Promise.resolve();
      for (const { channelId, read } of pending) {
        // Reserve each channel's place now, before a newer manual action. Saves
        // still run sequentially; a revoked channel is skipped when its turn arrives.
        const before = prior;
        const write = serialize(channelId, async () => {
          await before;
          if (allowed(channelId)) return read();
        });
        prior = write.then(
          (result) => {
            if (result) results.push(result);
          },
          (error) => {
            if (!failed) failure = error;
            failed = true;
          },
        );
      }
      await prior;
      if (failed) throw failure;
      return results;
    },
    async markUnreadLocal(target) {
      const key = targetKey(target);
      const channelValid = channelIntentValid(target.channelId);
      const valid = () => {
        if (!channelValid()) return false;
        if (target.kind !== "channel")
          requireMessage(
            target,
            target.kind === "thread" ? target.rootId : target.messageId,
          );
        return true;
      };
      if (!valid()) throw new Error("Unread target unavailable");
      return serialize(target.channelId, () =>
        reads.markLocalUnread(key, valid),
      );
    },
    async clearUnreadLocal(target) {
      const key = targetKey(target);
      const channelValid = channelIntentValid(target.channelId);
      const valid = () => {
        if (!channelValid()) return false;
        if (target.kind !== "channel")
          requireMessage(
            target,
            target.kind === "thread" ? target.rootId : target.messageId,
          );
        return true;
      };
      if (!valid()) throw new Error("Unread target unavailable");
      return serialize(target.channelId, () =>
        reads.clearLocalUnread(key, [key], valid),
      );
    },
  });
  return {
    capability,
    // Private session evidence lookup; never seeds timeline windows or grants access.
    // Reference-only auxiliaries inherit every owning channel through the same
    // bounded, fail-closed ancestry used for retention.
    event(id: string) {
      if (closed) return;
      const witnessed = witnesses.get(id);
      if (witnessed)
        return allowed(channelOf(witnessed) ?? "") ? witnessed : undefined;
      const event = events.get(id);
      if (!event) return;
      const owners = channelOwnership((targetId) => events.get(targetId))(
        event,
      );
      return owners && [...owners].every(allowed) ? event : undefined;
    },
    accept,
    purge,
    reconnect() {
      if (requested) void reads.refresh().then(() => repair("background"));
    },
    stale() {
      epoch++;
      channelReadGenerations.clear();
      freshness = "stale";
      reads.stale();
      publish();
    },
    clear() {
      epoch++;
      channelReadGenerations.clear();
      resetLookups();
      repairAgain = false;
      indexed = false;
      events.clear();
      known.clear();
      forcedMessages.clear();
      entered.clear();
      bytes = 0;
      freshness = "unknown";
      error = undefined;
      publish();
    },
    dispose() {
      closed = true;
      epoch++;
      channelReadGenerations.clear();
      lifetime.abort();
      resetLookups();
      membershipListeners.clear();
      for (const stop of [...handles]) stop();
      stopRead();
      stopChannels();
      listeners.clear();
      snapshots.clear();
      dirty.clear();
      activityListeners.clear();
      activitySnapshots.clear();
      activityDirty.clear();
      events.clear();
      forcedMessages.clear();
      entered.clear();
      reads.dispose();
    },
  };
}
