# Presence

`session.presence` is a volatile current-value directory, separate from message
retention, generic event reconciliation, and the durable outbox. Its values are
`online`, `away`, `offline`, and `unknown`. Unknown is not evidence of being offline.

Message bylines distinguish status without color: Online is a filled circle, Away
is a filled square, Offline is a hollow circle, and Unknown has a dotted outline.
The profile panel also displays the status text; all indicators have an accessible label.

## Ownership and traffic

The session requires explicit transport `presence: true` and live support before
starting observation or publishing. The production broker supplies both snapshot
admission and shared-socket controls. Ordinary direct-signed reads remain supported,
but that alternate adapter does not enable partial presence through its generic
subscription. Unsupported transports stay Unknown and start no publisher/renewals.

- A timeline or thread owns one demand handle for its viewport plus a 160px margin;
  the profile panel owns its selected author. Avatar indicators only subscribe to
  per-author values. Repeated authors share work. Without IntersectionObserver,
  demand falls back to the bounded rendered window, not all retained history.
- A session accepts at most 256 unique demanded authors and 64 surface handles.
  Over-cap demand is rejected, not broadened. Empty or hidden demand removes its
  observer route and snapshot work; it does not stop the availability publisher.
- Presence shares the existing authenticated socket. Author interests have a
  one-second minimum REQ interval, at most two overlapping presence routes, and
  share the total 1,024 subscription-slot ceiling with normal routes. Presence
  updates do not restart the message stream and yield to foreground work. Two
  presence slots remain reserved; channel capacity is 1,020, or 1,019 when the
  independent Agent Activity observer is enabled.
- One background snapshot owner uses the existing verified reader. Reads have a
  five-second cooldown after completion or cancellation, not enqueue time: shared
  reader/broker queue delays must not compress successive actual reads. Repeated
  changes coalesce without moving an already scheduled deadline. Stable demand
  uses one 60–65 second backstop; failures wait at least 60 seconds and honor longer
  relay retry advice. These are per-session budgets, not a fleet-wide rate limit.
- Same-status renewals do not trigger a read or UI notification per heartbeat.
  Conflicting evidence becomes unknown and requests one rate-bounded confirmation.
  No separate socket, per-avatar polling, heartbeat journal, or durable replay.

## Foreground isolation

Optional presence does not spend ordinary dispatch credit or occupy ordinary
capacity. Limits are additive, not a claim that the old total concurrency is
unchanged:

| Boundary | Ordinary work | Optional presence |
| --- | --- | --- |
| Host/principal HTTP starts | 500ms minimum | 5s minimum snapshot interval |
| Session reader | 3 active, at most 1 background; 128 distinct pending | 1 snapshot |
| Development broker | 6 process-wide inflight | 1 process-wide snapshot |
| Host/principal WS starts | 250ms minimum REQ interval | 1s REQ / 5s EVENT minimum |
| Live setup per stream | 4 pending ordinary routes | 1 candidate presence route |

The shared host principal is keyed by relay origin and viewer, not by stream.
Foreground wins ready HTTP ties; presence setup/publication yields to foreground
setup. Two presence wires (confirmed plus candidate) remain inside the existing
1,024 subscription ceiling. Ordinary HTTP preparation and queue budgets stay 128;
one separate optional preparation lease spans signing, fetch/body and verification.
A cancelled consumer cannot free unresolved underlying optional work. The analogous
WS publication lease stays owned until signing settles, fences late completion,
and never makes ordinary signing wait behind the optional lease.

Snapshot classification requires exactly one filter with only `kinds`, `authors`
and `limit`: kind `[20001]`, 1–256 unique lowercase full 64-hex authors, and limit
exactly their count. Priority headers do not grant optional admission, and reader
normalization cannot upgrade malformed requests into that class.

Server API cooldown remains shared by ordinary and optional HTTP work; WS cooldown
remains shared across ordinary/presence work and streams. HTTP and WS quota families
remain independent. Presence must not bypass a real shared quota rejection.

The combined-budget test drives eight production broker transports over real local
HTTP for a full minute. The existing modeled relay charges all attempts across
callers and enforces first-call-anchored quota windows. Assertions allow at most
134 API charges/min, 27 combined REQ/EVENT charges per 5s, and 13 presence EVENTs/min
including setup and drain; lower throughput bounds prevent a vacuous pass. Exact
500ms/250ms/1s/5s start clocks are tested deterministically at their admission owners.
This bounds the modeled client-owned traffic, not requests from other devices or hosts. It is below the inspected reference defaults
(API300/min, WS50/5s, Messages60/min), not a deployed configuration guarantee. The
normal publisher still renews only every 60–65s, not every 5s. No local scheduler can
promise zero CPU, signer-provider, network, SQL/Redis cost or end-user latency.

