# Channels, relay data, and plugin panels

## Run the integration

Configure your public `BUZZ_DEV_VIEWER` pin in `.env.local` using the
[development setup](../README.md#relay-channels), then run `just web` or
`just desktop` (one at a time); the development broker starts with the dev server.
Add a community using the top-left community switcher, open Messages and click a supported GitHub URL in a message to open its object
in a side panel. Pull requests show title, state, author, branches, change counts,
and description; issues, commits, and repositories show their relevant details.
The panel reads GitHub's public API on demand. Private or unavailable objects and
API limits show an explanation with a direct GitHub link. File and branch links
continue to open normally. No GitHub account connection is configured yet.

On desktop, an ordinary click on an unhandled HTTP(S) link with
`target="_blank"` uses the native Tauri opener to launch the default browser,
including attachments and **Open on GitHub**. A plugin that handles the click prevents that fallback; disabling
GitHub restores it. The main-window capability allows only HTTP(S) URLs, not
arbitrary file paths or application commands. Web keeps ordinary browser link
behavior. Adding the native opener requires rebuilding/restarting desktop;
frontend hot reload alone is not enough.

Settings independently enables/disables Channels and GitHub. Disabling GitHub
removes its link handler and open panel; shared channel data remains available.
Disabling Channels removes its page while the app-owned data survives.

The broker uses the existing authorized Buzz identity in the macOS Keychain and
signs authenticated reads and channel messages in Node. No private key reaches browser JavaScript; there is
a bounded message-signing and publishing endpoint. The broker is restricted to loopback hosts, same-origin
POSTs, valid Nostr kinds/event IDs, and bounded filters. Without a configured `BUZZ_DEV_VIEWER` pin, the shell and Messages empty state remain available, while the live identity/join flow explains that it needs the development broker. Packaged builds do not include the development broker.
The broker supports explicitly scoped typed relay origins;
see [destination routing and trust limits](communities.md#development-broker-boundary).
This is not a new native login.

## Ownership

- `app/services.ts` constructs client/community, pages, and panels services.
  See [community ownership](communities.md) for selection and join lifetimes.
- `features/relay` owns the [session query core](relay-queries.md), shared profiles,
  and retained channel snapshots. Components use
  its React hooks without creating connections or owning persistence.
- `features/panels` owns target resolution and panel rendering. Panels receive
  `{ target, close }`; their plugins inject additional capabilities as needed.
- `features/messages` owns reusable `ChannelTimeline`, `MessageRow`, `ThreadPanel`,
  `MessageComposer`, delivery presentation, styles and reading geometry. They accept
  ordinary props over the shared session; none owns a connection or outbox.
- `bundled/channels` owns page registration, channel selection/navigation, sidebar,
  diagnostics, layout and panel placement. `shared/view-state.ts` partitions persisted
  drafts and view intent by community/viewer scope.
- `bundled/github` registers and implements the panel. Channels uses the panel
  contract and does not import the GitHub implementation.
- `plugins/contributions.ts` owns registration identity, readiness, and disposal
  for both extension points.

See [plugin architecture](plugin-architecture.md) for the authoring contracts.
To build another page, follow `bundled/channels/index.tsx`: declare injected
capabilities, register the page, and pass those capabilities to its React tree.
Keep page-specific navigation and arrangement in the plugin; compose shared message
components rather than copying them. Session reconciliation, authorization, retained
reads and durable outbox recovery remain host-owned even if Channels is disabled.

The workspace React key includes community/viewer scope **and** connection
generation. This resets session-owned component state on switching or reconnecting;
drafts, channel selection and reading geometry retain their stable scope keys.

Saved sidebar groups, ordering, assignments and stars live in the session's
`sidebarPreferences` snapshot, not in the mounted Messages page. `ensure()` shares
one initial read; `refresh()` explicitly reloads/retries while retaining the last
good snapshot through loading/errors. Page exits neither restart nor cancel that
read. Cache clearing and session disposal cancel it and discard decoded data;
late completion cannot repopulate a retired snapshot. These are account-owned
preferences, not channel access grants: sidebar sections still intersect the
authorized roster. There is no new disk cache or automatic cross-device sync.

The browser/development host exposes narrow **assign/remove group** and
**Star/Unstar** commands. Each re-reads the viewer's signed encrypted coordinate,
changes only the requested entry, publishes through the shared relay admission
lane, then re-reads to confirm the requested state. Unrelated fields and explicit
unstar tombstones are retained. Invalid/unreadable/over-budget heads fail closed;
only a successful absent-head read can seed a coordinate. Same-host writes are
serialized per relay. This is confirmed whole-record replacement, not atomic
cross-device merging, a durable pending outbox, or automatic retry: simultaneous
writers on different hosts can still race. Failure retains the last fully confirmed UI
placement and offers an explicit retry; a failed confirmation may follow a
publication that reached the relay.

The session preference owner serializes local commands and fences refreshes,
caller cancellation, cache clear and disposal. `session.ts` only composes host
capabilities with session lifetime and a bounded deadline. Cache clear cancels
pending work but cannot retract a publication already accepted by the relay.
Stream rows expose these actions by right-click/long-press, Shift+F10 or the
Context Menu key. Menus remain open during saving and failed-save retry; confirmed
relocation expands the destination and restores focus by channel identity. Starred
is a built-in group pinned first, offered alongside saved groups in one "Move to…"
chooser. Placement is exclusive. "Remove from Starred" and "Remove from [group]"
return to Channels, never to a remembered group. Moving out of Starred directly
into a saved group is supported.

The legacy format still stores stars and assignments separately. The preference
owner confirms the requested assignment (or its removal) **before** clearing Star;
removal always checks the fresh assignment head, not just the cached projection.
Only the complete move updates local placement, and refreshes cannot expose an
intermediate write. If the second write fails, the channel remains Starred and an
explicit retry finishes the move; a reload reflects whatever reached the relay.
This is ordered two-record persistence, not an atomic multi-device move. A prior
assignment may remain stored while starred but is never used as an Unstar target.
Forums/DMs, group CRUD/reorder and independent sorting are outside this slice.
Hosts without the write capabilities retain the read-only projection.

Search, collapsed section keys and sidebar scroll remain separate, scoped view
intent. They are saved on page exit and restored before paint when the roster and
groups are available; navigation history does not own them. The saved-groups
browser regression records every visible return frame and holds the redundant
decode path, so eventual restoration cannot conceal a fallback-group/scroll jump.

## Performance and correctness carried from Astra

The port retains the prepared-store implementation and its behavior tests:

- 64 prepared heads / 4 MiB serialized memory budget, separate from history.
- Three unpinned history windows; each caps at 2,400 rows or 8 MiB. Mounted readers
  are not evicted by speculative preparation. A budget cap is distinct from EOF.
- Three read slots, at most one background request, with foreground promotion and
  deduplication. Hover/focus prepares at most one speculative head at a time;
  superseded hints do not form a backlog. That shared head keeps foreground
  priority so selection cannot inherit a host-side background wait. Discovery
  restores authorized disk heads immediately after roster authorization, without
  waiting for optional channel names, and does not fetch heads across the roster.
  Verified heads save before optional profile enrichment; changed profiles can
  enrich the disk record afterward. Network reads belong to intent, selection and
  retained-window live catch-up. Optional profile enrichment stays background.
  Selecting an already-queued catch-up promotes that existing read without adding
  a request or resetting its deadline.
- 1,024 profile entries / 2 MiB signed-record budget, narrow row profile selectors,
  and request-warmed avatars (fetched and decoded, nothing retained; disabled
  under the Save-Data preference). Signature verification yields in batches.
- Account/relay-scoped IndexedDB: 64 records / 8 MiB global disk budget, 24-hour
  expiry. Cached events are reverified only after fresh roster authorization.
- A 60-second head freshness lease; warm revisits reuse heads without new reads.
  Partial discovery never treats an omitted channel as a membership revocation.
  Explicit denial or signed membership removal invalidates private cached views.
- Conventional top-down virtua timeline, prepend anchoring, near-bottom following,
  and three cached geometries keyed by session, channel, content, profiles, and width.

Connection generations and store epochs reject late results after disconnect,
replacement, disposal, or access revocation. The data service outlives plugin
components; it is disposed with the app runtime.

## DM label recovery invariant

Access-loss purges remain authoritative: never keep old profiles just to preserve
sidebar names. After roster membership changes, visible DMs must reacquire their
missing names through the shared profile directory at background priority, without
blocking conversation opening. Recovery must cover both loaded profiles being
purged and an initial profile read being cancelled before any name arrives.

`ChannelsPage` passes the **full** roster to `useChannelLabels`; the hook filters
visible conversations for display/profile demand, but derives its recovery trigger
from all channel IDs. Deleting an already-hidden or archived channel can still
invalidate shared profiles. Missing-profile and membership keys remain stable on
ordinary message/preview updates: missing/failed responses must not start a
render-driven request loop. Key fragments remain the fallback for unavailable names.

`useChannelLabels.test.tsx` binds the mounted hook to real session roster omission,
including hidden/archived deletion, stale in-flight replies and unsuccessful name
reads. `tests/browser/dm-labels.spec.mjs` guards the production page wiring and DOM
labels through the real Refresh channels control and broker. These are foundational
recovery constraints, not a new shared-session API or a guarantee of general
profile retry after every cache clear/network failure. See [browser coverage and
limits](browser-testing.md#dm-label-recovery).

## Membership activity

Channel history and the existing live route include relay-signed kind-40099
`member_joined`, `member_left` and `member_removed` summaries. Only recognized,
channel-scoped payloads from the connected relay become activity rows; malformed,
unknown and other authors' summaries are not rendered as JSON. These events do not
grant/revoke access: the existing signed roster remains authoritative.

The timeline groups adjacent arrivals/departures into compact avatar-and-text rows.
Messages, local-day changes and gaps over an hour break groups; removals by different
actors stay separate. Same-adder additions use “added by you” for the viewer;
mixed arrivals do not invent an adder. Grouping is presentation-only: signed event
IDs, pagination cursors and retention budgets remain per event. Profiles reuse the
shared background directory/cache, and reading anchors can resolve a member of a
group. Activity has no message actions, thread, unread evidence or chat preview.

An already-running development broker needs a coordinated restart to load the
expanded live filter; frontend hot reload alone changes only the history/rendering
path. No native or relay changes are required.

## Viewing threads

Click a message's reply count to open its root and replies in the right column.
Up to three overlapping participant avatars appear beside the count, with `+N`
for additional summary participants; missing/unavailable pictures use initials.
They reuse the channel's existing shared profile/media path, not extra per-row reads.
The panel automatically traverses the reader’s bounded history range before initial
bottom positioning; there is no Load more replies button. A prior user scroll gesture
wins. New replies arrive through the existing session and the panel follows while
near the bottom, preserving reading position when scrolled up. Sending a reply is
explicit navigation intent and reveals the new local row.

**Long-thread limitation:** traversal is oldest-first, capped at ten pages of 50.
Bottom means bottom of returned history, not necessarily the newest reply in a long
thread. A limit notice is not a completeness claim. True newest-page opening needs
a relay query extension; automatic traversal alone does not solve that requirement.
The thread and a linked object panel share that slot; a companion can remain below.
Close or Escape returns focus to the reply button when it is still mounted. Changing
channel/community or disabling Channels disposes the owned thread view.

The footer reuses `MessageComposer` and sends direct replies to the resolved root
through `session.messages.reply`. Channel and thread drafts are separate and survive
reconnection; failed replies remain inline with the shared retry action. Read-only
connections keep the existing composer capability notice; missing/revoked roots do
not expose a composer. Exact navigation can retain and focus a selected reply
beyond the traversal range; it does not extend that range or promise complete history.

Replies use ascending timestamp/event-ID order, including nested replies. Retry
appears only after a failed read; there is no routine Refresh control. Names are
optional shared background enrichment. The panel describes **replies shown**, not
complete history.
The relay can filter rows after its limit, and summaries/EOSE are not proof of
exhaustion. See [the thread owner and bounds](relay-queries.md#thread-views).

## Validation and limits

`just scan` runs frontend checks/build, runtime/CLI tests, relay behavior tests,
panel lifecycle tests, GitHub parsing/API tests, headless Chromium/WebKit scroll
journeys, and native checks. See [browser setup, structural limits and diagnostic
measurements](browser-testing.md). Reading intent includes a message anchor for
cold/oversized geometry; legacy positions or anchors outside retained history fall
back to an offset without a same-message guarantee.

Channels supports plain-text Markdown authoring with a shared durable outbox and bounded history.
Channel and thread messages render CommonMark plus GFM headings, emphasis, lists, quotes,
tables, task lists, strikethrough and code, while preserving chat-style single line breaks.
Only credential-free HTTPS links are active; raw HTML is ignored and inline remote images
are not loaded. Existing image Markdown is projected as an attachment instead. Custom emoji
remain event-local and are not substituted inside links or code. Authenticated live traffic
reconciles through the same session. Channel creation and composer preview/toolbars are not
implemented. Reply counts open a bounded thread view; attachments are links. Routine freshness
labels are not shown; Conversation options → Diagnostics
exposes refresh, outbox inspection and timings. Packaged builds do not
include the development relay broker. GitHub fetches public data only; signed-in
GitHub actions remain on GitHub. A saved-groups/stars failure keeps its specific
reason under **Conversation options → Diagnostics → Saved groups and stars**.
`Preference query` includes reader queueing, transport and verification; use relay
timings to separate those. `Preference decode` identifies the local decoder stage.
The diagnostic does not trigger another request or change retry policy.

Sending appears immediately in the timeline and shared channel-preview data;
the current sidebar does not render preview text. Delivery
status and retries come from the [unified relay session](relay-queries.md), and a
stale read cannot erase the retained local operation.

Use `session.messages.send(channelId, text)` for channel messages or
`session.messages.reply(channelId, resolvedRootId, text)` for thread replies. Confirmed sends
leave the pending outbox automatically and remain in bounded retained data.
**Outbox → Relay timings** captures and exports stage timings, including in-flight
signing and publishing, without logging message content.


## Reusing conversation UI

Source plugins can import from `features/messages` without depending on bundled
Channels. Pass the current `RelaySession`, stable community/viewer `scope`, channel
identity and navigation callbacks. `ChannelTimeline` also receives the current
`ChannelWindow`; `ThreadPanel` owns allocation/disposal of its thread reader.

`ChannelTimeline`, `ThreadPanel` and `MessageComposer` reset their internal state on
session, scope or destination changes. Callers may retarget ordinary props without
supplying React keys; old thread evidence, scroll state or drafts cannot pair with
a new destination. Persistent draft keys remain `draft:<channelId>` and
`draft:<channelId>:thread:<resolvedRootId>` inside stable scope, not connection generation.
`MessageRow` receives folded data, profiles/media and optional reply/retry callbacks.

This is shared source composition, not a new registry or versioned external UI SDK.
See `tests/fixtures/messages.tsx` for a second consumer that deliberately supplies no
caller remount keys. Its browser regression runs real React StrictMode/session/outbox
with local ephemeral signing keys; it does not contact the deployed relay.

## Community emoji

The smile button in channel and thread composers opens Emoji Mart with standard
Unicode emoji, skin tones, and the selected community's custom category. Its data
and search load only when opened. Search by name/shortcode, then choose an emoji
to insert at the cursor; Enter selects a search result and Escape closes the picker
and returns focus. You can also type `:shortcode:`. The picker follows the host
Light/Dark choice, including while already open, without recreating its search or
dictionary. It does not independently follow the operating system.

The session owns the catalog and its live updates. Reopening reuses the ready
catalog, without hiding custom results behind a fresh read. Catalog failures expose
Retry while leaving Unicode available and retaining drafts. Only one picker owns
Emoji Mart's global dictionary at a time; scoped custom IDs and disposal prevent
old community entries leaking into search or Frequent. Historical messages and
existing reactions keep their signed emoji URLs after catalog changes.
Emoji-only messages stay at the large 42px size regardless of count; normal text
returns the message to its usual size. Long runs wrap instead of shrinking.
Selecting and copying custom emoji preserves their `:shortcode:` in plain text,
along with surrounding text and line breaks. Pasting into a community with that
emoji available resolves the shortcode through its existing composer catalog.
In the composer, Shift+Left/Right selects each rendered custom emoji as one unit,
preserving its full shortcode for copying, replacement and deletion. Reversing
direction shrinks the selection by one emoji. Visible shortcode text and emoji
that cannot be rendered retain ordinary text selection.
Custom emoji autocomplete adds no trailing space. The native caret uses the
regular composer text size while the emoji preview remains large.

Message and thread reaction rows have a Lucide smile-plus button after existing
reactions. Messages without reactions do not show it. The Emoji plugin supplies
the emoji-only picker
through its optional conversation tool `reactionComponent`; the shared message
row owns publication. The picker opens outside the scrolling list, closes on
selection or Escape, and returns focus to the plus button. Failed or unconfirmed
reaction delivery offers Retry reaction through the same outbox. Read-only
connections and archived channels do not expose the action.

The composer shows its GIF tab as soon as relay support is confirmed. Unsupported
results are retried when the picker reopens; the broker caches confirmed support
without retaining negative discovery results. Pickers
without tabs use a search radius equal to the container radius minus the 10px
inset; tabbed pickers keep the smaller 8px search radius.

Emoji uploads and management remain in the existing community workflow.

See [the shared catalog/send contract](relay-queries.md#community-emoji). The local
`/tests/fixtures/emoji.html` diagnostic uses ephemeral identities and no live relay.


## Unread badges and reading intent

The sidebar renders the session-owned [unread capability](unread.md): observed
counts, not exact relay totals. Selecting/preloading a channel is not reading.
Focused, fully visible, settled timeline/thread rows receive an individual marker
after dwell; no automatic channel-prefix advance hides unseen siblings. Conversation
options exposes local-only manual unread, explicit mark-through and sync recovery.
Older synchronized hints may expire under bounded retention. Synced manual-unread
and OS notifications are not enabled by this feature.


### Attachment layout and scrolling

Image attachments reserve their preview geometry before loading and across virtualized
row remounts. Valid `imeta dim` metadata supplies the aspect ratio, bounded to 360px wide
and 320px tall without upscaling. Missing/invalid dimensions use a stable 360:320 frame
that shrinks with the available width; the image is contained without cropping or
upscaling. Unknown-size images may therefore have empty space in the frame. Loading,
failure, or retry does not resize it or force an above-bottom reader to the newest row.
Valid message-carried `imeta blurhash` is decoded locally into a 32×32 canvas in
that same frame when it intersects the viewport. No thumbnail is fetched. The
preview is removed entirely (including behind transparency) only after the lazy
original decodes; failure retains the preview. Missing/invalid hashes or canvas
failures keep the existing background. Syntax validation bounds hashes to 166
base83 characters / 9×9 components; folding does no pixel work. Preview work is
per-mounted-image and uncached, visibility-gated even in nonvirtualized threads.
Without IntersectionObserver, only the ordinary placeholder/original is used.
This favors bounded visible work over instant offscreen previews on scrolling.
`tests/browser/image-scroll.spec.mjs` covers delayed/failed loads, actual remounts,
bottom following, reading anchors and narrow layout in Chromium and WebKit.

## Opening an exact message

Message-addressed conversations reuse the normal timeline and thread panel. A
verified, loaded top-level target is revealed in the timeline. An off-window
message opens as the root in the existing thread panel; a reply opens there with
its actual root and bounded surrounding replies. No around-message channel query
or separate detail screen is added. The presentation choice stays fixed for that
navigation attempt; exact reads do not insert isolated old rows into channel history.

Navigation completes only after the exact folded target is visible and focused.
Reclick/Back reveals again; live/profile updates do not steal focus. The shared
rows preserve Markdown, profile links, composers and background enrichment.
Opening never marks read directly: the ordinary focus/visibility/dwell hook applies.
Missing/deleted targets, access loss and failed reads expose failure/retry instead
of channel-head success. An accessible reply remains visible when its root is
unavailable, without a thread composer. See [the evidence contract](relay-queries.md#exact-message-navigation).
