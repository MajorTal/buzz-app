# Agents: current-Buzz compatibility V1

## Scope

V1 **reuses the current Buzz library and mentions existing agents in channels
and threads**. No migration to relay-only storage. Creation, editing,
add-existing membership, Save/recovery and all runner management are out of V1.

### Implemented compatibility view

- The live development broker (macOS and Linux) reads the installed Buzz library at
  `~/Library/Application Support/xyz.block.buzz.app/agents/managed-agents.json`
  (on Linux, `$XDG_DATA_HOME/xyz.block.buzz.app/agents/managed-agents.json`,
  defaulting to `~/.local/share`).
  It does not search/merge the separate `.dev` library, read agent keys from
  Keychain, write the file, run migrations, or call old loaders with side effects.
- Only definition ID/name, identity public key/name/definition link, and optional
  avatar artwork leave the host. Prompts, configuration, credentials and execution receipts are not
  projected. This is local library evidence, **not verified ownership**.
- Selected definitions remain one card each, including definitions without an
  identity. Exact linked keys remain available in each card’s identity disclosure, including namesakes; unlinked and
  unmatched identities use Custom agents/Other identities groupings. Unlike old Buzz's
  runtime-dependent representative selection, this read-only view shows all
  non-archived linked keys and has no profile/start action or running badge.
- Confirmed relay archives hide identity rows, not definition cards. Missing
  archive evidence is labeled; it does not erase the saved library. This is
  display behavior, never mention permission.
- One lazy host read per opening/Refresh; no polling or relay-directory startup
  scan. Concurrent host requests coalesce. Read caps: 8 MiB / 2000 records;
  malformed/missing files fail visibly without echoing their contents. The host
  projects from JSON, so private fields may transiently exist in host memory;
  there is no claim that JavaScript strings are zeroized. Browser reads time out
  at ten seconds and session disposal/cache/access/disconnect fences clear them.
- The page uses only `session.agentLibrary` and `session.archives`. Unused relay
  ownership/configuration readers and native recovery code have been removed.
- Avatars use saved library artwork, with initials on missing/failed images.
  Optional artwork accepts HTTPS without credentials or bounded raster data URLs,
  never file URLs or SVG data. Relay media uses the existing session media helper;
  CSP is unchanged. No extra profile scan or polling is added.

Source parity pinned at old Buzz `b9392d9d78744df365f9276e1ffe8c1baa5ea903`:
`desktop/src/features/agents/ui/AgentsView.tsx:221–253`,
`lib/catalog.ts:3–12`, `ui/unifiedAgentGroups.ts:16–47`,
`desktop/src-tauri/src/managed_agents/storage.rs:239–283`,
`types.rs:180–209`. Old `load_personas` can update builtins and write back; this
adapter deliberately only reads the persisted post-fold library. It does not
port builtin refresh, live runtime ordering or Teams.

### Ready-to-try workflow / remaining acceptance

Use the public `BUZZ_DEV_VIEWER` pin and `just desktop` from the
README; fixture/default startup cannot show the live local library. No private
keys in environment files. Keep existing Buzz running: this app does not launch
or supervise ACP.

1. Compare Agents with installed Buzz's selected library; Refresh after changing
   that library in Buzz. Stop state should not remove cards. Duplicate display
   names must retain distinct exact keys.
2. In a channel where the agent is already a member, select it from `@`
   suggestions and send a short prompt; confirm the reply from the same key.
3. Repeat in a thread and confirm the reply lands in that thread.

Browser fixtures cover library rendering/retry/session replacement and actual
channel/thread composer publication, **not a live ACP reply**. Manual feedback
reported a working live path, but a separately observed native/ACP trace,
packaged acceptance and the final integration gate remain outstanding. Earlier
envelope/fixture validation does not certify the later compatibility adapter.


## Exact channel-member mentions

The shared channel summary now exposes exact members from its existing verified
relay-authored kind-39002 roster, without a second directory or subscription.
The bundled **Mentions** plugin offers **Mention a member** in both channel and
thread composers through the shared conversation tool contract. The host retains
recipient intent, disclosure and removal even when the chooser plugin is disabled.
The picker shows keys alongside names (namesakes remain separate), reads optional
profiles only on demand, and keeps selected identity spans in scoped drafts.
Typing a name alone does not notify anyone. Editing a selected span removes its
notification intent. Native beforeinput ranges preserve untouched spans; missing
range evidence, IME/history edits and collapsed deletions clear selections rather
than guess. Even a same-text replacement drops the edited identity. Explicit recipient
chips show who will be notified and can be removed without deleting the prose.

