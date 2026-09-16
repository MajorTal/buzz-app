# Account-scoped, server-directed synchronization

**Status:** Proposed direction from a product/architecture discussion, 2026-09-16.
Not an approved wire specification or implementation plan.

## Summary

The client establishes an authenticated connection and asks:

> Give me the current state and updates needed for my account. Here is my last
> checkpoint, if I still have its corresponding state, and here is what I am viewing.

The relay decides whether to send incremental changes or a fresh bounded snapshot,
then continues delivering live updates on the same connection. The client applies
the responses to shared read models. The server owns account routing, bootstrap,
and the transition from catch-up to live delivery.

This combines **snapshot + incremental updates + explicit reset**. A cursor is an
optimization and continuity mechanism, never the only route to recovery. Starting
with an empty cache must remain a normal, supported operation.

Separate startup HTTP queries are not inherently necessary. Older-history queries
can remain separate and demand-driven.

## Why this direction

The current client independently coordinates channel discovery, per-channel live
subscriptions, recent-history reads, caches, unread evidence, and reconnect repair.
Those are related parts of one synchronization problem, but the client must stitch
them together without a general server checkpoint.

The relay already knows durable channel membership. Asking the client to discover
that membership and enumerate a subscription for each channel duplicates routing
knowledge and creates a startup ramp. Moving account-level synchronization to the
server lets it choose between replay and reconstruction using information the
client does not have: retained change coverage, backlog size, and current access.

The objective is **simpler ownership and reliable recovery**, with reduced request
and subscription overhead as an expected benefit to measure—not a guaranteed
reduction in database work or transferred bytes.

## Relevant current architecture

These findings describe inspected source, not a verified deployed relay version.

- The relay is an event-centric Postgres application with channel indexes and live
  pub/sub, not a durable append-only consumer log. It also stores application state;
  deletion and replacement affect query visibility, and ephemeral events are not
  persisted.
- Durable channel membership differs from connection-local WebSocket subscriptions.
  Today the client requests filters for its known channels; the relay tracks those
  filters for that connection.
- Live events and finite query results enter shared client reconciliation and
  domain folds. React observes the resulting session-owned read models.
- The client starts one logical subscription per channel, spaced by 250 ms, with
  at most four awaiting establishment. There is one upstream socket, not one socket
  per channel. This delays full live coverage, not necessarily first useful paint.
- Ordinary live replay starts approximately five minutes before route creation,
  with a 500-event limit per filter. It is not driven by a persisted sync checkpoint.
- Recent channel history uses bounded HTTP window queries, including auxiliary
  events, summaries, and signed pagination bounds. The inspected client also warms
  channel heads across the roster in the background, starred first.
- Client retention is bounded: small recent caches, larger retained timeline
  windows, and a separate bounded unread-evidence collection. Being subscribed
  does not imply retaining a complete local channel replica.
- This client's unread badges combine observed messages with synchronized read
  markers; they are not authoritative server-provided total-unread counts.

Ordinary Nostr REQ already supports historical results followed by ongoing live
traffic. However, EOSE is not a durable watermark or proof of complete gap repair.
The existing `created_at`/event-ID history cursor is pagination, not a server-change
checkpoint. A late-arriving event can have an older signed creation timestamp.

## Proposed interaction

The following is conceptual, **not proposed wire syntax**:

```text
Client -> Authenticate and request account sync
          Optional checkpoint + corresponding retained-state scope
          Current viewing interests (for example, selected channel/thread)

Relay  -> Explicit response mode and covered scope:
          RESUME: bounded incremental changes after the checkpoint
          or
          RESET: fresh bounded state replacing the specified read-model scope

Relay  -> Caught up through checkpoint Y
          Continue delivering authorized live updates

Client -> Update viewing interests as navigation changes
          Request older history separately when needed
```

The relay may choose a snapshot when no checkpoint exists, the token is expired or
incompatible, replay coverage is unavailable, or replay would cost more than a
fresh snapshot. It must state what it chose and what the response covers. Silently
sending only recent events must not masquerade as complete catch-up.