## Authority and lifecycle

Live presence subjects come from the verified event author. Only a verified
relay-authored snapshot can use its single requested `p` tag as subject. A
successful bounded snapshot's omission means no current entry for that subject;
failed or obsolete reads do not establish offline. Snapshot `created_at` is the
relay's synthesis time, not heartbeat age or remaining lease duration.

Per-author lifetime/revision and session generation guards fence conflicts,
removal/re-add, visibility changes, access/cache clearing, and disposal. They do
not create a globally ordered snapshot/stream protocol. Exact expiry and perfectly
current status cannot be inferred from the existing wire contract.

Presence-only setup retries are bounded. After four failed attempts, unchanged
nonempty demand can remain Unknown across an ordinary socket reconnect. Emptying
and restoring demand resets that budget. Resetting it after fresh authentication
is a recovery follow-up, not a guarantee of this version.

## Activity and publishing

One app-level activity detector measures **Buzz input**, not operating-system
idle. Ten minutes without input produces Away (sampled every 30 seconds).
Window blur or switching communities is not Away. Each connected community/viewer
publisher sends its current status after startup, on status transitions, and
roughly every 60–65 seconds. It keeps one in-flight write and the latest desired
status; missed renewals are not replayed. Acceptance requires the matching socket
`OK`, not merely handing bytes to the broker.

If stream disposal wins an in-flight publication's settlement, the development
broker preserves that typed cause as `code: "presence_owner_disposed"` on its
existing **503 / Presence publication unconfirmed** response. This describes why
confirmation stopped, not whether an EVENT was sent or accepted. Earlier rejection,
deadline, socket reset, caller abort, or local failure cannot be relabeled by later
disposal. No new wait, retry, round trip, or successful browser outcome is added.

Browser fixtures record each publication 503 at the host response boundary,
including when browser cancellation hides its body or console diagnostic. Only
the explicit disposal code with the unconfirmed body is classified; every other
503 fails independently of console output. Classified responses permit at most
one endpoint-qualified console diagnostic each, and all responses remain in the
evidence. Host request completion records distinguish `finish` from `close` and
retain status/Server-Timing; neither closing a response nor handing bytes to the
host establishes relay delivery.

Optional same-origin Web Locks coordinate one publisher per community/viewer;
BroadcastChannel shares recent local input. Unsupported hosts can publish once per
window. A frozen browser leader can miss renewals; neither mechanism coordinates
other devices. Connected retained communities continue renewing after navigation.
Ordinary teardown never publishes identity-wide Offline on another device's behalf.

## Backend limits

This client changes no relay storage or aggregation semantics. The audited relay
still performs a community lifecycle SQL lookup for a WS heartbeat, access queries
for HTTP snapshots, and SQL/pool work for `REQ limit:0`. Snapshots also require Redis
reads and relay signatures. Author scoping reduces delivered traffic/client work;
it does not remove candidate subscription matching or all backend work.

The relay aggregates by identity with last-arrival-wins status, not device leases.
Pod-local final disconnect can clear another device's entry without offline fanout.
Removing these costs and ambiguities requires separate server work with preserved
authorization/lifecycle fencing; this implementation does not claim zero SQL,
zero polling, exact expiry, or distributed-device correctness.

## Validation shape

Owner tests live in `src/features/presence/` and relay presence tests. Browser
journeys are `tests/browser/presence.spec.mjs` (observer lifecycle and real same-origin
lock/activity handoff) and `presence-integration.spec.mjs` (production conversation,
broker, snapshots, conflict repair, and route teardown). The paired
`presence-contention.spec.mjs` / `presence-control.spec.mjs` measure real composer
send and cold-open admission with a held snapshot versus equivalent no-presence
owners. Colocated reader, broker and live tests separately hold capacity/signing
work; `dev/relay-broker-fixture.test.mjs` exercises combined eight-caller budgets; browser
journeys alone do not establish those bounds. `dev/policy-relay.test.mjs` proves that
the numerical quota fixture rejects deliberate overload. Channel-opening measurements
retain their existing warm-switch budget.

These browser tests use isolated identities and modeled relay policy. Passing
native compilation/tests is not native GUI acceptance; none of these establishes
deployed SQL/Redis load or production latency. See [the contribution workflow](contributing.md)
for batch gates and [browser testing](browser-testing.md) for measurement limits.