`session.messages.send/reply` accepts up to 32 exact pubkeys and emits deduplicated
`p` tags. Selection never invites someone. Current roster membership is checked at
intent, before signing, and after signing before entering the transport publisher;
retry/restored signed intent uses the same publisher check. Before **each**
mention publication the session performs a bounded foreground finite read of this
channel's kind-39002 roster under the captured relay author. It never joins an
older in-flight read. Empty/failed/malformed evidence blocks dispatch; access,
connection and cache changes fence the read. A newer observed removal beats an
older response. Neither AUTH, route establishment nor the optional metadata-read
status substitutes for this preflight. Failed/capacity-limited live routes can use
the finite evidence while connected. One finite request per mention attempt is a
safety cost, not additional startup work or polling.

A first known local rejection is failed/unsent. Finite membership preparation runs
under the same outbox deadline but outside the dispatch phase: a timeout there is
unsent and starts no confirmation reads. The final synchronous scope/membership
check runs immediately before publisher entry, after all asynchronous preparation.
A blocked retry preserves prior
unknown/accepted delivery evidence and reports its retry error separately; the
first dispatched attempt may already have delivered. These checks are client UX safety,
not a substitute for relay authorization, a membership transaction, or the ACP
listener's own admission rules. Network changes after transport dispatch remain
possible. No ownership or running status is inferred from a member's name/profile.

Wire compatibility is kind 9 + `h` + exact `p`; direct replies also carry
`["e", root, "", "reply"]`. Existing buzz-acp owns mention admission, replay,
channel membership, pool wake and harness execution. This slice adds no wake loop,
process launcher, configuration save or agent invitation operation. The local library and archive display are not mention authorization.

Focused coverage: `mentions.test.ts`, `MessageComposer.test.tsx`,
`mention-draft.test.ts`, broker sign/publish integration and the real React journey
`tests/browser/mentions.spec.mjs` and `mention-edit.spec.mjs` (Chromium + WebKit,
fixture identities). `mentions-live.test.ts` exercises the actual subscription →
session → outbox path across reconnect, route failures, stale/failed preflight,
restore, optional name failure and unknown delivery. Live ACP
reply and packaged desktop acceptance are not established by these tests.


## Relay-scoped archive display

`session.archives` is a lazy read-only NIP-IA snapshot capability, independent of
page/plugin lifetime. The dev broker passes `archiveAuthority` only when the
community's NIP-11 advertises a valid explicit `self`; the legacy contact `pubkey`
fallback continues to serve existing reads but cannot authenticate archive state.
The host-supplied signed transport does not yet discover NIP-11 and therefore
leaves this capability unavailable. No secret crosses the browser boundary.

One fresh background read requests kind 13535 from that exact authority, limit 1.
The verified response must contain exactly one empty-content, protected snapshot
within 2 MiB. Missing/failed/malformed/oversized evidence is unknown, never an empty
active list. Invalid `p` keys are ignored and extra `p` elements have no semantics.
A successful snapshot replaces the entire list; newer timestamps / lower-id ties
win. A session-local ordering fence survives cache clear, without retaining old
archive contents; it is not persistent rollback protection across sessions/devices.
Access purge, disconnect, cache clear and disposal clear evidence and cancel work.
No startup request, periodic poll, event-union seeding or history filtering is added.

This is finite evidence, not a live archive directory.
My agents consumes it for display; the member mention picker relies on actual
channel membership, not identity archive filtering. `not-archived` means absent from the read snapshot, not online,
owned, authorized or guaranteed current at a later write. Archive/unarchive writes,
delta processing, native discovery and packaged/live acceptance remain separate.
Protocol source: old Buzz `b9392d9` `docs/nips/NIP-IA.md`, especially relay identity,
snapshot format and snapshot/delta consistency. Tests use the actual session and
HTTP broker/verified transport, including corrupted signature rejection.

## Current feedback round and deferred validation

Composer: grouped @/emoji controls on the left, circular send on the right,
quieter recipient chips and compact avatar suggestions. No placeholder actions,
rich-editor migration or changed notification semantics. Cards use squircle
avatars, short labels and expandable exact keys; no running/ownership badge.

This feedback round passes typecheck, targeted Biome, 118 focused adapter/session/
envelope/composer checks, and the Agents + channel/thread mention journeys in
Chromium and WebKit (4 browser checks). The agent fixture checks loaded artwork
and the exact-key disclosure. Locked Cargo metadata resolves for Apple Silicon
macOS after dependency pruning; no native compilation was run.
Broader scan/native/package checks and independent compatibility-adapter review
remain deferred until an agreed integration batch. Do not gate ordinary visual
feedback on them. Broader agent architecture proposals are outside the V1 scope.