### What “everything I need” means

Account sync is not a request for every historical message. Define a bounded
bootstrap/read-model contract. Candidates include:

- Authorized channel directory and membership state.
- Account preferences and available read-state information.
- Sidebar summaries appropriate to the product contract.
- Recent messages and supporting state for selected conversations.
- Subsequent account updates and changes to requested viewing interests.

The relay knows account membership; the client knows what it is viewing and what
it retains. Both pieces are needed. Whether to prefetch recent messages for other
channels is a separate policy decision, not an automatic consequence of account
sync. Exact server-side unread totals would be a separate capability, not something
this proposal establishes.

Broad account coverage also need not imply keeping detailed message state for
every channel. Inactive channels can use lightweight summaries or invalidations,
if those semantics are explicitly part of the contract.

## Correctness requirements

### 1. Defined snapshot/replay-to-live handoff

Changes during bootstrap cannot fall between the snapshot and the live stream.
The relay must provide a defined boundary or overlap protocol. The implementation
mechanism remains open; an uncoordinated query followed by subscription is not enough.

### 2. Checkpoints describe applied state

A checkpoint means “the corresponding state through this position is retained and
applied,” not “the client once received this event.” Durable resume requires saving
state and checkpoint atomically. If a relevant cache is evicted or lost, the client
must reset that scope or declare it missing rather than pretend the token covers it.

The checkpoint should be server-issued and scoped to the authenticated account,
community, and sync contract. It is neither a message timestamp nor a read marker.
A database sequence allocated before transaction commit is not automatically a safe
commit-order watermark.

### 3. Explicit replacement versus merge

Delta batches merge changes. Reset batches replace a specified slice of
server-owned read state, including removing stale entries. They cannot be a simple
union with the old cache, or deleted messages and revoked channels may survive.

Replacement must account for concurrent newer updates, and partial snapshot delivery
must not be mistaken for a completed reset. Local drafts, pending sends, and durable
read intent have separate ownership and must not be discarded with fetched caches.

### 4. Replay-safe application

Duplicates must be harmless, and older updates must not overwrite newer state.
Prefer versioned entity state, deletion records, or explicit invalidations over
unversioned arithmetic operations such as “increment this count.” Deletions,
replacements, and derived-state changes need defined reconciliation behavior.

### 5. Membership and access lifecycle

The stream must follow current authorization, not just the membership set present
when it opened. Joining a channel requires an initial state handoff; removal stops
unauthorized delivery and invalidates the client's retained private read state.
Replay must not bypass current access rules. Membership events cannot depend solely
on a channel route that disappears when membership is removed.

### 6. Bounded recovery and backpressure

Bound batches, buffers, and catch-up work. Slow clients, expired checkpoints, or
missing change coverage lead to an explicit recoverable reset—not silent loss or
an unbounded queue. A failed/reset connection must not falsely advance the checkpoint.

### 7. History and notification semantics remain distinct

A recent snapshot repairs its declared scope, not every older page retained by the
client. Older ranges require repair or invalidation when their freshness cannot be
established. Receiving replay/bootstrap data is also not permission to produce a
fresh notification; live delivery, reading, and user notification are distinct.

## Relationship to Nostr and industry patterns

This is an application synchronization contract, not a requirement to expose raw
database CDC. It does not require replacing Nostr storage, signatures, or event
formats. The relay can add account routing, snapshot/reset envelopes, and resume
semantics above existing event delivery.

Without Nostr, the same design would be appropriate: authenticated account sync,
bounded current-state bootstrap, replay-safe changes, explicit reset, and separate
history pagination. The transport could be WebSocket, streaming HTTP, or long
polling; the consistency contract matters more than the transport choice.

Two references inspired the direction:

