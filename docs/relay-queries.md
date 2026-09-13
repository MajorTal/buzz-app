# Unified relay session

`features/relay/session.ts` composes one session per connected community and viewer.
Plugins inject **only `relay`**. Reads, reactive views and the optional outbox are
capabilities on that same session; sent-versus-seen reconciliation is internal.

The relay service exists before its connection is ready. Subscribe to connection
replacement; do not capture `ctx.relay.snapshot().session` once during plugin startup.
The Channels page uses this pattern:

```tsx
const connection = useRelayConnection(relay);
if (connection.status !== "ready") return <ConnectionState connection={connection} />;
return <Feature key={`${connection.scope}:${connection.generation}`} session={connection.session} />;
```

Scope includes community and viewer; generation distinguishes replacement sessions
within that scope. Both belong in the remount key. Persist drafts/navigation under
scope alone so reconnecting does not lose local intent.

Inside a feature bound to the current session:

```ts
session.channels.ensure(channelId);
const window = session.channels.window(channelId);
await session.profiles.ensure([authorId]);

// A plugin's filtered view includes matching local operations immediately.
const view = session.observe([{ kinds: [9], "#h": [channelId], limit: 80 }]);
ctx.effect(() => {
  const unsubscribe = view.subscribe(render);
  return () => { unsubscribe(); view.dispose(); };
});
void view.refresh();

// The same interface supplies write operations when supported by the host.
const outbox = session.outbox;
if (outbox?.supports(9)) {
  const id = outbox.send({ kind: 9, content: "Hello", tags: [["h", channelId]] });
  // id is already stable; signing and publishing proceed asynchronously.
}
```

`session.read(filters, { signal })` is a finite read merged with matching local
operations at completion. `session.observe(filters)` additionally subscribes to
outbox changes, exposing immutable `{ status, events, error }` snapshots. Own the
view with the plugin's Cordis scope and use `useSyncExternalStore` in React. The
Channels plugin uses the existing channel-specific hooks over the same local
operations. The composer holds draft text, not a private message list.

`observe()` retains a bounded union of matching events across reads and live
traffic; refresh does not replace that collection or remove events omitted by a
later response. Filter `limit` bounds each relay request, not the visible collection.
It rejects any filter containing `search` or `feed_types`, including mixed filter
requests. Use finite `session.read()` for those server-ranked results; it preserves
the response order. A feature needing reactive ranked results must own its refresh
and replacement semantics.

Visible events contain `EventData` and optional `delivery`/`error` metadata. A
locally authored event is **not proof of relay acceptance**. Signature-verified
`RelayEvent` records remain the private transport boundary used for authoritative
membership, bounds and persistence. Domain folds can consume local payloads, but
must not let them manufacture relay-authored authority.

## Presence

`session.presence` exposes volatile per-author status and surface-owned demand,
using the same authenticated socket and verified background reader without message
retention or outbox replay. See [presence ownership, traffic budgets and limits](presence.md).

## Community emoji

`session.emoji` owns the current community's kind-30030 `d=buzz:custom-emoji`
member sets. `snapshot()` / `subscribe()` provide an immutable catalog; `ensure()`
is lazy and background-priority, and `refresh()` explicitly retries. The shared
composer warms it on mount. Each author's newest complete set replaces their old
one (including empty removal sets); the union picks newer sets, then smaller URLs,
for shortcode conflicts. The directory retains at most 500 member sets / 2 MiB;
read caps and overflow expose errors rather than silently evicting replacements.
An explicit retry after overflow starts a fresh bounded catalog read.

Live kind-30030 updates share the existing profile route, not another socket or
subscription slot. Global establishment repairs an already requested catalog;
cache/access clearing and disposal cancel its reads and fence stale results.
The development broker imports the live subscription code at startup: an already
running broker needs one coordinated restart to gain the new filter. Reopening
the picker reuses its ready catalog; it is not a manual refresh fallback for an
older broker.