## Raw Agent Activity plugin

**Agent Activity** is an independently toggleable bundled plugin. Compact
avatar/name/status rows sit below messages and above the channel and thread
composers. Hover/focus shows an owner-only summary; click, tap, Enter or Space
opens that exact agent's **channel activity** in the right panel, including work
in other threads. Optional names and avatars reuse shared background profile
queries; key fragments distinguish identities without profiles.

Thread indicators consume the existing kind-20002 typing signal with the resolved
NIP-10 root, not inferred observer turn IDs. The existing per-channel live route
carries it; typing bypasses ordinary history, unread and persistent caches.
Only identities already present in retained owner-visible observer records are
recognized. Typing before that first frame, or without telemetry publication,
is deliberately omitted; public typing alone does not establish ownership.

Typing expires eight seconds after its signed timestamp (future clock skew is
capped at receipt), swept by the existing one-second activity timer. Messages
clear only the matching agent/channel/thread scope and suppress delayed typing
for two seconds. Disconnect, channel-route failure, disable, access/cache clear
and disposal drop typing evidence. A fresh observer frame does not refresh it.

The sidebar shows a quiet working dot from fresh channel observer turns or
channel-scoped typing. Thread-only typing never becomes a channel fallback.
Observer records have no thread identity, so details remain explicitly
channel-wide. No harness change, new subscription, directory or timer is added.
The development broker loads subscription filters at startup: restart the
existing dev server once to receive typing; frontend HMR alone is insufficient.

A profile **View activity** action remains available before the first frame or
after a working chip disappears. It preselects the exact identity and originating
channel, not a thread. This action is not an agent/ownership badge and may show a
waiting state for identities with no published owner-visible telemetry. Shared
agents and new activity-view permissions are out of scope.

The **Channel** selector filters raw entries and working-turn counts, or shows all
channels including unscoped records. For a selected channel, batches are projected
as individual matching children, with the original envelope ID retained; displayed
child JSON is reserialized, not claimed byte-identical to the envelope. Unscoped
children are omitted rather than inheriting the enclosing batch's channel. The
all-channels diagnostic retains the exact raw envelope. Raw capture is unchanged.
Channels owns contextual panel placement and closes it on channel/session or
contribution changes; close returns focus to the originating control if retained.

The plugin's activation leases `session.agentActivity`; closing the panel does
not stop capture. Disabling it releases demand and clears RAM. The shared live
connection carries one dedicated `#p=viewer` observer route, with no `#h`, history
limit, or replay: `since` is stamped at actual dispatch and retry. It reserves one
of the shared subscription slots. Successful toggles/access clears replace only
that route, not the socket or chat globals. An uncertain control failure can
reconnect the shared stream through its existing bounded recovery path.

`dev/agent-observer.mjs` performs signature, exact telemetry tag, recipient/key,
freshness and size validation before host-only NIP-44 decryption. The browser
receives a purpose-bound DTO, not keys or a general decrypt API. The relay's
admission establishes agent ownership; a name, local library entry, or successful
decryption alone does not. Observer records never enter ordinary history,
message/unread reconciliation, or disk caches.

Retention is session-owned RAM: at most 200 envelopes / 2 MiB plaintext and 512
turn states, with visible trimming. Disable, cache/access reset and session
replacement clear it; generation fences reject prior in-flight deliveries. A raw
batch with a recognized denied channel is discarded as a whole.

Working is fresh per-turn evidence, not process status. Batch children fold
individually; `session_resolved` is activity, while `turn_completed`, `turn_error`
and `agent_panic` end the agent/turn pair even with a null session ID. Silence
beyond 30 seconds or disconnect makes work unknown, not stopped. Terminal state
retains a monotonic evidence timestamp through clock rollback and bounded eviction.
There is no agent-global sequence gate: producer sequences reset, skip and interleave.

### Try with an existing owner account

