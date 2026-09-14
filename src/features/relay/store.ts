import { channelRowKind, rowProfileIds, messagePreview } from "./membership";
import type { Outbox } from "./outbox";
import { MessageProjection } from "./message-projection";
import { createRelayProfiler, type RelayProfiler } from "./profiling";
import { ReadError, readErrorKind } from "./errors";
import type {
  ChannelList,
  ChannelMessage,
  ChannelQueries,
  ChannelWindow,
} from "./contracts";
import { DiscoveryState } from "./discovery";
import { foldMessages } from "./fold";
import { eventDto, hasTag, tag, type RelayEvent } from "./events";
import type { RelayReader, Priority } from "./reader";
import type { ProfileDirectory } from "./profile-directory";
import { parseWindow, windowFilter, type WindowCursor } from "./window";
import { ByteLru, byteSize } from "./budget";
import type { HeadPersistence, SavedHead } from "./persistence";
import { createMediaPreparation } from "./media";

type Listener = () => void;
type WindowState = {
  projection: MessageProjection;
  traffic: Map<string, RelayEvent>;
  channelId: string;
  snapshot: ChannelWindow;
  cursor: WindowCursor | null;
  events: readonly RelayEvent[];
  atHead: boolean;
  generation: number;
  controller?: AbortController | undefined;
};
type Head = {
  rows: readonly ChannelMessage[];
  cursor: WindowCursor | null;
  hasMore: boolean;
  events: readonly RelayEvent[];
  savedAt: number;
  cached: boolean;
};
export type ChannelStoreOptions = {
  profiling?: RelayProfiler;
  maxWindows?: number;
  unavailableReason?: string;
  prepared?: boolean;
  persistence?: HeadPersistence;
  maxHeadBytes?: number;
  maxHeads?: number;
  maxHistoryRows?: number;
  maxHistoryBytes?: number;
  now?: () => number;
  local?: Pick<Outbox, "snapshot" | "subscribe">;
  notifyListener?: (listener: () => void) => void;
};
const EMPTY_ROWS: readonly ChannelMessage[] = Object.freeze([]);
/** Relay read cap. A roster read returning fewer than this is complete evidence of the viewer's membership. */
const DISCOVERY_LIMIT = 500;
const UNAVAILABLE: ChannelList = Object.freeze({
  status: "unavailable",
  channels: Object.freeze([]),
});
const describe = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const isAbort = (error: unknown) => readErrorKind(error) === "cancelled";
const FRESH_FOR = 60_000;

/** Session-owned read model. Broad byte-bounded heads are separate from the small history LRU.
 * Preparing a head never mounts a timeline or evicts a subscribed history window. */