`session.messages.send`, `reply`, and `edit` resolve referenced `:shortcodes:`
into original-URL emoji tags **before** the outbox assigns identity or signs. Text
without shortcode candidates does not wait. A cold/unavailable catalog throws
synchronously, so a composer retains its draft; plugins can await `ensure()` or
explicitly retry `refresh()`. Unknown codes in a ready catalog remain literal.
Retries retain the exact original event and URL even if the palette changes.
Low-level `outbox.send` remains raw intent; callers supply its tags themselves.

Message and reaction rendering uses only each event's own emoji tags, never the
current palette. Tagged edits replace mappings; legacy tagless edits preserve the
original message's mappings. All thumbnails use the captured session's media
resolver; unsupported or unloadable images fall back to literal shortcodes.
Uploads/management and reaction authoring are outside this slice.

## Thread views

`session.thread(channelId, messageId)` returns an owned `ThreadView` with immutable
`{ status, root, replies, error, canLoadMore, limited }` snapshots, `subscribe`,
`refresh`, `loadMore`, and `dispose`. Allocate in a React effect (not render or
`useMemo`) and dispose with the panel. Selection/layout belong to the consuming page; reusable UI lives in
`features/messages`. Verified evidence, access, live reconciliation and repair
belong to the session.

The owner resolves marked NIP-10 ancestry to the actual root, fetches that root by
ID, and traverses with explicit content kinds, `#h`, one root `#e`, depth 100 and
`include_aux`. Pages advance with both `thread_cursor` and `thread_cursor_id` in
ascending time/ID order. The cursor comes only from exact verified finite traversal
rows, excluding appended auxiliary events—not the public read's live/local union.
There is no fabricated thread `39006` or authoritative exhaustion claim.

Each page requests 50 traversal rows, with at most ten pages per repair/load range.
The shared panel automatically loads this range with no explicit pagination button.
It remains oldest-first: a capped thread cannot promise its newest tail.
Refresh re-reads the retained page range from the beginning while preserving known
rows/edits/deletes: omitted events are not retractions. Live channel traffic feeds
this same view without another subscription. Channel establishment triggers repair
independently from finite channel-head invalidation. Author deletion of a retained
edit/reaction removes that overlay. Unknown or denied auxiliary targets remain
invisible; active thread target evidence survives shared-cache eviction but still
passes the existing recursive access check.

Threads share the 64 owned-handle ceiling. Each retains at most 2,000 events / 4 MiB;
overflow clears display evidence and exposes an explicit recoverable limit rather
than silently evicting a tombstone. Cache clear, access loss and session disposal
cancel pending work and purge owned state. A missing finite root hides the display
but retains bounded tombstones for safe retry. Short/empty pages mean only what the
relay returned; depth, serving-time filtering and retention can leave history unseen.

`session.messages.reply(channelId, resolvedRootId, text)` submits kind 9 through
the existing outbox with `["h", channelId]` and `["e", resolvedRootId, "", "reply"]`.
Use the resolved root, not the selected nested reply. It does not require that root
to remain in the shared recent cache; the relay enforces channel membership and
same-channel ancestry. There is no extra root lookup, signer or delivery owner.

Local replies appear immediately in the thread but do not leak into the top-level
channel timeline. Failed content rows stay visible for same-event retry; failed
auxiliary edits/reactions stop affecting the fold. Verified echo reconciliation and
persisted signed-event retry remain the same outbox operations as channel sends.

## Ownership and reconciliation

| Internal owner | Responsibility |
| --- | --- |
| `service.ts` | Connection state, replacement, root lifecycle; provides `ctx.relay` |
| `session.ts` | One plugin interface; coordinates access-loss cancellation and purges every retained read owner before reconciling new evidence |
| `reader.ts` | Request sharing, priority, cancellation and deadlines; no result cache |
| `outbox.ts` | Durable local intent, signing, publishing, retry, delivery status |
| `projection.ts` | Merge ordinary filtered reads with local events by stable event ID |
| `profile-directory.ts` | Shared signed profiles plus optimistic profile changes |
| `store.ts` / `discovery.ts` | Authoritative channel access policy, retained windows, domain folding and persistence |
| `event-access.ts` | Resolves event/reference visibility against that policy; no parallel membership cache |
| `transport.ts` | Host signer/broker access and validated publish receipts |