Use the [README's public-pin/Keychain setup](../README.md#relay-channels) and run
`bin/just web` (or `bin/just desktop`). Open the printed Local URL, choose
the agent's community and open a channel. Keep the existing Buzz runner
active, with telemetry publication enabled on the agent, then give it work. This
app does not start agents or turn publishing on. No records may mean publishing
is off, no new traffic, or an interrupted feed—not that an agent is idle.

For a contextual view, click the identity's avatar/mention in the channel, then
**View activity**. It preselects that exact key and channel; **Channel → All channels**
broadens the view. Alternatively, select an active agent above the channel or thread composer.
Expand raw entries, close/reopen the panel, and toggle
**Your profile → Settings → Plugins → Agent Activity** off/on. Re-enable starts
empty. The feed is live-only, best-effort telemetry: the producer coalesces/batches
and may elide oversized content. It is not a complete ACP transcript or archive.
The development broker supports this slice; packaged/native signed transport
without that broker reports unavailable. No runtime controller,
recording export or old transcript renderer is included.

### Evidence and remaining acceptance

`dev/agent-observer.test.mjs`, `dev/relay-broker-live.test.mjs`, and the activity/live
service tests cover signed/encrypted WS → host decode → SSE → actual session,
route generations, no chat reconciliation, terminal retention and stale controls.
`tests/browser/agent-activity.spec.mjs` covers the actual plugin, raw HTML
nonexecution, keyboard disclosures, agent selection, disable/re-enable and
light/dark layouts at 1280 and 390 pixels in Chromium and WebKit. Live retry and
plugin-launcher regression journeys also pass with the additional observer route.
These automated checks use only ephemeral identities and synthetic upstream
telemetry. The owner reported a successful live activity try on 2026-09-12 before
the mainline merge; this is feedback evidence, not an independently captured trace.

The full `just scan` passed at `1183b2624485dc1e6a12e86cece22eaf7513591c`
after merging main's Markdown and Terminal changes: 35 Node integration tests,
1,054 Vitest tests, 16 plugin-manager Rust tests, 274 Chromium/WebKit browser
checks (including measurements), 14 design-browser checks, 9 native Rust tests,
formatting, types, builds and Clippy. Independent source review found no remaining
merge-integration blocker. Channel-opening fixtures kept optional profiles held;
warm click-to-visible samples were 16.8–19.2ms in Chromium and 50–67ms in WebKit,
with no new head read, below the unchanged 100ms budget. These are local Apple
Silicon fixture measurements, not a live-network SLA.

Packaged/native activity without the development broker remains unsupported;
attended native/package acceptance and cross-platform CI are separate from these
local results.

### Composer-entry feedback rounds

The first channel-only pass added a generic plugin accessory below the composer.
On the uncommitted tree based on `d5877002e2e58a601e1f46dd67697356e665164d`,
TypeScript, changed-file Biome, all 1,121 root Vitest tests and eight focused
Chromium/WebKit activity journeys passed. This is historical feedback evidence,
not validation of the current snapshot.

The 2026-09-16 round moves compact activity rows above both composers, adds
exact-thread typing indicators and a quiet sidebar working dot, and preserves
plugin-owned capture and revoked target-opening callbacks. Multiple turns are
grouped by exact agent key. Stale observer evidence shows status unknown, not
completed; expired typing and ended turns leave the rows. Profile access remains.

On the uncommitted tree based on `a67102aa1201adfa47a03be7d668a62ac748c152`,
TypeScript, changed-file Biome, all 1,128 root Vitest tests (116 files), and all ten
Chromium/WebKit activity journeys passed. The Chromium cold/warm channel-opening
check also passed. Browser coverage includes exact-thread/sibling/channel
isolation, sidebar semantics, channel-detail navigation, above-composer geometry,
and light/dark 1280/390px layouts. Screenshots were inspected. Independent
changed-path source review found no ownership, routing or lifecycle blocker;
the subsequent future-timestamp expiry cap has a passing regression test.

Wes reported the live local workflow working and approved the tightened layout
on 2026-09-18. Activity rows are borderless, avatars align with the composer's
left edge, and the last row sits 4px above it. Working dots gently pulse unless
reduced motion is requested; unknown status remains static. Browser regressions
cover these presentation contracts in both engines.

The 2026-09-18 integration incorporates main `125b5ca` while retaining its rich
composer, routed-thread navigation, sidebar activity popover and public typing
indicator. Public typing and owner-only activity remain independent projections;
an owner's typing agent can appear in both. The receive path rechecks session
access/generation after shared typing subscribers run, before admitting activity.

On `65213eb` plus the resolved main integration, all 1,576 Vitest tests (150 files)
passed. Both engines passed the shared typing/layout cases (22), then the activity,
Buzz-link and thread-history cases (20) after fixing internal activity targets
being swallowed by the broader `buzz:` navigation classifier. Existing activity
cases failed before that fix in both engines. Accessory lifetime coverage now
mounts real React in StrictMode rather than mocking hooks.

These are targeted integration checks, not a completed `just scan`. The earlier
scan was interrupted during browser tests; broader hosted CI, DCO and required
review remain separate gates. Packaged native activity without the development
broker remains unsupported.
