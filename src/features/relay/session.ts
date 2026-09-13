// FOUNDATION: One relay session owns reads, local intent, delivery and shared views.
import {
  createRelayReader,
  type ReadOptions,
  type RelayReader,
} from "./reader";
import { createPresenceDirectory } from "../presence/directory";
import {
  createPresencePublisher,
  browserPresencePublisherLock,
  type PresencePublisherLock,
} from "../presence/publisher";
import type { PresenceActivity } from "../presence/activity";
import { createAgentActivity } from "../agents/activity";
import { OBSERVER_KIND } from "../agents/observer";
import { createAgentLibrary } from "../agents/library";
import { createIdentityArchives } from "./identity-archives";
import {
  createReadState,
  browserReadPublisherLock,
  type ReadPublisherLock,
} from "./read-state";
import {
  browserReadStateStorage,
  type ReadStateStorage,
} from "./read-state-storage";
import { createUnread } from "./unread";
import type { IncomingListener, IncomingMessage } from "./incoming";
import { objectBody } from "./body";
import { readSidebarPreferences } from "./sidebar-preferences";
import { createSidebarPreferencesStore } from "./sidebar-preferences-store";
import { createEmojiDirectory } from "./emoji-directory";
import { createProfileDirectory } from "./profile-directory";
import { createChannelStore, type ChannelStoreOptions } from "./store";
import type { ReadTransport } from "./transport";
import type { LiveSnapshot, LiveSubscription } from "./live";
import {
  hasTag,
  type ReadFilter,
  type RelayEvent,
  type EventData,
} from "./events";
import { eventVisibility } from "./event-access";
import { ReadError, readErrorKind } from "./errors";
import {
  PublishRejected,
  browserOutboxStorage,
  createOutbox,
  type OutboxStorage,
} from "./outbox";
import { createMessages } from "./messages";
import { createThreadView } from "./threads";
import { ByteLru } from "./budget";
import { createRelayProfiler } from "./profiling";
import {
  retainEvents,
  matchesEvent,
  projectEvents,
  type VisibleEvent,
} from "./projection";