A send registers its local payload synchronously and notifies all views. Its ID is
computed from the viewer, timestamp, content and tags before signing. A unique
client tag distinguishes intentional duplicate messages within one second.

The outbox saves intent before signing and the exact signed event before publishing.
A storage failure prevents publishing. An explicit relay rejection becomes `failed`;
a lost response or publish timeout becomes `unknown`, because it may have committed.
A later rejected/failed retry cannot erase earlier `unknown` or `accepted` evidence;
its error describes the retry, not proof the original event was unsent.
Retries reuse the signed event and event ID, while HTTP authentication uses a fresh
request-bound NIP-98 event. The relay's event-ID deduplication handles repeat delivery.

An accepted receipt becomes `accepted`; a verified read containing the ID becomes
`seen`. Observation wins over a later failed/missing acknowledgement. The session
performs one foreground ID read for the just-published event, then up to four
background retries with bounded backoff. Optional profile enrichment cannot block
that first confirmation; later retries yield to current user work.
Exhausting those attempts leaves the delivery state visible and retryable. Ordinary
later reads can also complete reconciliation.

Confirmed operations leave the pending outbox automatically. Their verified events
remain in bounded confirmed retention and in active views. This is
what prevents a lagging query or stale channel refresh from erasing a successful
send. Remote echoes and local operations merge by ID, never by matching text or
an approximate timestamp. Channel windows retain verified event inputs so local
edits can fold against the original message; rejected edits stop contributing.
The timeline, channel-list preview and filtered plugin views share that operation.

## Bounds and lifecycle