export function createChannelStore(
  transport:
    | (RelayReader & {
        viewer: string;
        relayAuthor: string;
        media(url: string): string | undefined;
        revokeAccess(commit: () => void): void;
        visible(events: readonly RelayEvent[]): readonly RelayEvent[];
        /** Reverified, authorized disk evidence, before any restored rows become observable. */
        restored?(events: readonly RelayEvent[]): void;
        /** Returns true when session post-subscribe catch-up owns this demand. */
        demand?(channelId: string): boolean;
        rosterChanged?(): void;
      })
    | null,
  directory: ProfileDirectory,
  options: ChannelStoreOptions = {},
) {
  const {
    maxWindows = 3,
    unavailableReason,
    prepared = false,
    persistence,
    maxHeadBytes = 4 * 1024 * 1024,
    maxHeads = 64,
    maxHistoryRows = 2400,
    maxHistoryBytes = 8 * 1024 * 1024,
    now = Date.now,
    local,
    notifyListener = (listener: () => void) => listener(),
    profiling = createRelayProfiler(),
  } = options;
  if (!Number.isInteger(maxWindows) || maxWindows < 1)
    throw new Error("Invalid window capacity");
  let disposed = false,
    epoch = 0,
    listBusy = false;
  let listAgain = false;
  let listRetryAt = 0;
  type RosterRefresh = Readonly<{
    state: "idle" | "pending" | "verified" | "deferred" | "error";
    error?: string;
  }>;
  let rosterRefresh: RosterRefresh = Object.freeze({ state: "idle" });
  let list: ChannelList = transport
    ? Object.freeze({ status: "idle", channels: Object.freeze([]) })
    : unavailableReason
      ? Object.freeze({ ...UNAVAILABLE, error: unavailableReason })
      : UNAVAILABLE;
  let allowed: Set<string> | undefined;
  let coverage: "partial" | undefined;
  const discovery = transport
    ? new DiscoveryState(transport.viewer, transport.relayAuthor)
    : null;
  const heads = new ByteLru<Head>(maxHeads, maxHeadBytes);
  const windows = new Map<string, WindowState>();
  const tails = new ByteLru<{
    events: readonly RelayEvent[];
    preview?: string | undefined;
  }>(64, 4 * 1024 * 1024);
  let media = createMediaPreparation();
  const controllers = new Set<AbortController>();
  const accessVersions = new Map<string, number>();
  const listListeners = new Set<Listener>();
  const windowListeners = new Map<string, Set<Listener>>();
  let intent: string | undefined;
  let current: string | undefined;
  const mediaIntents: string[] = [];
  let hydration: Promise<void> | undefined;
  let preparing = false;
  const notify = (listeners: Iterable<Listener> | undefined) => {
    for (const listener of listeners ?? []) notifyListener(listener);
  };
  function subscribe(listeners: Set<Listener>, listener: Listener) {
    const callback = () => listener();
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
    };
  }
  function setList(next: ChannelList) {
    const previous = new Map(
      list.channels.map((channel) => [channel.id, channel]),
    );
    const channels = next.channels.map((channel) => {
      const preview =
        messagePreview(windows.get(channel.id)?.snapshot.rows) ??
        tails.peek(channel.id)?.preview ??
        messagePreview(heads.peek(channel.id)?.rows);
      const old = previous.get(channel.id);
      return old &&
        old.name === channel.name &&
        old.preview === preview &&
        old.hidden === channel.hidden &&
        old.channelType === channel.channelType &&
        old.archived === channel.archived &&
        old.members?.length === channel.members?.length &&
        (old.members ?? []).every(
          (id, index) => id === channel.members?.[index],
        ) &&
        old.participants?.length === channel.participants?.length &&
        (old.participants ?? []).every(
          (id, index) => id === channel.participants?.[index],
        )
        ? old
        : Object.freeze({ ...channel, preview });
    });
    const sameChannels =
      channels.length === list.channels.length &&
      channels.every((channel, index) => channel === list.channels[index]);
    if (
      sameChannels &&
      next.status === list.status &&
      next.error === list.error &&
      next.asOf === list.asOf
    )
      return;
    list = Object.freeze({
      ...next,
      channels: sameChannels ? list.channels : Object.freeze(channels),
    });
    notify(listListeners);
  }
  function setWindow(state: WindowState, patch: Partial<ChannelWindow>) {
    let rows = patch.rows ?? state.snapshot.rows;
    if (authorized(state.channelId) && transport) {
      const combined = new Map(
        [...state.events, ...state.traffic.values()].map((event) => [
          event.id,
          event as import("./events").EventData,
        ]),
      );
      const ids = new Set(combined.keys());
      for (const item of local?.snapshot() ?? [])
        if (
          [9, 40002].includes(item.event.kind) &&
          item.event.tags.some(
            (tag) => tag[0] === "h" && tag[1] === state.channelId,
          )
        )
          ids.add(item.event.id);
      const operations = (local?.snapshot() ?? []).filter((item) =>
        item.event.tags.some(
          (tag) =>
            (tag[0] === "h" && tag[1] === state.channelId) ||
            (tag[0] === "e" && ids.has(tag[1] ?? "")),
        ),
      );
      for (const item of operations) {
        if (item.delivery === "failed" && ![9, 40002].includes(item.event.kind))
          continue;
        combined.set(item.event.id, item.event);
      }
      rows = profiling.measure("view.reconcile", state.channelId, () =>
        state.projection.reconcile([...combined.values()], operations),
      );
    }
    const next = { ...state.snapshot, ...patch, rows };
    if (
      Object.entries(next).every(
        ([key, value]) => value === state.snapshot[key as keyof ChannelWindow],
      )
    )
      return;
    const previousPreview = messagePreview(state.snapshot.rows);
    state.snapshot = Object.freeze(next);
    notify(windowListeners.get(state.channelId));
    if (previousPreview !== messagePreview(rows)) setList(list);
  }
  const idleWindows = new Map<string, ChannelWindow>();
  function idleWindow(channelId: string): ChannelWindow {
    let snapshot = idleWindows.get(channelId);
    if (!snapshot) {
      snapshot = Object.freeze({
        channelId,
        status: "idle",
        rows: EMPTY_ROWS,
        hasMore: true,
        loadingOlder: false,
        error: undefined,
      });
      idleWindows.set(channelId, snapshot);
      if (idleWindows.size > 256)
        for (const id of idleWindows.keys()) {
          if (
            !windows.has(id) &&
            !windowListeners.has(id) &&
            id !== channelId
          ) {
            idleWindows.delete(id);
            break;
          }
        }
    }
    return snapshot;
  }
  function evict(state: WindowState) {
    windows.delete(state.channelId);
    state.generation++;
    state.controller?.abort();
    state.events = [];
    state.snapshot = idleWindow(state.channelId);
    notify(windowListeners.get(state.channelId));
  }
  function trim() {
    while (windows.size > maxWindows) {
      const oldest = [...windows.values()].find(
        (state) => !prepared || !windowListeners.get(state.channelId)?.size,
      );
      if (!oldest) break; // Never discard a mounted reader's anchor for speculation.
      evict(oldest);
    }
  }
  function touch(channelId: string): WindowState {
    let state = windows.get(channelId);
    if (state) {
      windows.delete(channelId);
      windows.set(channelId, state);
      return state;
    }
    state = {
      traffic: new Map(
        (tails.peek(channelId)?.events ?? []).map((event) => [event.id, event]),
      ),
      projection: new MessageProjection(
        channelId,
        transport?.relayAuthor ?? "",
        profiling,
      ),
      channelId,
      snapshot: idleWindow(channelId),
      cursor: null,
      events: [],
      atHead: true,
      generation: 0,
    };
    windows.set(channelId, state);
    trim();
    return state;
  }
  const authorized = (id: string) => discovery?.canAccess(id) ?? false;
  const live = (state: WindowState, generation: number) =>
    !disposed &&
    authorized(state.channelId) &&
    windows.get(state.channelId) === state &&
    state.generation === generation;
  function prepareMedia(channelId: string) {
    const previous = mediaIntents.indexOf(channelId);
    if (previous >= 0) mediaIntents.splice(previous, 1);
    mediaIntents.unshift(channelId);
    mediaIntents.length = Math.min(3, mediaIntents.length);
    const urls = mediaIntents.flatMap((id) => {
      const rows = heads.peek(id)?.rows ?? windows.get(id)?.snapshot.rows ?? [];
      const authors = rows.slice(-12).reverse().flatMap(rowProfileIds);
      return authors.flatMap((author) => {
        const picture = directory.queries.snapshot().get(author)?.picture;
        const url = picture && transport?.media(picture);
        return url ? [url] : [];
      });
    });
    media.prepare(urls);
  }
  async function fetchProfiles(rows: readonly ChannelMessage[]) {
    try {
      await directory.ensure(rows.flatMap(rowProfileIds), "background");
      if (!disposed && intent) prepareMedia(intent);
    } catch {
      // Names are optional for channel rendering. Missing profiles remain retryable.
    }
  }
  const patchFromHead = (head: Head): Partial<ChannelWindow> => ({
    status: "ready",
    rows: head.rows,
    hasMore: head.hasMore,
    loadingOlder: false,
    error: undefined,
    freshness: head.cached ? "cached" : "verified",
    historyLimited: false,
  });
  function save(channelId: string, head: Head, previousProfiles?: string) {
    if (
      !persistence ||
      !authorized(channelId) ||
      disposed ||
      heads.peek(channelId) !== head
    )
      return;
    const authors = new Set(head.rows.flatMap(rowProfileIds));
    const profiles = [...authors].flatMap((id) => {
      const event = directory.event(id);
      return event ? [event] : [];
    });
    const signature = profiles.map((event) => event.id).join(":");
    if (signature === previousProfiles) return signature;
    const record: SavedHead = {
      channelId,
      savedAt: head.savedAt,
      events: [...head.events],
      profiles,
    };
    void persistence.write(record).catch(() => {});
    return signature;
  }
  function denyChannel(channelId: string, error: unknown) {
    accessVersions.set(channelId, (accessVersions.get(channelId) ?? 0) + 1);
    discovery?.deny(channelId);
    allowed?.delete(channelId);
    transport?.revokeAccess(() => {
      heads.delete(channelId);
      tails.delete(channelId);
      const state = windows.get(channelId);
      if (state) {
        state.generation++;
        state.controller?.abort();
        state.events = [];
        state.traffic.clear();
        setWindow(state, {
          status: "error",
          rows: EMPTY_ROWS,
          error: describe(error),
          loadingOlder: false,
        });
      }
      // Profiles may be shared by several windows; clearing this bounded private projection
      // is conservative, and prevents denied-channel-only names from surviving visibly.
      directory.clear();
      setList({
        ...list,
        channels: Object.freeze(
          list.channels.filter((channel) => channel.id !== channelId),
        ),
      });
      void persistence?.remove(channelId).catch(() => {});
    });
  }
  async function requestHead(
    channelId: string,
    priority: Priority,
  ): Promise<Head> {
    const generation = epoch;
    const accessVersion = accessVersions.get(channelId) ?? 0;
    const controller = new AbortController();
    controllers.add(controller);
    let head: Head;
    try {
      if (disposed || !transport || !authorized(channelId))
        throw new DOMException("Stale request", "AbortError");
      const events = await transport.read([windowFilter(channelId, null)], {
        signal: controller.signal,
        priority,
      });
      if (
        disposed ||
        generation !== epoch ||
        accessVersion !== (accessVersions.get(channelId) ?? 0) ||
        !authorized(channelId)
      )
        throw new DOMException("Stale request", "AbortError");
      const retained = heads.peek(channelId);
      if (retained?.events === events) return retained;
      const page = parseWindow(channelId, null, transport.relayAuthor, events);
      head = {
        rows: Object.freeze(
          foldMessages(channelId, transport.relayAuthor, page.events),
        ),
        cursor: page.cursor,
        hasMore: page.hasMore,
        events,
        savedAt: now(),
        cached: false,
      };
      if (
        head.rows.length > maxHistoryRows ||
        byteSize(head.rows) > maxHistoryBytes
      )
        throw new Error("Channel head exceeds the read budget");
    } catch (error) {
      if (
        !disposed &&
        generation === epoch &&
        accessVersion === (accessVersions.get(channelId) ?? 0) &&
        readErrorKind(error) === "denied"
      )
        denyChannel(channelId, error);
      throw error;
    } finally {
      controllers.delete(controller);
    }
    heads.set(channelId, head);
    setList(list);
    // Durable message warmth must not wait behind optional name enrichment.
    const savedProfiles =
      generation === epoch ? save(channelId, head) : undefined;
    void fetchProfiles(head.rows).then(() => {
      if (generation === epoch) save(channelId, head, savedProfiles);
    });
    if (intent === channelId) prepareMedia(channelId);
    return head;
  }
  async function loadPage(state: WindowState, cursor: WindowCursor | null) {
    if (!transport) return;
    const generation = state.generation;
    const controller = new AbortController();
    state.controller = controller;
    try {
      if (prepared && !cursor) {
        const head = await requestHead(state.channelId, "foreground");
        if (!live(state, generation)) return;
        state.cursor = head.cursor;
        state.events = head.events;
        state.atHead = true;
        setWindow(state, patchFromHead(head));
        return;
      }
      const events = await transport.read(
        [windowFilter(state.channelId, cursor)],
        { signal: controller.signal },
      );
      if (!live(state, generation)) return;
      const page = parseWindow(
        state.channelId,
        cursor,
        transport.relayAuthor,
        events,
      );
      const combined = new Map(
        (cursor ? state.events : []).map((event) => [event.id, event]),
      );
      for (const event of page.events) combined.set(event.id, event);
      const retained = [...combined.values()];
      const rows = Object.freeze(
        foldMessages(state.channelId, transport.relayAuthor, retained),
      );
      if (
        rows.length > maxHistoryRows ||
        byteSize(retained) > maxHistoryBytes
      ) {
        setWindow(state, {
          loadingOlder: false,
          historyLimited: true,
          error: undefined,
        });
        return;
      }
      state.events = retained;
      state.atHead = !cursor;
      state.cursor = page.cursor;
      setWindow(state, {
        status: "ready",
        rows,
        hasMore: page.hasMore && page.cursor !== null,
        loadingOlder: false,
        error: undefined,
        freshness: "verified",
      });
      void fetchProfiles(rows);
    } catch (error) {
      if (isAbort(error) || !live(state, generation)) return;
      // A denied revalidation must not keep exposing a cached head.
      const denied = readErrorKind(error) === "denied";
      if (denied) {
        denyChannel(state.channelId, error);
        return;
      }
      setWindow(
        state,
        cursor || state.snapshot.rows.length
          ? { loadingOlder: false, error: describe(error), freshness: "cached" }
          : {
              status: "error",
              rows: EMPTY_ROWS,
              loadingOlder: false,
              error: describe(error),
            },
      );
    } finally {
      if (state.controller === controller) state.controller = undefined;
    }
  }
  async function hydrate() {
    if (!persistence || !transport) return;
    const generation = epoch;
    let records: SavedHead[];
    try {
      records = await persistence.read();
    } catch {
      return;
    }
    while (records.length) {
      const priorityIndex = records.findIndex(
        (record) => record.channelId === intent,
      );
      const [record] = records.splice(
        priorityIndex >= 0 ? priorityIndex : 0,
        1,
      );
      if (!record) break;
      const accessVersion = accessVersions.get(record.channelId) ?? 0;
      if (disposed || generation !== epoch) return;
      if (
        !allowed?.has(record.channelId) ||
        heads.peek(record.channelId) ||
        !Number.isFinite(record.savedAt) ||
        record.savedAt > now() ||
        now() - record.savedAt > 86_400_000
      )
        continue;
      try {
        // Verify in channel-sized batches and yield between them; cache parsing never monopolizes startup.
        // Persisted input is untrusted even if an in-memory test object carries nostr-tools'
        // cached verification symbol. Reconstruct only wire fields before verification.
        const verifySaved = (value: unknown) =>
          eventDto(JSON.parse(JSON.stringify(value)));
        const events: RelayEvent[] = [];
        for (let index = 0; index < record.events.length; index += 8) {
          events.push(
            ...record.events.slice(index, index + 8).map(verifySaved),
          );
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (
            disposed ||
            generation !== epoch ||
            accessVersion !== (accessVersions.get(record.channelId) ?? 0) ||
            !allowed?.has(record.channelId)
          )
            return;
        }
        if (heads.peek(record.channelId)) continue;
        const accessibleEvents = transport.visible(events);
        const page = parseWindow(
          record.channelId,
          null,
          transport.relayAuthor,
          accessibleEvents,
        );
        const rows = Object.freeze(
          foldMessages(record.channelId, transport.relayAuthor, page.events),
        );
        const head: Head = {
          rows,
          events: accessibleEvents,
          cursor: page.cursor,
          hasMore: page.hasMore,
          savedAt: record.savedAt,
          cached: true,
        };
        const verifiedProfiles: RelayEvent[] = [];
        for (let index = 0; index < record.profiles.length; index += 8) {
          for (const value of record.profiles.slice(index, index + 8)) {
            const candidate = value as { pubkey?: string; id?: string };
            const existing =
              candidate?.pubkey && directory.event(candidate.pubkey);
            // Reuse an already verified object, never the raw record that merely claims its ID.
            verifiedProfiles.push(
              existing && existing.id === candidate.id
                ? existing
                : verifySaved(value),
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (
            disposed ||
            generation !== epoch ||
            accessVersion !== (accessVersions.get(record.channelId) ?? 0) ||
            !allowed?.has(record.channelId)
          )
            return;
        }
        if (heads.peek(record.channelId)) continue;
        directory.accept(verifiedProfiles);
        // Profile subscribers can synchronously revoke/regrant or clear the
        // session. That callback is a boundary just like an awaited read.
        if (disposed || generation !== epoch) return;
        transport.restored?.(accessibleEvents);
        // Evidence subscribers can synchronously revoke access or clear caches too.
        if (disposed || generation !== epoch || !authorized(record.channelId))
          return;
        heads.set(record.channelId, head);
        const state = windows.get(record.channelId);
        if (
          state &&
          (state.snapshot.status === "idle" ||
            state.snapshot.status === "loading")
        ) {
          state.cursor = head.cursor;
          state.events = head.events;
          state.atHead = true;
          setWindow(state, patchFromHead(head));
        }
      } catch {
        /* Corrupt or unsigned cache records cannot reach the read model. */
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  function applyDiscovery(
    events: readonly RelayEvent[],
    complete?: ReadonlySet<string>,
    started?: ReadonlyMap<string, RelayEvent>,
  ) {
    if (disposed || !transport || !discovery) return;
    started ??= discovery.rosterVersions();
    const accessRevision = discovery.accessRevision;
    for (const event of events) discovery.accept(event);
    // Only a complete viewer-scoped roster read proves absence; capped reads and live traffic never revoke by omission.
    if (complete) {
      discovery.retain(complete, started);
      coverage = undefined;
    }
    const channels = Object.freeze(discovery.channels());
    const nextAllowed = new Set(channels.map((channel) => channel.id));
    const known = new Set([
      ...(allowed ?? []),
      ...windows.keys(),
      ...heads.keys(),
      ...tails.keys(),
    ]);
    for (const id of known)
      if (!authorized(id)) {
        accessVersions.set(id, (accessVersions.get(id) ?? 0) + 1);
        void persistence?.remove(id).catch(() => {});
      }
    allowed = nextAllowed;
    const commit = () => {
      for (const state of [...windows.values()])
        if (!authorized(state.channelId)) evict(state);
      for (const id of heads.keys()) if (!authorized(id)) heads.delete(id);
      for (const id of tails.keys()) if (!authorized(id)) tails.delete(id);
      if (complete) void persistence?.retain([...nextAllowed]).catch(() => {});
      setList({
        status: "ready",
        channels,
        ...(coverage ? { coverage } : {}),
        asOf: now(),
      });
    };
    // Commit the final channel list before any projection subscriber runs.
    // A session-only generic view can retain channels unknown to this store.
    if (discovery.accessRevision !== accessRevision)
      transport.revokeAccess(commit);
    else commit();
    // Discovery authorizes disk reuse, not speculative reads of the roster.
    // Network heads belong to explicit demand/intent and retained live catch-up.
    if (prepared) hydration ??= hydrate();
  }
  /** Apply roster authority as soon as it succeeds; names are a separate,
   * optional read and cannot delay revocation or overwrite newer live grants. */
  async function discover(force = false) {
    if (disposed || !transport || !discovery) return;
    // Hints/establishment during a read require a later read. During a quota
    // pause they retain an obligation, not another request with a deadline.
    if (force) listAgain = true;
    if (
      listBusy ||
      performance.now() < listRetryAt ||
      (!listAgain &&
        list.status === "ready" &&
        rosterRefresh.state === "verified")
    )
      return;
    listAgain = false;
    listRetryAt = 0;
    listBusy = true;
    rosterRefresh = Object.freeze({ state: "pending" });
    transport.rosterChanged?.();
    if (disposed) {
      listBusy = false;
      return;
    }
    if (list.status !== "ready")
      setList({ status: "loading", channels: list.channels });
    if (disposed) {
      listBusy = false;
      return;
    }
    let generation = epoch;
    let controller = new AbortController();
    controllers.add(controller);
    const started = discovery.rosterVersions();
    let readingRoster = true;
    let outcome: RosterRefresh = { state: "deferred" };
    try {
      const rosters = await transport.read(
        [{ kinds: [39002], "#p": [transport.viewer], limit: DISCOVERY_LIMIT }],
        { signal: controller.signal },
      );
      if (disposed || generation !== epoch) return;
      const ids = [
        ...new Set(
          rosters
            .filter(
              (event) =>
                event.kind === 39002 &&
                event.pubkey === transport.relayAuthor &&
                hasTag(event, "p", transport.viewer),
            )
            .map((event) => tag(event, "d"))
            .filter((id): id is string => !!id),
        ),
      ];
      const named = new Set(
        rosters
          .filter((event) => event.kind === 39000)
          .map((event) => tag(event, "d")),
      );
      const wanted = ids.filter(
        (id) => !named.has(id) && (force || !discovery.named(id)),
      );
      const complete =
        rosters.length < DISCOVERY_LIMIT ? new Set(ids) : undefined;
      if (!complete) coverage = "partial";
      applyDiscovery(rosters, complete, started);
      if (disposed) return;
      generation = epoch;
      readingRoster = false;
      // Applying our own complete roster can invalidate the original request.
      // Metadata gets a fresh cancellation owner, never another completeness set.
      controllers.delete(controller);
      controller = new AbortController();
      controllers.add(controller);
      const metadata = wanted.length
        ? await transport.read(
            [{ kinds: [39000], "#d": wanted, limit: DISCOVERY_LIMIT }],
            { signal: controller.signal },
          )
        : [];
      if (disposed || generation !== epoch) return;
      applyDiscovery(metadata);
      if (!disposed && generation === epoch) outcome = { state: "verified" };
    } catch (error) {
      if (disposed || generation !== epoch) return;
      outcome = isAbort(error)
        ? { state: "deferred" }
        : { state: "error", error: describe(error) };
      if (error instanceof ReadError && error.retryAfterMs !== undefined)
        listRetryAt = performance.now() + error.retryAfterMs;
      if (readingRoster && readErrorKind(error) === "denied") {
        discovery.denyAll();
        transport.revokeAccess(() => {
          for (const id of allowed ?? [])
            accessVersions.set(id, (accessVersions.get(id) ?? 0) + 1);
          allowed = new Set();
          for (const state of [...windows.values()]) evict(state);
          heads.clear();
          tails.clear();
          directory.clear();
          void persistence?.clear().catch(() => {});
          setList({
            status: "error",
            channels: Object.freeze([]),
            coverage: "partial",
            error: describe(error),
          });
        });
      } else {
        // Failed names do not discard successful membership authority.
        if (!readingRoster) applyDiscovery([]);
        setList({ ...list, status: "error", error: describe(error) });
      }
    } finally {
      controllers.delete(controller);
      listBusy = false;
      if (!disposed) {
        rosterRefresh = Object.freeze(outcome);
        // Stale work cannot consume a newer hint or certify freshness. A failed
        // read waits for deliberate retry/a later hint instead of draining work.
        if (listAgain && outcome.state !== "error") void discover(true);
        else transport.rosterChanged?.();
      }
    }
  }
  async function clearCache() {
    epoch++;
    hydration = undefined;
    media.dispose();
    media = createMediaPreparation();
    for (const controller of controllers) controller.abort();
    for (const state of [...windows.values()]) evict(state);
    heads.clear();
    tails.clear();
    await persistence?.clear().catch(() => {});
  }
  const queries: ChannelQueries = Object.freeze({
    list: () => list,
    subscribeList: (listener: Listener) => subscribe(listListeners, listener),
    window: (channelId: string) =>
      windows.get(channelId)?.snapshot ?? idleWindow(channelId),
    subscribeWindow(channelId: string, listener: Listener) {
      const listeners = windowListeners.get(channelId) ?? new Set<Listener>();
      windowListeners.set(channelId, listeners);
      const release = subscribe(listeners, listener);
      return () => {
        release();
        if (!listeners.size) windowListeners.delete(channelId);
        trim();
      };
    },
    ensureList() {
      void discover();
    },
    refreshList() {
      void discover(true);
    },
    ensure(channelId: string) {
      if (disposed || !transport || !authorized(channelId)) return;
      intent = channelId;
      current = channelId;
      const state = touch(channelId);
      const retained = prepared ? heads.peek(channelId) : undefined;
      if (retained && ["idle", "error"].includes(state.snapshot.status)) {
        state.cursor = retained.cursor;
        state.events = retained.events;
        state.atHead = true;
        setWindow(state, patchFromHead(retained));
      }
      if (transport.demand?.(channelId)) return;
      if (
        state.snapshot.status !== "idle" &&
        state.snapshot.status !== "error"
      ) {
        if (prepared) {
          prepareMedia(channelId);
          const previous = heads.peek(channelId);
          // Revalidate a retained head on revisit after its freshness lease. Do not
          // replace a paged history reader with a new head merely because time passed.
          if (
            previous &&
            state.atHead &&
            !state.controller &&
            (previous.cached || now() - previous.savedAt >= FRESH_FOR)
          )
            void loadPage(state, null);
        }
        return;
      }
      const head = prepared ? heads.get(channelId) : undefined;
      if (head) {
        state.cursor = head.cursor;
        state.events = head.events;
        state.atHead = true;
        setWindow(state, patchFromHead(head));
        prepareMedia(channelId);
      }
      if (head && !head.cached && now() - head.savedAt < FRESH_FOR) return;
      if (!head) setWindow(state, { status: "loading", error: undefined });
      void loadPage(state, null);
    },
    prepare(channelId: string) {
      if (!prepared || disposed || !transport || !allowed?.has(channelId))
        return;
      intent = channelId;
      const head = heads.get(channelId);
      if (head) prepareMedia(channelId);
      if (
        preparing ||
        (head && !head.cached && now() - head.savedAt < FRESH_FOR)
      )
        return;
      // One speculative head, no backlog from crossing sidebar rows. Keep it
      // foreground so selecting this same request cannot inherit a host-side
      // background wait; the other reader slots remain available for demand.
      preparing = true;
      void requestHead(channelId, "foreground")
        .catch(() => {})
        .finally(() => {
          preparing = false;
        });
    },
    refresh(channelId: string) {
      if (disposed || !transport || !authorized(channelId)) return;
      const state = touch(channelId);
      if (transport.demand?.(channelId)) return;
      if (state.controller) return;
      if (!state.snapshot.rows.length)
        setWindow(state, { status: "loading", error: undefined });
      void loadPage(state, null);
    },
    loadOlder(channelId: string) {
      if (disposed || !transport) return;
      const state = windows.get(channelId);
      if (
        state?.snapshot.status !== "ready" ||
        !state.snapshot.hasMore ||
        state.snapshot.loadingOlder ||
        state.snapshot.historyLimited ||
        !state.cursor ||
        state.controller
      )
        return;
      setWindow(state, { loadingOlder: true, error: undefined });
      void loadPage(state, state.cursor);
    },
  });
  let previousLocal = new Map(
    (local?.snapshot() ?? []).map((item) => [item.event.id, item]),
  );
  const unsubscribeLocal = local?.subscribe(() => {
    if (disposed) return;
    const next = new Map(
      (local?.snapshot() ?? []).map((item) => [item.event.id, item]),
    );
    const changed = [...next.values()].filter((item) => {
      const old = previousLocal.get(item.event.id);
      return !old || old.delivery !== item.delivery || old.error !== item.error;
    });
    for (const [id, item] of previousLocal)
      if (!next.has(id)) changed.push(item);
    previousLocal = next;
    if (!changed.length) return;
    const channelIds = new Set(
      changed.flatMap((item) =>
        item.event.tags.flatMap(([name, value]) =>
          name === "h" && value !== undefined ? [value] : [],
        ),
      ),
    );
    for (const channelId of channelIds)
      if (
        authorized(channelId) &&
        !windows.has(channelId) &&
        changed.some(
          (item) =>
            next.has(item.event.id) &&
            item.delivery !== "seen" &&
            [9, 40002].includes(item.event.kind),
        )
      )
        touch(channelId);
    for (const state of windows.values()) {
      if (
        !channelIds.has(state.channelId) &&
        !changed.some((item) =>
          item.event.tags.some(
            (tag) =>
              tag[0] === "e" &&
              state.snapshot.rows.some((row) => row.id === tag[1]),
          ),
        )
      )
        continue;
      setWindow(state, {});
      const newMessages = changed.filter(
        (item) =>
          [9, 40002].includes(item.event.kind) && item.delivery === "sending",
      );
      if (newMessages.length)
        void fetchProfiles(state.snapshot.rows.slice(-12));
    }
  });
  /** Verified traffic shares the same fold as reads and local intent. Window bounds remain read-owned. */
  function accept(events: readonly RelayEvent[]) {
    if (disposed || !transport) return;
    const generation = epoch;
    const changedChannels = new Set(
      events.flatMap((event) =>
        event.tags.flatMap(([name, value]) =>
          name === "h" && value !== undefined ? [value] : [],
        ),
      ),
    );
    for (const channelId of changedChannels) {
      if (!authorized(channelId)) continue;
      const merged = new Map(
        (tails.peek(channelId)?.events ?? []).map((event) => [event.id, event]),
      );
      for (const event of events)
        if (event.tags.some((tag) => tag[0] === "h" && tag[1] === channelId))
          merged.set(event.id, event);
      const retained = [...merged.values()]
        .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
        .slice(0, 256);
      const preview = windows.has(channelId)
        ? tails.peek(channelId)?.preview
        : messagePreview(
            foldMessages(channelId, transport.relayAuthor, [
              ...new Map(
                [...(heads.peek(channelId)?.events ?? []), ...retained].map(
                  (event) => [event.id, event],
                ),
              ).values(),
            ]),
          );
      tails.set(channelId, { events: retained, preview });
    }
    for (const state of windows.values()) {
      if (disposed || generation !== epoch) return;
      if (!authorized(state.channelId)) continue;
      const ids = new Set(state.events.map((event) => event.id));
      const incoming = events.filter(
        (event) =>
          !ids.has(event.id) &&
          [9, 40002, 40099, 40003, 5, 9005, 7, 39005].includes(event.kind) &&
          event.tags.some(
            (tag) =>
              (tag[0] === "h" && tag[1] === state.channelId) ||
              (tag[0] === "e" && ids.has(tag[1] ?? "")),
          ),
      );
      if (!incoming.length) continue;
      const localIds = new Set(
        (local?.snapshot() ?? []).map((item) => item.event.id),
      );
      let retained = [...state.events, ...incoming];
      let limited = false;
      if (
        byteSize(retained) > maxHistoryBytes ||
        retained.filter(
          (event) => channelRowKind(event.kind) && !localIds.has(event.id),
        ).length > maxHistoryRows
      ) {
        limited = true;
        const newest = retained
          .filter(
            (event) => channelRowKind(event.kind) && !localIds.has(event.id),
          )
          .sort(
            (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
          )
          .slice(0, maxHistoryRows);
        const keep = new Set([...newest.map((event) => event.id), ...localIds]);
        retained = retained.filter(
          (event) =>
            keep.has(event.id) ||
            (!channelRowKind(event.kind) &&
              event.tags.some(
                (tag) => tag[0] === "e" && keep.has(tag[1] ?? ""),
              )),
        );
        while (retained.length && byteSize(retained) > maxHistoryBytes)
          retained.splice(0, Math.max(1, Math.ceil(retained.length / 4)));
        const retainedIds = new Set(retained.map((event) => event.id));
        for (const id of state.traffic.keys())
          if (!retainedIds.has(id)) state.traffic.delete(id);
      }
      const retainedIds = new Set(retained.map((event) => event.id));
      for (const event of incoming)
        if (retainedIds.has(event.id)) state.traffic.set(event.id, event);
      state.events = retained;
      setWindow(state, limited ? { historyLimited: true } : {});
      if (disposed || generation !== epoch) return;
      void fetchProfiles(state.snapshot.rows.slice(-12));
    }
    for (const channelId of changedChannels) {
      const tail = tails.peek(channelId);
      const state = windows.get(channelId);
      if (tail && state)
        tails.set(channelId, {
          ...tail,
          preview: messagePreview(state.snapshot.rows),
        });
    }
    setList(list);
  }
  /** Re-evaluate retained channel inputs at the session's access boundary, not
   * only the revoked channel: an auxiliary may reference several channels. */
  function purgeAccess(
    visible: (events: readonly RelayEvent[]) => readonly RelayEvent[],
  ) {
    const hadHydration = hydration !== undefined;
    epoch++;
    hydration = undefined;
    media.dispose();
    media = createMediaPreparation();
    for (const controller of controllers) controller.abort();
    for (const [id, head] of heads.entries()) {
      if (!transport || !authorized(id)) {
        heads.delete(id);
        continue;
      }
      const events = visible(head.events);
      if (events.length !== head.events.length)
        heads.set(id, {
          ...head,
          events,
          rows: Object.freeze(foldMessages(id, transport.relayAuthor, events)),
        });
    }
    for (const [id, tail] of tails.entries()) {
      if (!transport || !authorized(id)) {
        tails.delete(id);
        continue;
      }
      const events = visible(tail.events);
      tails.set(id, {
        events,
        preview: messagePreview(
          foldMessages(id, transport.relayAuthor, [
            ...(heads.peek(id)?.events ?? []),
            ...events,
          ]),
        ),
      });
    }
    for (const state of [...windows.values()]) {
      if (!authorized(state.channelId)) {
        state.generation++;
        state.controller?.abort();
        state.controller = undefined;
        state.events = [];
        state.traffic.clear();
        setWindow(state, {
          rows: EMPTY_ROWS,
          loadingOlder: false,
          status: "idle",
        });
        continue;
      }
      state.generation++;
      state.controller?.abort();
      state.controller = undefined;
      state.events = visible([...state.events, ...state.traffic.values()]);
      state.traffic.clear();
      setWindow(state, {
        loadingOlder: false,
        status: state.events.length ? "ready" : "idle",
      });
    }
    // Disk heads also carry profile and cross-channel auxiliary evidence. Drop
    // this disposable cache conservatively; pending writes use separate storage.
    if (hadHydration) void persistence?.clear().catch(() => {});
    setList(list);
  }
  function dispose() {
    disposed = true;
    unsubscribeLocal?.();
    epoch++;
    media.dispose();
    for (const controller of controllers) controller.abort();
    for (const state of windows.values()) {
      state.generation++;
      state.controller?.abort();
    }
    windows.clear();
    heads.clear();
    tails.clear();
    persistence?.close();
  }
  return {
    queries,
    roster: () => rosterRefresh,
    retryList() {
      if (rosterRefresh.state === "error" || rosterRefresh.state === "deferred")
        void discover(true);
    },
    canAccess: authorized,
    purgeAccess,
    denyChannel,
    acceptDiscovery: applyDiscovery,
    accept,
    clearCache,
    dispose,
    /** A disconnected stream invalidates a head's freshness lease, not its content.
     * Inactive cached heads will revalidate when demanded, without an all-roster read. */
    staleHeads() {
      for (const [id, head] of heads.entries())
        heads.set(id, { ...head, cached: true });
      for (const state of windows.values())
        setWindow(state, { freshness: "cached" });
    },
    /** Revalidate only a retained reader after establishing the stream. An unopened
     * channel needs no eager HTTP head; its normal ensure() owns that finite handoff. */
    async catchUp(channelId: string) {
      const cached = heads.peek(channelId);
      if (cached) heads.set(channelId, { ...cached, cached: true });
      const retained = windows.get(channelId);
      if (!retained) return false;
      const epochAtStart = epoch;
      const generation = retained.generation;
      const valid = () => epoch === epochAtStart && live(retained, generation);
      if (!retained.snapshot.rows.length)
        setWindow(retained, { status: "loading", error: undefined });
      try {
        const head = await requestHead(
          channelId,
          current === channelId ? "foreground" : "background",
        );
        if (!valid())
          throw new DOMException("Stale live catch-up", "AbortError");
        accept(head.events);
        if (!valid())
          throw new DOMException("Stale live catch-up", "AbortError");
        if (retained.atHead) retained.cursor = head.cursor;
        setWindow(retained, {
          ...(retained.atHead ? { hasMore: head.hasMore } : {}),
          status: "ready",
          freshness: "verified",
          error: undefined,
        });
        return true;
      } catch (error) {
        if (!valid())
          throw new DOMException("Stale live catch-up", "AbortError");
        if (!isAbort(error))
          setWindow(retained, {
            status: retained.snapshot.rows.length ? "ready" : "error",
            freshness: "cached",
            error: describe(error),
          });
        throw error;
      }
    },
    /** Also settles queued obligations refused before catchUp could dispatch. */
    catchUpFailed(channelId: string, error: unknown) {
      const state = windows.get(channelId);
      if (disposed || !state || !authorized(channelId) || isAbort(error))
        return;
      setWindow(state, {
        status: state.snapshot.rows.length ? "ready" : "error",
        freshness: "cached",
        error: describe(error),
      });
    },
    retainedChannels: () => [...windows.keys()],
    demandedChannels: () => [
      ...new Set([
        ...(current && windows.has(current) ? [current] : []),
        ...[...windows.keys()].reverse(),
      ]),
    ],
    staleHead(channelId: string) {
      const head = heads.peek(channelId);
      if (head) heads.set(channelId, { ...head, cached: true });
      const state = windows.get(channelId);
      if (state) setWindow(state, { freshness: "cached" });
    },
    diagnostics: () => ({
      heads: heads.stats(),
      media: media.stats(),
      historyRows: [...windows.values()].reduce(
        (sum, state) => sum + state.snapshot.rows.length,
        0,
      ),
    }),
  };
}