- **[Matrix client-server sync](https://spec.matrix.org/v1.16/client-server-api/#syncing):**
  initial sync supplies recent room timelines and state, subsequent sync uses a
  `next_batch` token, and older history has separate pagination. Limited timelines
  explicitly represent gaps. This is the closest chat-specific inspiration for
  combining bootstrap and ongoing updates into one server-owned interface.
- **[Microsoft Graph delta query](https://learn.microsoft.com/en-us/graph/delta-query-overview):**
  initial state and incremental tokens share a synchronization workflow. Clients
  must tolerate replayed changes; synchronization can require a reset, including
  `410 Gone`, and tokens have limited lifetimes. This supports treating reset as
  an ordinary protocol outcome rather than a failure of the architecture.

These are precedents, not evidence of a universal industry mandate or a recommendation
to adopt either platform. The principle is resumability **with reconstruction**, not
an irrevocable commitment to consuming an endless log.

## Open decisions for a follow-on design

1. Exact bootstrap scope and whether inactive channels receive events, summaries,
   invalidations, or a combination.
2. Checkpoint granularity: account-wide versus independently resettable scopes,
   including how bounded cache eviction and changed viewing interests interact.
3. The backend mechanism for consistent snapshots, retained changes, and the live
   handoff; retention and replay-versus-reset policy.
4. How server-signed Nostr evidence and transport-level sync metadata compose,
   including protocol discovery/versioning and existing-client compatibility.
5. Whether cross-restart resume is worth its persistence complexity initially.
   The unified interface can support fresh bootstrap while that remains optional.
6. Success measures: time to selected-conversation readiness, time to full account
   live coverage, startup requests/bytes, server query work, and recovery after
   short/long disconnects or local cache loss.

No specific database technology, change-log implementation, wire schema, or cache
migration is selected here. Implementation requires a separate design and tests
covering replay, reset, authorization changes, and adversarial lifecycle ordering.

## Source references

### Client: `buzz-app` at `06737cc`

- [Session reconciliation and live lifecycle](../src/features/relay/session.ts)
- [Live filters, replay overlap, route allocation and pacing](../src/features/relay/live.ts)
- [Channel store, background warming and retained-window catch-up](../src/features/relay/store.ts)
- [Channel-window requests and pagination bounds](../src/features/relay/window.ts)
- [Disk-head cache](../src/features/relay/persistence.ts)
- [Unread contract](unread.md) and [unread implementation](../src/features/relay/unread.ts)
- [Relay architecture notes](relay-queries.md) and [channel ownership](channels.md)

At this snapshot, source includes background roster warming added by `3f824df`;
older documentation statements saying there are no all-roster head reads are stale.
The references above are repository-relative and follow the checkout; use the cited
revision when comparing with this discussion's findings.

### Backend: `block/buzz` at `4cd82f513214aad11c2b742ce7cc7c681e8e32a0`

- [Event schema and channel index](https://github.com/block/buzz/blob/4cd82f513214aad11c2b742ce7cc7c681e8e32a0/schema/schema.sql#L203-L272)
- [WS subscription registration, historical query and EOSE](https://github.com/block/buzz/blob/4cd82f513214aad11c2b742ce7cc7c681e8e32a0/crates/buzz-relay/src/handlers/req.rs#L285-L495)
- [HTTP query bridge and channel-window dispatch](https://github.com/block/buzz/blob/4cd82f513214aad11c2b742ce7cc7c681e8e32a0/crates/buzz-relay/src/api/bridge.rs#L1098-L1212)
- [Event storage, visibility and time-based pagination](https://github.com/block/buzz/blob/4cd82f513214aad11c2b742ce7cc7c681e8e32a0/crates/buzz-db/src/store/event.rs)
- [Replaceable-event storage](https://github.com/block/buzz/blob/4cd82f513214aad11c2b742ce7cc7c681e8e32a0/crates/buzz-db/src/store/replaceable.rs)
- [Redis pub/sub publisher](https://github.com/block/buzz/blob/4cd82f513214aad11c2b742ce7cc7c681e8e32a0/crates/buzz-pubsub/src/publisher.rs)

Backend findings came from local source inspection. The local `sprout-relay`
deployment packaging had an older default source pin, `fc1db46937632b4126a65678336e623234a6d238`,
with some different WS pagination support. Neither checkout establishes what is
currently deployed. Verify deployed capabilities before designing compatibility.