- Ordinary reads: three active slots, at most one background request, 128 pending
  distinct requests. One strictly classified presence snapshot has separate additive
  capacity; it does not reduce those ordinary budgets. All reads retain ten-second
  deadlines including queue time, four filters per request, 500 per-filter limit,
  64 KiB keys, and an 8 MiB result budget. Optional consumer cancellation retains
  its slot until underlying work settles. See [optional presence transport](#optional-presence-transport).
- Outbox: at most 256 operations / 2 MiB persisted, 32 KiB per submitted payload,
  three concurrent deliveries, ten-second delivery deadlines including queue time. Only outstanding
  operations count toward capacity; completed events move to a separate 2,048-event /
  8 MiB confirmed journal. Capacity failures
  are visible; unconfirmed operations are never silently evicted. Plugins can
  explicitly `dismiss(id)` to remove an operation's local contribution.
- Reactive filtered views: at most 64 owned handles; dispose with the plugin.
- Existing fetched channel history, profile, media and disk budgets remain in place.
  Local overlays have their separate journal budget and can extend a visible window.
  Shared verified observations retain up to 4,096 events / 8 MiB; owned filtered views
  retain up to 2,000 remote events / 8 MiB each. Channel tails retain 256 events
  per channel within 64 channels / 4 MiB, keeping inactive previews and revisits
  consistent. Retention is bounded, not permanent history.

Storage is partitioned by community endpoint and viewer; no private keys are
stored. Restored pending operations become `unknown` unless previously failed. Confirmed
  records remain confirmed and do not re-enter the pending outbox.
They do not publish automatically after restart. Explicit retry reuses the saved
signed event. The Channels timeline exposes retries for failed/unknown messages. Its Outbox
control also exposes restored pending operations and explicit removal. Removing an item
stops retaining its local overlay; it is not a relay deletion.
Session disposal cancels work and blocks late state changes. Cache clearing keeps
the outbox: clearing fetched data is not cancelling a user's write.

### Authoritative access loss

A signed membership exclusion, omission from a complete viewer-scoped roster, or
explicit channel denial removes inaccessible data from existing **and newly opened**
host read views. A generic read returning denial with exactly one explicit `#h`
channel also revokes that channel. An ambiguous multi-channel/broad error does not
prove which membership was lost; a denied complete-roster request invalidates all
channel access. Partial discovery and transport failures never revoke by omission.
A successful complete roster is applied immediately, independently of the optional
metadata/name read: a later name-fetch error does not discard membership evidence.
Completeness cannot erase a newer signed roster received after that request began;
metadata completion cannot replay the older membership snapshot.

The session cancels all pending reads on revocation, because broad/ID/reference
filters cannot establish event ownership before results arrive. Completion epochs
also fence already-resolved requests. The session defers subscription callbacks
until every owned projection and the final channel list have been purged; a callback
reading another view cannot observe its pre-revocation snapshot. Unrelated retained
channel content survives, but in-flight reads may need refresh. A newer signed roster can regrant access;
replaying the last retained pre-revocation roster cannot restore it. Read grants/removals reach the
store's authority boundary even when their raw events are hidden from plugin views.

Visibility uses each event's `h` tags, channel-metadata `d` tags, and auxiliary
references. For edits, deletes, reactions and summaries (kinds 40003, 5, 9005, 7,
39005), **every `e` target must be available and visible**, including targets in the
same response. A reference-only orphan is omitted rather than assumed public;
cycles/deep reference chains fail closed. Explicit `h` does not authorize an unknown
second target. Ordinary non-channel entities remain readable, and auxiliaries for
retained non-channel targets still work. Fetch target evidence with an auxiliary
when needed. This is a deliberate narrowing of raw standalone auxiliary reads, not
a generic Nostr authorization implementation or a new external SDK promise.

Revocation purges fetched/confirmed read evidence, not pending intent. The outbox
retains pending/unknown operation IDs and exact signed bytes for explicit recovery;
its management snapshot still exposes those operations, while read overlays hide
them until access returns. Confirmed evidence is not pending intent and is dropped
when inaccessible. If revocation races initial outbox hydration, that load's entire
confirmed cache is discarded conservatively; pending signed records are preserved.
Shared signed profile projections and already-opened disk-head caches are also
cleared conservatively because they can include cross-channel evidence. Disk-cache
failure does not reauthorize in-memory views. This does not erase copies already
made by trusted plugins, cancel/re-sign durable writes, or replace relay-side checks.

A plugin unloading does not dispose the session or its writes. Reconnection creates
a new session and restores the same community/viewer's durable outbox. Distinct
community/viewer storage partitions never share outgoing intent.

Server-ranked search/feed eligibility is not inferred from local text. Ordinary
NIP-01 ID/kind/author/tag/time filters receive local overlays; features with special
server semantics must define their own domain projection. Reads stay bounded and
do not claim complete history merely because they returned successfully.

## Evidence from the current Buzz desktop

Inspected [Block Buzz](https://github.com/block/buzz) on 2026-09-07. Paths below are
relative to that repository. This is an inventory of read contracts, not a port of its UI.

| Desktop use | Source | Contract supported by the core |
| --- | --- | --- |
| Channel history and auxiliary overlays | `desktop/src/shared/api/relayChannelFilters.ts`, `relayClientSession.ts` | Kinds, `#h`, time bounds; `#e` for edits/reactions/deletions. Foundation retains its stronger NIP-CW bounds/closure contract. |
| Profiles and user directory | `desktop/src/shared/api/tauriProfiles.ts` | Shared kind-0 directory; ID-independent author batches. Search remains a finite filtered read. |
| Relay membership | `desktop/src/shared/api/relayMembers.ts` | Kind 13534 snapshot; feature must preserve “no membership snapshot” separately from denial. |
| Custom emoji | `desktop/src/shared/api/customEmoji.ts` | Kind 30030 with `#d`, optionally an author; feature folds member sets. |
| User status | `desktop/src/features/user-status/hooks.ts` | Kind 30315, authors, `#d=general`; expiry semantics belong to the status feature. |
| Stars, mutes, sections, sorting, project membership | `desktop/src/features/sidebar/lib/*Sync.ts`, `desktop/src/features/projects/lib/projectSidebarMembershipSync.ts` | Kind 30078, author, `#d`; encryption and merge rules stay outside the reader. |
| Read markers | `desktop/src/features/channels/readState/readStateManager.ts` | Kind 30078, author, `#t=read-state`, `since`; multiple device slots must be merged by the feature. |
| Hidden DMs | `desktop/src/features/channels/useHiddenDmIds.ts` | Kind 30622 scoped by viewer `#p`; result interpretation remains domain-owned. |
| Repositories, issues, PRs and assignment history | `desktop/src/features/projects/hooks.ts`, `assignmentOperationFetch.ts` | Authors, `#d`, repository addresses `#a`, event references `#e`; limit and completeness decisions remain explicit. |
| Entity links | `desktop/src/shared/lib/useResolvedLinkPreviews.ts` | Event IDs and address-based lookups without loading a channel. |
| Thread traversal, Home feed, search | `desktop/src/shared/api/tauri.ts`; `crates/buzz-relay/src/api/bridge.rs` | Bridge `depth_limit` and composite thread cursor, ordered `feed_types`, `search`, `search_mode`, `page`. These return events; native response metadata is not fabricated. |
| Persona/team catalogs, reminders, community themes | `desktop/src/features/agents/lib/usePersonaSync.ts`, `desktop/src/features/reminders/lib/reminderService.ts`, `desktop/src/shared/theme/communityThemeSync.ts` | Ordinary kind/author/tag reads through the same finite reader. |

The HTTP bridge supports these finite filter shapes and enforces authorization
server-side. The opt-in dev broker accepts bounded Nostr kinds and event-ID reads. No live credentials are used by tests.


## Current scope and validation

Channels supports top-level text messages and direct thread replies, Enter to send,
Shift+Enter for a newline,
immediate rows and shared preview data (not currently rendered in the sidebar),
delivery status, and retry. The dev broker
advertises kind 9 writes and signs bounded channel messages, including exactly one
canonical direct-reply reference. Both sign and publish endpoints reject malformed
or arbitrary references before upstream I/O. The
signed transport can supply additional event kinds to other plugins. No separate
plugin signer or writer service is exposed.

The signed host and opt-in broker subscribe to authenticated Nostr traffic. Verified
incoming events, finite reads and own echoes enter the same session reconciliation
path. Reconnect performs bounded replay and revalidates retained channel heads and
filtered views. History bounds still come from finite channel reads; replay does
not claim complete history. Decryption, uploads and server-derived aggregate calculations remain domain capabilities.

`session.messages.send(channelId, text)`, `.reply(channelId, resolvedRootId, text)`,
`.edit(messageId, text)` and `.retry(id)`
are domain conveniences over the same outbox. Editing requires a retained message
owned by the viewer and a transport that supports kind 40003. The dev broker still
advertises only kind 9. Generic plugins can use `outbox.send` directly.

Persistence uses incremental asynchronous IndexedDB transactions partitioned by
community and viewer. Only changed records are written; the earlier localStorage
journal is migrated on first commit. Restored signatures are verified in batches
that yield to rendering. Local insertion is
synchronous; intent and then the exact signed event must commit before publication.
Queued intent is still saved when a session is disposed before storage finishes
loading. Restored operations are never published automatically.

Delivery status changes preserve unaffected row/event identities. Per-window event
and overlay indexes fold only affected message content; signing and ACK transitions
never refold history. Incoming traffic updates the same channel preview and views.
When live traffic fills a retained history budget, oldest remote inputs are trimmed
and history is marked limited; new traffic continues to arrive.

`outbox.test.ts` covers immediate views, stale reads, echo-before-ACK, explicit
rejection, exact-event retry, persistence failures, restart, timeout/unknown outcomes,
optimistic profile changes and edit rollback. `transport.test.ts` covers request-bound
HTTP publishing and receipt validation. Existing history/revocation tests still run
through the unified session. `tests/fixtures/relay-composer.html` is a local-only browser
fixture using ephemeral signing keys and an in-memory relay; messages containing
`reject` fail once, allowing the real composer/retry UI to be exercised safely.

## Profiling and integration checks

`session.profiling.snapshot()` returns the latest 2,048 completed samples plus active
spans. Samples contain stage, event/request ID, start, duration, outcome and optional
work count. They never contain message content, filters, credentials or signatures.
Open **Outbox → Relay timings → Capture timings** while a send is stuck; active
spans show elapsed time. **Export timings** downloads JSON for comparison.

- `send.local`: synchronous insertion and view propagation.
- `outbox.load`, `outbox.queue`, `outbox.persist`: hydration, queueing and durable transactions.
- `send.sign`, `send.verify`: host signing and verification of the returned event.
- `send.publish`: publication through receipt validation.
- `http.auth`, `http.fetch`: signed host authentication and HTTP request latency.
- `broker.sign`, `broker.auth`, `broker.connect`, `broker.ttfb`, `broker.relay`, `broker.upstream`:
  dev broker Server-Timing measurements. `connect` appears only when a request had to open a
  new upstream connection; `relay` is the relay's own reported service time, so
  `upstream − relay` is network and edge time.
- `read.queue`, `read.fetch`, `read.verify`: scheduling, transport, and response verification.
- `events.reconcile`, `view.reconcile`, `view.fold`: shared evidence propagation and affected-message work.

`pnpm exec vitest run src/features/relay/traffic.integration.test.ts --silent=false`
exercises first-versus-subsequent send latency, 2,400 retained rows, echo-before-ACK,
stale-read races, edit rejection, automatic retirement, restart, and asynchronous
storage disposal. It asserts exact fold work and unaffected identities, plus a
50 ms synchronous-send regression guard; elapsed measurements are machine dependent.
`live.test.ts` exercises authenticated subscriptions, signature rejection, reconnect
and disposal. These tests use ephemeral keys and local transports; no live messages
are posted by validation.

For reusable JSON artifacts, set `RELAY_PROFILE_DIR`:

```sh
RELAY_PROFILE_DIR=/tmp/relay-profiles pnpm exec vitest run src/features/relay/traffic.integration.test.ts src/features/relay/broker.integration.test.ts
```

This writes `history.json` (elapsed send time and exact work counts) and
`broker.json` (real local HTTP through signing, broker authentication, deliberately
slow first upstream publish, receipt validation and ID read-back). Upstream calls
are injected local fixtures, so these integration tests cannot post to the live relay.
`tests/fixtures/relay-storage.html` additionally exercises actual browser IndexedDB migration,
incremental status updates, deletion after restart and partition isolation.


### Upstream connections

The dev broker uses a long-lived connection pool (60 s keep-alive) with cached
DNS. Community discovery is lazy; production does not schedule periodic warm-up
requests. Connection reuse can avoid repeated DNS + TCP + TLS work, but does not
guarantee a warm socket or stall-free sends. Connect attempts have a 2.5 s timeout
and retry once for configured connect-phase errors only, before the request is
sent; these failures return `502 {sent:false}`, which the transport
treats as a definite non-delivery (`failed`, retryable) rather than `unknown`.
A browser that abandons a request also cancels the upstream request. The outbox
tracks each delivery as one `Attempt` record (deadline, intent write, controller).

### Delivery review follow-up

Verified echoes now release their delivery slot immediately, including when the
publisher ignores cancellation. Durable commits take their snapshot after journal
hydration, so a timed-out first operation cannot temporarily overwrite restored
intent. Signature batches share a `MessageChannel` yield with transport reads to
avoid nested-timer delays. `tests/fixtures/relay-startup.html` measures cold/warm sends with
512 restored signed records and actual IndexedDB, using only local test identities.
See [the archived query and delivery review](archive/foundation-review.md) for dated
measurements, and [current limits and deferred choices](status.md#known-limits-and-deferred-choices)
for outstanding work. These manual fixtures are not part of `pnpm test`; see
[fixture setup](contributing.md#manual-browser-fixtures).


## Live coverage and quota recovery

The session's `live` capability exposes connection/route state independently from
finite-read readiness. A connected socket is not proof that every route is live.
Global profile and self-scoped membership-hint routes are separate from explicit
channel subscriptions. One socket supports at most 1,020 channels (1,019 with the
agent observer), reserving two globals and two presence handover slots within the
1,024-route ceiling. Omitted routes and partial roster coverage remain visible.

EOSE establishes streaming, **not complete historical replay**. Retained channel
windows get finite, signed-bounds head catch-up after establishment/reconnect;
unopened channels defer it until demand. `live.snapshot().heads` distinguishes
pending, verified, deferred and failed obligations. Verification covers the
bounded current head, not all history or every event missed while disconnected.
Catch-up merges into paged readers without resetting older pages or their cursor.

`live.snapshot().roster` reports the finite channel-list refresh obligation,
including failures when no channel is selected. The store owns that obligation,
the optional metadata read, and its learned retry time; live Retry and diagnostic
Refresh channels share the same cooldown. Metadata failure never revokes successful
membership authority. Hints during an active read coalesce into one follow-up;
a refused read retains the obligation without draining queued work. Live Retry
retries failed/deferred work, not every successful refresh or healthy subscription.

The outbound host owns separately paced WS and HTTP lanes for each canonical
community/viewer. Browser POST replacement does not reset learned pauses; signed
requests enter HTTP admission after asynchronous authentication, at actual fetch
dispatch. Read/write priority and cancellation cross the reader/transport boundary.
Long pauses surface recoverable errors rather than occupying queued-read deadlines.
Admission is local coordination, not a reservation of the relay's account-wide
budget: other processes/clients can still cause a refusal. Ambiguous publication
outcomes retain their exact signed event and are never transparently re-signed.

The browser broker streams SSE over POST with bounded interests and owner-scoped
retry/priority controls. Retry preserves the existing upstream socket and healthy
routes. An actual change of channel interests still replaces the bounded POST;
that is distinct from retry and preserves the host's pacing/cooldown. Development
HTTP/1 streaming uses a close-delimited response to avoid WebKit stranding trailing
chunked frames until later traffic. This is not a new replay-completeness guarantee.


### Optional presence transport

The live subscription exposes a separate, explicit `presence` capability: update
at most 256 full author keys or publish bare `online`/`away` kind-20001 events on
the same authenticated socket. Confirmed and candidate routes overlap during
handover. EOSE establishes the route, not a presence snapshot. Publication resolves
only for a matching WebSocket OK; timeout, cancellation or owner disposal is not
proof of Offline or non-delivery. There is no durable outbox entry, heartbeat
schedule or automatic publication replay in this transport owner.

Presence has separate bounded capacity and start clocks, so it does not consume
ordinary reader slots or advance ordinary HTTP/WS pacing. Ordinary ready HTTP/reader
work wins; WS presence yields to foreground route setup. Actual relay cooldowns
remain shared. Presence snapshots/publications have a
five-second start interval; presence route setup has a one-second interval.
Ownership survives cancellation until outstanding signing/body work settles.
Only one finite filter containing exactly `kinds: [20001]`, unique full `authors`
and `limit: authors.length` qualifies for optional HTTP capacity. A caller-supplied
priority cannot grant that classification. The broker implements optional HTTP
admission and explicitly advertises `presence: true` with live support. The
application composes that adapter. The alternate direct-signed adapter keeps
ordinary reads/writes and the shared socket owner but does not advertise complete
presence support or classify optional HTTP reads. Feature composition must require
the explicit transport flag rather than infer support from `subscribe`.

These transport capabilities alone do not enable session observation, renewal or
UI indicators. With no presence caller, explicit live Retry can send an empty-author
`/stream-presence` control but creates no presence REQ or publication. The reserved
route capacity above applies even before feature activation.

Owning coverage lives in `presence-live.test.ts`, `reader-presence.test.ts`,
`transport.test.ts` and the broker/admission suites.
`dev/relay-broker-fixture.test.mjs` drives eight production broker transports for a
full reference quota window through real local HTTP and the existing policy relay.
It checks combined upstream quota charges (including rejected attempts), loaded
throughput and correlated WS cooldown with independent API progress. Exact start
clocks remain covered by deterministic admission/live tests. `dev/policy-relay.test.mjs` exercises modeled quota overload and expiry once
under Vitest, not once per browser engine. Controlled local budgets do not reserve
account-wide relay quota or establish deployed latency.

### User attention during recovery

The warning banner is for failures needing attention. Routine setup and bounded
automatic WebSocket quota recovery stay in Conversation options → Diagnostics.
A supported quota refusal remains recorded while waiting/retrying and is cleared
only by fresh EOSE, not by sending another REQ or clicking Retry. Diagnostics
labels the original rejection as historical text, not a live countdown.
Exhausted attempts, unsupported pauses, other route/connection failures and
unfinished finite roster/head failures still show a warning and recovery action.
This presentation policy does not increase quotas or guarantee that another
client sharing the account cannot cause a refusal.