export type EventViewSnapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  events: readonly VisibleEvent[];
  error?: string | undefined;
}>;
/** Compose once per relay/viewer. Plugins get one interface; the host owns disposal. */
export function createRelaySession(
  transport: ReadTransport | null,
  options: ChannelStoreOptions & {
    outboxStorage?: OutboxStorage;
    readStateStorage?: ReadStateStorage;
    readPublisherLock?: ReadPublisherLock;
    deliveryTimeoutMs?: number;
    presenceActivity?: PresenceActivity;
    presencePublisherLock?: PresencePublisherLock;
  } = {},
) {
  let closed = false;
  const lifetime = new AbortController();
  const profiling =
    options.profiling ?? transport?.profiling ?? createRelayProfiler();
  const requests = createRelayReader(transport, { profiling });
  let traffic: LiveSubscription | undefined;
  const presenceSupported =
    transport?.presence === true && !!transport.subscribe;
  const presence = createPresenceDirectory({
    reader: requests.reader,
    relayAuthor: transport?.relayAuthor ?? "",
    supported: presenceSupported,
    updateInterests: (authors) => traffic?.presence?.update(authors),
    notify: (listener) => notify(listener),
  });
  const presencePublisher =
    options.presenceActivity && transport && presenceSupported
      ? createPresencePublisher({
          activity: options.presenceActivity,
          publish: (status, signal) => {
            if (!traffic?.presence)
              return Promise.reject(
                new Error("Presence publication unsupported"),
              );
            return traffic.presence.publish(status, signal);
          },
          lock:
            options.presencePublisherLock ??
            browserPresencePublisherLock(
              `${transport.scope ?? transport.relayAuthor}:${transport.viewer}`,
            ),
        })
      : undefined;
  const presenceActivity = () =>
    presence.visibility(options.presenceActivity?.snapshot().visible ?? true);
  const stopPresenceActivity =
    options.presenceActivity?.subscribe(presenceActivity);
  presenceActivity();
  let revision = 0;
  let accessEpoch = 0;
  let cacheClearEpoch = 0;
  // Access changes update every owned snapshot before invoking subscribers.
  // A subscriber of one projection may synchronously read any other projection.
  let revoking = 0;
  const notifications = new Set<() => void>();
  const notify = (listener: () => void) => {
    if (revoking) notifications.add(listener);
    else listener();
  };
  let canAccess: (id: string) => boolean = () => true;
  const recent = new ByteLru<{ event: RelayEvent; revision: number }>(
    4096,
    8 * 1024 * 1024,
  );
  const observations = new Set<(events: readonly RelayEvent[]) => void>();
  const incomingListeners = new Set<IncomingListener>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const pendingConfirmation = new Set<string>();
  const refreshers = new Set<() => Promise<void>>();
  const views = new Map<() => void, (clear?: boolean) => void>();
  const threads = new Set<ReturnType<typeof createThreadView>>();
  const writer = transport?.writer;
  const writes =
    transport && writer
      ? createOutbox(
          transport.viewer,
          {
            ...writer,
            async sign(template, signal) {
              validateMentionEvent(template);
              return writer.sign(template, signal);
            },
          },
          options.outboxStorage ??
            browserOutboxStorage(
              `${transport.scope ?? transport.relayAuthor}:${transport.viewer}`,
            ),
          {
            ...(options.deliveryTimeoutMs
              ? { timeoutMs: options.deliveryTimeoutMs }
              : {}),
            profiling,
            notifyListener: notify,
            onAccepted: (event) => confirm(event),
            preparePublish: prepareMentionPublication,
          },
        )
      : undefined;
  const rawLocal = () => writes?.local.snapshot() ?? [];
  function retainedThreadEvent(id: string) {
    for (const thread of threads) {
      if (!canAccess(thread.channelId)) continue;
      const event = thread.event(id);
      if (event) return event;
    }
  }
  function visibility(events: readonly EventData[] = []) {
    const evidence = new Map(
      [...rawLocal().map((item) => item.event), ...events].map((event) => [
        event.id,
        event,
      ]),
    );
    return eventVisibility(
      canAccess,
      // Retained thread targets survive shared-cache eviction. They are evidence,
      // not an access grant: eventVisibility still checks every referenced target.
      (id) =>
        evidence.get(id) ??
        recent.peek(id)?.event ??
        retainedThreadEvent(id) ??
        unread.event(id),
    );
  }
  const local = () => {
    const visible = visibility();
    return rawLocal().filter((item) => visible(item.event));
  };
  const localViews = writes
    ? { snapshot: local, subscribe: writes.local.subscribe }
    : undefined;
  function revokeAccess(commit: () => void) {
    revoking++;
    try {
      accessEpoch++;
      // Filters cannot tell us ownership of broad/ID/reference reads. Infrequent
      // authoritative access loss cancels them all, not merely explicit #h reads.
      requests.invalidate();
      const visible = visibility();
      const revoked = recent
        .entries()
        .flatMap(([id, { event }]) =>
          event.kind === 0 || !visible(event) ? [id] : [],
        );
      // Purge before notifying: callbacks must not be able to reseed denied data.
      for (const id of revoked) recent.delete(id);
      channels.purgeAccess((events) => events.filter(visibility(events)));
      writes?.purgeConfirmed((event) => event.kind !== 0 && visible(event));
      presence.clear();
      profiles.clear();
      emoji.clear();
      agentLibrary.clear();
      activity.clear();
      archives.clear();
      for (const purge of views.values()) purge();
      commit();
      unread.purge();
    } finally {
      if (--revoking === 0) {
        const pending = [...notifications];
        notifications.clear();
        for (const listener of pending) notify(listener);
      }
    }
  }
  async function readVerified(
    filters: readonly ReadFilter[],
    settings?: ReadOptions,
    channelTraffic = true,
  ) {
    const epoch = accessEpoch;
    let events: readonly RelayEvent[];
    try {
      events = await requests.reader.read(filters, settings);
    } catch (error) {
      // A single explicit channel has an unambiguous denial owner. A failed
      // broad/multi-channel read is not evidence that every channel was revoked.
      const ids = new Set(filters.flatMap((filter) => filter["#h"] ?? []));
      const [id] = ids;
      if (
        channelTraffic &&
        !closed &&
        epoch === accessEpoch &&
        readErrorKind(error) === "denied" &&
        ids.size === 1 &&
        id !== undefined &&
        filters.every((filter) => filter["#h"]?.length)
      )
        channels.denyChannel(id, error);
      throw error;
    }
    if (closed || epoch !== accessEpoch)
      throw new DOMException("Stale relay read", "AbortError");
    const visible = accept(events, channelTraffic);
    // Discovery must see signed grants/removals even when their channel is
    // currently denied; only the store interprets roster completeness.
    return channelTraffic
      ? visible
      : events.filter(
          (event) =>
            [39000, 39002].includes(event.kind) || visible.includes(event),
        );
  }
  const verified: RelayReader = { read: readVerified };
  function accept(
    events: readonly RelayEvent[],
    channelTraffic = true,
  ): readonly RelayEvent[] {
    if (closed) return [];
    // Authority precedes every projection, even in a batch containing both a
    // membership removal and message content. Store reads apply discovery at
    // their own completeness boundary instead.
    if (
      channelTraffic &&
      events.some((event) => [39000, 39002].includes(event.kind))
    )
      channels.acceptDiscovery(events);
    const visible = events
      .filter((event) => event.kind !== OBSERVER_KIND)
      .filter(visibility(events));
    const epoch = accessEpoch;
    profiling.measure(
      "events.reconcile",
      events[0]?.id ?? "empty",
      () => {
        for (const event of visible)
          recent.set(event.id, { event, revision: ++revision });
        reads.accept(visible);
        unread.accept(visible);
        writes?.observe(visible);
        if (epoch !== accessEpoch) return;
        profiles.accept(visible);
        if (epoch !== accessEpoch) return;
        emoji.accept(visible);
        if (epoch !== accessEpoch) return;
        if (channelTraffic) channels.accept(visible);
        for (const listener of observations) {
          if (closed || epoch !== accessEpoch) return;
          listener(visible);
        }
      },
      visible.length,
    );
    return visible;
  }
  function confirm(event: RelayEvent, attempt = 0) {
    if (closed || (attempt === 0 && pendingConfirmation.has(event.id))) return;
    pendingConfirmation.add(event.id);
    void verified
      .read([{ ids: [event.id], limit: 1 }], {
        priority: attempt === 0 ? "foreground" : "background",
      })
      .catch(() => [])
      .then(() => {
        if (closed) return;
        const operation = writes?.outbox
          .snapshot()
          .find((item) => item.event.id === event.id);
        if (!operation || operation.delivery === "seen" || attempt >= 4) {
          pendingConfirmation.delete(event.id);
          return;
        }
        const timer = setTimeout(() => {
          timers.delete(timer);
          confirm(event, attempt + 1);
        }, [500, 1500, 4000, 10000][attempt]);
        timers.add(timer);
      });
  }
  const profiles = createProfileDirectory(verified, localViews, notify);
  const emoji = createEmojiDirectory(verified, notify);
  const agentLibrary = createAgentLibrary(transport?.readAgentLibrary, notify);
  const activity = createAgentActivity(
    !!transport?.agentActivity && !!transport.subscribe,
    (generation) => traffic?.observe?.(generation),
    (channel) => canAccess(channel),
    notify,
  );
  const archives = createIdentityArchives(
    requests.reader,
    transport?.archiveAuthority,
    notify,
  );
  const channels = createChannelStore(
    transport
      ? {
          read: (filters, settings) => readVerified(filters, settings, false),
          viewer: transport.viewer,
          relayAuthor: transport.relayAuthor,
          media: (url) => transport.media(url),
          revokeAccess,
          visible: (events) => events.filter(visibility(events)),
          restored: (events) => unread.accept(events),
          demand: (channelId) => demandChannel(channelId),
          rosterChanged: () => publishLive(),
        }
      : null,
    profiles,
    {
      ...options,
      profiling,
      notifyListener: notify,
      ...(localViews ? { local: localViews } : {}),
    },
  );
  canAccess = channels.canAccess;
  const readScope = `${transport?.scope ?? transport?.relayAuthor ?? "offline"}:${transport?.viewer ?? ""}`;
  const reads = createReadState({
    viewer: transport?.viewer ?? "",
    reader: requests.reader,
    host: transport?.readState,
    storage:
      options.readStateStorage ??
      browserReadStateStorage(readScope, transport?.viewer ?? ""),
    lock: options.readPublisherLock ?? browserReadPublisherLock(readScope),
    notify,
    broadcastName: transport?.readState
      ? `buzz-read-state:${readScope}`
      : undefined,
  });
  const unread = createUnread({
    reads,
    channels: channels.queries,
    // Repair owns evidence only, not timeline/history ingestion. The shared
    // scheduler and verified transport stay shared; unread fences access epochs.
    reader: requests.reader,
    viewer: transport?.viewer ?? "",
    notify,
  });
  const liveListeners = new Set<() => void>();
  let liveSnapshot: LiveSnapshot = Object.freeze({
    status: transport?.subscribe ? "connecting" : "unavailable",
    routes: Object.freeze([]),
  });
  type Catchup = {
    generation: number;
    state: "pending" | "verified" | "deferred" | "error";
    error?: string | undefined;
    retryAt?: number;
  };
  const catchups = new Map<string, Catchup>();
  let liveGeneration = 0;
  let liveView = Object.freeze({
    ...liveSnapshot,
    roster: channels.roster(),
    heads: Object.freeze(
      [] as {
        channelId: string;
        state: "pending" | "verified" | "deferred" | "error";
        error?: string;
      }[],
    ),
  });
  const publishLive = () => {
    if (closed) return;
    liveView = Object.freeze({
      ...liveSnapshot,
      roster: channels.roster(),
      heads: Object.freeze(
        [...catchups].map(([channelId, { state, error }]) =>
          Object.freeze({ channelId, state, ...(error ? { error } : {}) }),
        ),
      ),
    });
    for (const listener of liveListeners) notify(listener);
  };
  const live = Object.freeze({
    snapshot: () => liveView,
    subscribe(listener: () => void) {
      liveListeners.add(listener);
      return () => {
        liveListeners.delete(listener);
      };
    },
    retry() {
      channels.retryList();
      for (const id of channels.demandedChannels()) demandChannel(id);
      traffic?.retry();
    },
  });
  function validateMentions(channelId: string, pubkeys: readonly string[]) {
    if (!pubkeys.length) return;
    const channel = channels.queries
      .list()
      .channels.find((item) => item.id === channelId);
    if (
      closed ||
      !canAccess(channelId) ||
      !channel?.members ||
      channel.archived ||
      (transport?.subscribe && liveSnapshot.status !== "connected")
    )
      throw new Error("Refresh channel membership before mentioning anyone");
    if (pubkeys.some((key) => !channel.members?.includes(key)))
      throw new Error(
        "A selected recipient is no longer a channel member; remove them or refresh membership",
      );
  }
  function validateMentionEvent(event: Pick<EventData, "kind" | "tags">) {
    if (event.kind !== 9) return;
    const recipients = event.tags.filter(([name]) => name === "p");
    if (!recipients.length) return;
    if (
      recipients.length > 32 ||
      recipients.some(
        (tag) => tag.length !== 2 || !/^[0-9a-f]{64}$/.test(tag[1] ?? ""),
      )
    )
      throw new Error("Invalid mention recipients");
    const destinations = event.tags.filter(([name]) => name === "h");
    if (destinations.length !== 1 || !destinations[0]?.[1])
      throw new Error("A channel is required");
    validateMentions(
      destinations[0][1],
      recipients.map((tag) => tag[1] ?? ""),
    );
  }
  async function prepareMentionPublication(
    event: RelayEvent,
    signal: AbortSignal,
  ) {
    if (event.kind !== 9 || !event.tags.some(([name]) => name === "p")) return;
    // A stream may have missed membership changes. Neither AUTH nor a cached
    // roster proves freshness; each attempt prepares outside the dispatch phase.
    const generation = liveGeneration;
    const epoch = accessEpoch;
    const cleared = cacheClearEpoch;
    try {
      await preflightMentions(event, signal);
    } catch (error) {
      throw new PublishRejected(
        error instanceof Error
          ? error.message
          : "Mention rejected before dispatch",
      );
    }
    return () => {
      if (
        closed ||
        generation !== liveGeneration ||
        epoch !== accessEpoch ||
        cleared !== cacheClearEpoch
      )
        throw new PublishRejected(
          "Channel membership changed during mention verification; retry",
        );
      try {
        validateMentionEvent(event);
      } catch (error) {
        throw new PublishRejected(
          error instanceof Error
            ? error.message
            : "Mention rejected before dispatch",
        );
      }
    };
  }
  async function preflightMentions(event: EventData, signal?: AbortSignal) {
    validateMentionEvent(event);
    if (event.kind !== 9 || !event.tags.some(([name]) => name === "p")) return;
    if (!transport) throw new Error("Relay is unavailable");
    const channelId = event.tags.find(([name]) => name === "h")?.[1];
    if (!channelId) throw new Error("A channel is required");
    const epoch = accessEpoch;
    const generation = liveGeneration;
    const cleared = cacheClearEpoch;
    const events = await requests.reader.read(
      [
        {
          kinds: [39002],
          authors: [transport.relayAuthor],
          "#d": [channelId],
          limit: 1,
        },
      ],
      { ...(signal ? { signal } : {}), priority: "foreground", fresh: true },
    );
    signal?.throwIfAborted();
    if (
      closed ||
      epoch !== accessEpoch ||
      generation !== liveGeneration ||
      cleared !== cacheClearEpoch
    )
      throw new Error(
        "Channel membership changed during mention verification; retry",
      );
    // Transport verifies signatures. Require positive evidence at this exact
    // authority/coordinate; an empty or failed read is unknown, never permission.
    const roster = events[0];
    const coordinates = roster?.tags.filter(([name]) => name === "d");
    if (
      events.length !== 1 ||
      !roster ||
      roster.kind !== 39002 ||
      roster.pubkey !== transport.relayAuthor ||
      !hasTag(roster, "d", channelId) ||
      coordinates?.length !== 1 ||
      coordinates[0]?.length !== 2
    )
      throw new Error(
        "Could not verify current channel membership; refresh and retry",
      );
    accept([roster]);
    validateMentionEvent(event); // A newer live removal beats an older read result.
    if (
      !hasTag(roster, "p", transport.viewer) ||
      event.tags.some(
        ([name, key]) => name === "p" && !hasTag(roster, "p", key ?? ""),
      )
    )
      throw new Error(
        "A selected recipient is no longer a channel member; remove them or refresh membership",
      );
  }
  const sidebarPreferences = createSidebarPreferencesStore(
    async (signal?: AbortSignal) => {
      const decode = transport?.decodeSidebarPreferences;
      if (closed || !transport || !decode)
        throw new Error(
          "Saved sidebar preferences are unavailable in this host",
        );
      const combined = AbortSignal.any([
        lifetime.signal,
        AbortSignal.timeout(10_000),
        ...(signal ? [signal] : []),
      ]);
      return readSidebarPreferences(
        {
          read: async (filters, settings) => {
            const epoch = accessEpoch;
            const cleared = cacheClearEpoch;
            try {
              return await verified.read(filters, settings);
            } catch (error) {
              if (
                readErrorKind(error) !== "cancelled" ||
                combined.aborted ||
                epoch === accessEpoch ||
                cleared !== cacheClearEpoch
              )
                throw error;
              // Initial roster authority can cancel this account-owned read.
              // Retry once under current access, sharing the original deadline.
              return verified.read(filters, settings);
            }
          },
        },
        transport.viewer,
        decode,
        combined,
      );
    },
    !!transport?.decodeSidebarPreferences,
    notify,
  );
  const session = Object.freeze({
    /** Verified new live-route messages, after reconciliation. Never history or local intent. */
    subscribeIncoming(listener: IncomingListener) {
      if (closed) return () => {};
      incomingListeners.add(listener);
      return () => {
        incomingListeners.delete(listener);
      };
    },
    unread: unread.capability,
    presence: presence.queries,
    sidebarPreferences: sidebarPreferences.queries,
    live,
    profiling,
    messages: createMessages(
      writes?.outbox,
      transport?.viewer,
      (id) =>
        local().find((item) => item.event.id === id)?.event ??
        recent.peek(id)?.event,
      emoji.tags,
      validateMentions,
    ),
    /** An owned bounded thread reader. Dispose on close; the session retains access/lifetime authority. */
    thread(
      channelId: string,
      messageId: string,
      options?: { exact?: boolean },
    ) {
      if (closed || views.size >= 64)
        throw new Error("Relay view capacity unavailable");
      if (!/^[0-9a-f]{64}$/.test(messageId))
        throw new Error("Thread needs a valid message ID");
      const thread = createThreadView({
        channelId,
        messageId,
        relayAuthor: transport?.relayAuthor ?? "",
        reader: options?.exact
          ? {
              async read(filters, settings) {
                const epoch = accessEpoch;
                let events: readonly RelayEvent[];
                try {
                  events = await requests.reader.read(filters, settings);
                } catch (error) {
                  if (
                    !closed &&
                    epoch === accessEpoch &&
                    readErrorKind(error) === "denied"
                  )
                    channels.denyChannel(channelId, error);
                  throw error;
                }
                if (closed || epoch !== accessEpoch)
                  throw new DOMException("Stale thread target", "AbortError");
                settings?.signal?.throwIfAborted();
                // A capped raw target/overlay read cannot establish a safe fold.
                if (
                  !filters.some((filter) => filter.depth_limit) &&
                  events.length >= 500
                )
                  throw new Error(
                    "Selected message exceeded its evidence limit",
                  );
                // The thread owner admits the complete target fold atomically.
                return events;
              },
            }
          : verified,
        exact: options?.exact ?? false,
        admit: options?.exact ? (events) => accept(events, false) : undefined,
        seed: recent.peek(messageId)?.event,
        local: localViews,
        canAccess: () => !closed && canAccess(channelId),
        visible: (events) => events.filter(visibility(events)),
        notify,
      });
      threads.add(thread);
      if (options?.exact)
        thread.receive(recent.entries().map(([, item]) => item.event));
      observations.add(thread.receive);
      const unsubscribe = localViews?.subscribe(thread.changed);
      const dispose = () => {
        thread.view.dispose();
        unsubscribe?.();
        observations.delete(thread.receive);
        threads.delete(thread);
        views.delete(dispose);
      };
      views.set(dispose, thread.purge);
      return { ...thread.view, dispose };
    },
    channels: channels.queries,
    profiles: profiles.queries,
    emoji: emoji.queries,
    agentLibrary: agentLibrary.queries,
    agentActivity: activity.queries,
    archives: archives.queries,
    media: (url: string) => transport?.media(url),
    /** A plugin may request writes from this same interface when the host supports them. */
    outbox: writes?.outbox,
    async read(filters: readonly ReadFilter[], settings?: ReadOptions) {
      const began = revision;
      const epoch = accessEpoch;
      const result = await verified.read(filters, settings);
      if (closed || epoch !== accessEpoch)
        throw new DOMException("Stale relay read", "AbortError");
      const merged = new Map(result.map((event) => [event.id, event]));
      for (const [id, observation] of recent.entries()) {
        if (
          observation.revision > began &&
          filters.some((filter) => matchesEvent(observation.event, filter))
        )
          merged.set(id, observation.event);
      }
      const events = [...merged.values()];
      return projectEvents(events.filter(visibility(events)), local(), filters);
    },
    /** An owned retained event view, not a replacement query snapshot. Limits bound
     * requests, not retained results. Ranked search/feed filters require read().
     * Subscribe, refresh and dispose with the plugin's scope. */
    observe(input: readonly ReadFilter[]) {
      if (
        input.some(
          (filter) =>
            filter.search !== undefined || filter.feed_types !== undefined,
        )
      )
        throw new Error(
          "Observed views do not support ranked search/feed filters; use session.read() instead",
        );
      if (closed || views.size >= 64)
        throw new Error("Relay view capacity unavailable");
      const filters: readonly ReadFilter[] = JSON.parse(JSON.stringify(input));
      let remote: readonly RelayEvent[] = retainEvents(
        recent.entries().flatMap(([, { event }]) => {
          return filters.some((filter) => matchesEvent(event, filter))
            ? [event]
            : [];
        }),
      );
      remote = remote.filter(visibility(remote));
      let snapshot: EventViewSnapshot = Object.freeze({
        status: "idle",
        events: projectEvents(remote, local(), filters),
      });
      let controller: AbortController | undefined;
      let disposed = false;
      const listeners = new Set<() => void>();
      const update = (patch: Partial<EventViewSnapshot> = {}) => {
        if (disposed) return;
        remote = remote.filter(visibility(remote));
        const events = projectEvents(remote, local(), filters, snapshot.events);
        const next = { ...snapshot, ...patch, events };
        if (
          next.events === snapshot.events &&
          next.status === snapshot.status &&
          next.error === snapshot.error
        )
          return;
        snapshot = Object.freeze(next);
        for (const listener of listeners) notify(listener);
      };
      const receive = (incoming: readonly RelayEvent[]) => {
        const matching = incoming.filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        );
        if (!matching.length) {
          update();
          return;
        }
        const merged = new Map(remote.map((event) => [event.id, event]));
        for (const event of matching) merged.set(event.id, event);
        // Each owned view retains its own bounded evidence, independently of shared-cache eviction.
        remote = retainEvents([...merged.values()]);
        update();
      };
      observations.add(receive);
      const unsubscribe = writes?.local.subscribe(() => update());
      const dispose = () => {
        disposed = true;
        controller?.abort();
        unsubscribe?.();
        observations.delete(receive);
        listeners.clear();
        views.delete(dispose);
        refreshers.delete(view.refresh);
      };
      views.set(dispose, (clear = false) => {
        controller?.abort();
        controller = undefined;
        const visible = visibility(remote);
        remote = clear
          ? []
          : remote.filter((event) => event.kind !== 0 && visible(event));
        update({ status: "idle", error: undefined });
      });
      const view = {
        snapshot: () => snapshot,
        subscribe(listener: () => void) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        async refresh() {
          if (disposed || closed || controller) return;
          const owned = new AbortController();
          controller = owned;
          update({ status: "loading", error: undefined });
          try {
            const events = await verified.read(filters, {
              signal: owned.signal,
            });
            if (disposed || owned.signal.aborted) return;
            remote = retainEvents([...events, ...remote]);
            update({ status: "ready" });
          } catch (error) {
            if (!disposed && !owned.signal.aborted)
              update({ status: "error", error: String(error) });
          } finally {
            if (controller === owned) controller = undefined;
          }
        },
        dispose,
      };
      refreshers.add(view.refresh);
      return view;
    },
  });
  let rosterTimer: ReturnType<typeof setTimeout> | undefined;
  function refreshRoster() {
    if (closed || rosterTimer) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      rosterTimer = undefined;
      if (!closed) channels.queries.refreshList?.();
    }, 0);
    rosterTimer = timer;
    timers.add(timer);
  }
  const updateInterests = () => {
    if (closed) return;
    const ids = channels.queries.list().channels.map((channel) => channel.id);
    const wanted = new Set(ids);
    for (const id of catchups.keys()) if (!wanted.has(id)) catchups.delete(id);
    try {
      traffic?.prioritize?.(channels.demandedChannels());
      traffic?.update(ids);
    } catch (error) {
      liveSnapshot = { ...liveSnapshot, status: "error", error: String(error) };
    }
    publishLive();
  };
  let refreshedGeneration = -1;
  const catchupRunning = new Map<string, Catchup>();
  const catchupQueue = new Set<string>();
  const isChannelHead = (filters: readonly ReadFilter[], channelId: string) =>
    filters.some(
      (filter) =>
        filter["#h"]?.includes(channelId) &&
        // Unread evidence also contains this channel, but is not a timeline head.
        filter.top_level === true &&
        filter.until === undefined &&
        filter.depth_limit === undefined &&
        filter.kinds?.includes(9),
    );
  function demandChannel(channelId: string): boolean {
    if (closed) return false;
    traffic?.prioritize?.(channels.demandedChannels());
    const job = catchups.get(channelId);
    if (!job || job.generation !== liveGeneration || job.state === "verified")
      return false;
    if (job.retryAt && performance.now() < job.retryAt) {
      channels.catchUpFailed(channelId, job.error);
      return true;
    }
    if (job.state !== "pending") {
      job.state = "pending";
      job.error = undefined;
      catchupQueue.add(channelId);
      publishLive();
    }
    if (catchupRunning.has(channelId))
      requests.promote((filters) => isChannelHead(filters, channelId));
    queueMicrotask(() => void catchUpNext());
    return true;
  }
  function catchUpNext() {
    if (closed) return;
    // One retained catch-up at a time. Only the selected channel can use a
    // second slot; background recovery never drains the roster in parallel.
    while (catchupQueue.size && catchupRunning.size < 2) {
      const demanded = channels.demandedChannels();
      const channelId = catchupRunning.size
        ? demanded
            .slice(0, 1)
            .find((id) => catchupQueue.has(id) && !catchupRunning.has(id))
        : (demanded.find((id) => catchupQueue.has(id)) ??
          catchupQueue.values().next().value);
      if (!channelId) return;
      catchupQueue.delete(channelId);
      const job = catchups.get(channelId);
      if (
        !job ||
        job.generation !== liveGeneration ||
        !channels.canAccess(channelId)
      )
        continue;
      catchupRunning.set(channelId, job);
      void catchUpChannel(channelId, job);
    }
  }
  async function catchUpChannel(channelId: string, job: Catchup) {
    const valid = () =>
      !closed &&
      job.generation === liveGeneration &&
      catchups.get(channelId) === job;
    try {
      // A pre-establishment finite read cannot satisfy the handoff obligation.
      requests.invalidate((filters) => isChannelHead(filters, channelId));
      const verified = await channels.catchUp(channelId);
      if (valid()) job.state = verified ? "verified" : "deferred";
    } catch (error) {
      if (!valid()) return;
      job.state = readErrorKind(error) === "cancelled" ? "deferred" : "error";
      job.error = job.state === "error" ? String(error) : undefined;
      if (error instanceof ReadError && error.retryAfterMs !== undefined) {
        job.retryAt = performance.now() + error.retryAfterMs;
        // Keep lightweight obligations, not paced requests inside reader deadlines.
        for (const id of catchupQueue) {
          const queued = catchups.get(id);
          if (queued) {
            queued.state = "error";
            queued.error = job.error;
            queued.retryAt = job.retryAt;
            channels.catchUpFailed(id, error);
          }
        }
        catchupQueue.clear();
      }
    } finally {
      if (catchupRunning.get(channelId) === job)
        catchupRunning.delete(channelId);
      publishLive();
      catchUpNext();
    }
  }
  traffic = transport?.subscribe?.({
    presence: (events) => presence.receive(events),
    presenceState: (state) => presence.route(state),
    observer: (frame, generation) => activity.receive(frame, generation),
    receive(events, provenance) {
      if (closed) return;
      // Ephemeral traffic must never enter generic retention, even from a bad route.
      presence.receive(events.filter((event) => event.kind === 20001));
      events = events.filter((event) => event.kind !== 20001);
      const candidates = new Set(
        provenance?.phase === "live" && provenance.channelId
          ? events
              .filter((event) => {
                const destinations = event.tags.filter(
                  ([name]) => name === "h",
                );
                return (
                  (event.kind === 9 || event.kind === 40002) &&
                  event.pubkey !== transport.viewer &&
                  destinations.length === 1 &&
                  destinations[0]?.[1] === provenance.channelId &&
                  !recent.peek(event.id) &&
                  !unread.event(event.id) &&
                  !rawLocal().some((item) => item.event.id === event.id)
                );
              })
              .map((event) => event.id)
          : [],
      );
      // Signed membership notifications are hints, not roster authority. Schedule
      // before visibility filtering, because a newly granted channel may be denied locally.
      if (
        events.some(
          (event) =>
            [44100, 44101].includes(event.kind) &&
            event.pubkey === transport.relayAuthor &&
            event.tags.some(
              ([name, value]) => name === "p" && value === transport.viewer,
            ),
        )
      )
        refreshRoster();
      const visible = accept(events);
      if (closed || !candidates.size || !provenance?.channelId) return;
      const epoch = accessEpoch;
      const delivered = new Set<string>();
      const incoming: readonly IncomingMessage[] = Object.freeze(
        visible.flatMap((event) => {
          if (!candidates.has(event.id) || delivered.has(event.id)) return [];
          delivered.add(event.id);
          const body =
            event.kind === 40002 ? objectBody(event.content) : undefined;
          const content =
            typeof body?.content === "string" ? body.content : event.content;
          return [
            Object.freeze({
              channelId: provenance.channelId as string,
              messageId: event.id,
              createdAt: event.created_at,
              authorId: event.pubkey,
              previewContent: content.slice(0, 4096),
            }),
          ];
        }),
      );
      if (!incoming.length) return;
      for (const listener of incomingListeners) {
        if (closed || epoch !== accessEpoch) return;
        listener(incoming);
      }
    },
    state(snapshot) {
      if (closed) return;
      presence.connection(snapshot.status === "connected");
      presencePublisher?.connection(snapshot.status === "connected");
      activity.state(snapshot);
      if (
        snapshot.status !== "connected" &&
        liveSnapshot.status === "connected"
      ) {
        liveGeneration++;
        catchups.clear();
        catchupQueue.clear();
        requests.invalidate();
        agentLibrary.clear();
        archives.clear();
        channels.staleHeads();
        unread.stale();
      }
      liveSnapshot = snapshot;
      publishLive();
    },
    established(channelId) {
      if (closed) return;
      if (!channelId) {
        if (refreshedGeneration !== liveGeneration) {
          refreshedGeneration = liveGeneration;
          refreshRoster();
          const timer = setTimeout(() => {
            timers.delete(timer);
            if (!closed) {
              emoji.reconnect();
              unread.reconnect();
              for (const refresh of refreshers) void refresh();
            }
          }, 0);
          timers.add(timer);
        }
        return;
      }
      if (!channels.canAccess(channelId)) return;
      for (const thread of threads)
        if (thread.channelId === channelId) void thread.view.refresh();
      const job = {
        generation: liveGeneration,
        state: "pending" as "pending" | "verified" | "deferred" | "error",
        error: undefined as string | undefined,
      };
      channels.staleHead(channelId);
      catchups.set(channelId, job);
      if (channels.retainedChannels().includes(channelId))
        catchupQueue.add(channelId);
      else job.state = "deferred";
      publishLive();
      queueMicrotask(() => void catchUpNext());
    },
    denied(channelId, reason) {
      if (!closed) channels.denyChannel(channelId, new Error(reason));
    },
  });
  const stopInterests = channels.queries.subscribeList(updateInterests);
  updateInterests();

  return {
    session,
    async clearCache() {
      accessEpoch++;
      cacheClearEpoch++;
      activity.clear();
      sidebarPreferences.clear();
      presence.clear();
      // New windows must not yield to or receive errors from retired owners.
      catchups.clear();
      catchupQueue.clear();
      for (const clear of views.values()) clear(true);
      recent.clear();
      unread.clear();
      requests.invalidate();
      profiles.clear();
      emoji.clear();
      agentLibrary.clear();
      archives.clear();
      await channels.clearCache();
      publishLive();
    },
    dispose() {
      closed = true;
      lifetime.abort();
      stopPresenceActivity?.();
      presencePublisher?.dispose();
      presence.dispose();
      activity.dispose();
      sidebarPreferences.dispose();
      stopInterests();
      traffic?.dispose();
      liveListeners.clear();
      incomingListeners.clear();
      observations.clear();
      for (const timer of timers) clearTimeout(timer);
      for (const dispose of [...views.keys()]) dispose();
      unread.dispose();
      writes?.dispose();
      requests.dispose();
      channels.dispose();
      profiles.dispose();
      emoji.dispose();
      agentLibrary.dispose();
      archives.dispose();
    },
    retainedChannels: channels.retainedChannels,
    diagnostics: () => ({
      ...channels.diagnostics(),
      profiles: profiles.stats(),
      presence: {
        ...presence.diagnostics(),
        publisher: presencePublisher?.diagnostics(),
      },
    }),
  };
}
export type RelaySession = ReturnType<typeof createRelaySession>["session"];
