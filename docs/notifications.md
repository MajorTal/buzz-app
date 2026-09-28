# Notifications

The host provides one `notifications` service for built-in messages and trusted
plugins. Settings → Notifications stores account-local choices: alerts are on
by default, subject to system permission; master off preserves category choices.
To pause all alerts and permission requests in a local dev server, set
`BUZZ_DEV_NOTIFICATIONS=0` in `.env.local` and restart the server. Only `0` pauses
notifications; unset or any other value keeps normal behavior. This development
gate never rewrites saved preferences. Settings shows the pause and how to remove
it; normal behavior still honors account choices and system permission.
Production builds ignore this variable.
Notification sound is app-owned on browser and desktop: Buzz bundles a set of
alert sounds under `public/sounds/`, and the notifications service plays the
per-category selection (with a shared default) in the running app after a
banner submission is accepted. OS banners are always submitted silent, so the
system never plays a second sound: the browser banner sets `silent: true`, the
Windows toast is built with silent audio (`sound(None)`), Linux Notify sends
the standard `suppress-sound` hint, and the macOS backend never sets a sound
name. Because a submission can resolve after state has moved on, the audio
decision stays under revalidation until the platform resolves it: any interval
of Sound turned off, alerts or the category disabled, or revoked
access/eligibility cancels the sound for good (without affecting the banner),
and the sound also requires the same live account generation and currently
allowed, eligible, Sound-enabled state when the submission is accepted.
Settings offers per-category sound selection with an in-app preview; the
Sound switch turns playback off without disabling alerts.

```ts
export const inject = ["notifications"];
export function apply(ctx) {
  const updates = ctx.notifications.register({ id: "updates", label: "Updates" });
  // In response to a real domain event:
  // await updates.submit({ sourceKey: event.id, target: typedOpenTarget });
}
```

Categories use existing installation ownership. Disabled/replaced plugins cannot
submit new alerts. A notification click belongs to the host; opening never enables
a missing destination plugin. `submit()` means a candidate was accepted for policy
checks, not that an OS banner was displayed or read.

## Running-app behavior

- Built-in mentions, DMs and participating-thread replies consume the selected
  community's verified live kind-9 and kind-40002 traffic and existing
  unread/visibility facts. Structured kind-40002 bodies use the same decoded text
  as message rows. No new socket, unread engine or background-community
  subscription is added.
- History, initial/reconnect replay and own messages stay quiet. Candidates older
  than two minutes (or over 30 seconds in the future) are ignored. Unknown read
  readiness waits; off/access loss cancels pending candidates. The app-global binding
  starts the shared bounded unread observation even without Channels mounted.
  Remote-capable hosts wait for the initial marker merge (bounded observation or
  complete snapshot); local-only hosts wait only for local storage. Failed or
  cancelled observation does not release alerts. Visibility is checked after UI
  presentation, without publishing read intent.
- Channel Mute/Unmute uses the session's confirmed, encrypted `channel-mutes`
  preference, independently of whether Channels is mounted. Muted channels suppress
  DM and participating-thread alerts; explicit mentions still pass the channel-mute
  gate, not global off/category/read/access/permission gates. This does not introduce
  a broadcast notification category or change unread badges. Unknown or failed
  preference reads hold non-mention candidates until explicit retry; a confirmed
  mute cancels pending candidates, including an in-flight permission check. Unmute
  does not replay cancelled alerts. Existing shown OS banners are not withdrawn.
  Hosts without preference decoding retain existing notification behavior; this
  slice adds no native preference adapter or automatic cross-device synchronization.
- Permission is requested explicitly from Settings where a browser needs a user
  gesture. A fresh pending candidate is reconsidered after Allow; a newer off
  choice still wins. Observable API errors are reported, never auto-retried.
- Running-session dedup is bounded to 2,048 source identities/two minutes; pending
  candidates are capped at 128. Browser presentation retains at most 128 active
  alerts, closing the oldest before retiring its callback. Desktop retains at most
  128 active callbacks/waits and rejects new presentations at capacity rather than
  evicting an existing target or queuing unbounded workers. These are not durable
  exactly-once or cross-window guarantees.
- Browser and desktop clicks use the existing typed, account/community-scoped navigation path. It owns
  membership/provider checks and exact opening. Changing account invalidates old
  callbacks; changing community does not turn an old alert into a dead click.
  Loaded top-level targets use the timeline; off-window targets and replies use
  the existing thread panel with exact scroll/focus. Clicks never mark a message
  read; normal focused, visible dwell does.

There is no notification database, Recent notifications UI, cold/reload receipt
protocol, uniform OS withdrawal subsystem, or closed-app push. Preferences are
persistent; notification candidates are not. Built-in message banners show the
sender and conversation plus a short, plain-text preview on both browser and
desktop. This sends those details to the OS, where lock-screen/preview settings
control their visibility. Titles use the current shared profile/channel cache,
with a key fragment when a name is unavailable; optional names never delay an
alert or trigger additional reads. Previews use at most the first 4,096 source
characters, flatten CommonMark to at most 200 Unicode code points, omit raw HTML
and link destinations, and label images without fetching them. Empty or overly
deep content falls back to “New message”. This is an arrival preview, not a live
copy of subsequent edits. Plugin categories without message details retain their
generic category text.

## Current acceptance limits

The browser adapter works only in a running tab with the Notification API.
Desktop builds use one small Tauri bridge into maintained native backends:
mac-notification-sys on macOS, the freedesktop notification interface through
zbus on Linux, and tauri-winrt-notification on Windows. Linux uses the already
locked zbus dependency directly because notify-rust's send-then-listen wrapper
can lose early actions. No dependency upgrade or new native FFI is needed.
Banner permission remains system-controlled; alert sound is app-owned and plays
in the renderer, not through the native backends. No permission-only plugin
or synthetic desktop notification is installed. The macOS Dock settings below
provide an explicit system authorization action. The main-window-only bridge
carries display text and an opaque presentation ID, never an account, credential
or navigation destination. Its Tauri response channel is registered before native
submission.

Desktop clicks restore/foreground Buzz and then call the existing activation
closure. macOS explicitly waits for a body click off the UI thread (the generic
notify-rust wrapper omits that flag). Windows retains its callback when the
banner fades, because timeout is not removal from Notification Center. Linux
requests the standard default action and checks that the notification service
supports actions. A single, sender-filtered receiver is armed on the same D-Bus
connection before Notify. It is drained while the reply is pending; first terminal
responses are retained by ID (maximum 128 distinct IDs, including other apps'
broadcasts), then correlated with the returned ID. Overflow reports failure and
releases capacity; this is not proof that Notify was never displayed. GTK's
standard present operation shows/restores/raises the window without the
framework's stale minimized-state focus guard. Compositor
focus policy still applies. Dismissal never navigates. Observable send/focus
failures reach Settings without retry; a focus error does not discard navigation.

Banner permission state is not observable through these backends. Settings
omits ineffective desktop banner permission controls (the page subtitle uses the
reference copy and does not describe permission handling); sound controls are
effective on desktop because
playback happens in the app. The bridge accepts a submission before waiting for
interaction: acceptance is **not** proof that a visible banner appeared. The macOS
backend does not expose all delivery failures, and no uniform withdrawal/receipt
guarantee is promised.
Callbacks stop navigating after account change or frontend disposal. Native waits
remain bounded until the OS resolves them; no artificial expiry strands an
otherwise actionable alert. Reload/cold-start restoration remains out of scope.

Real banners require OS permission, an available notification service and
appropriate app packaging/installation. macOS development notifications can be
attributed to Terminal; Windows development notifications may use PowerShell's
identity. Test the packaged app identity before claiming release acceptance.
Chromium/WebKit fixtures replace only OS/IPC boundaries; tests and native builds
do not prove actual permission dialogs, appearance, sound or foregrounding.
Report native checks and real banner/click results separately for each platform.

For macOS, Windows and Linux, manual acceptance includes background and minimized
Buzz, two distinct message/thread targets, immediate banner click, banner fade
then Notification Center click, dismissal without navigation, and old-account or
revoked-access rejection. A macOS pass is not Windows/Linux acceptance.


## macOS Dock unread badge

The host projects one dot from the selected community's existing unread selectors:
observed unread messages (including thread replies) or explicit channel-unread
intent. It is not an exact message count or evidence of complete history. Unknown
and observed-zero both omit the dot. Existing bounded evidence/read-state owns
startup and updates; this projection adds no relay reads, network subscriptions,
or storage. Personal space, account/session changes, access loss and host disposal
clear or recompute the indicator. Disabling Channels does not stop host ownership.
Desktop alert preferences do not alter this unread indicator.

One ordered host writer calls a main-window-only command using Tauri's standard
`set_badge_label` API. macOS draws the badge; no custom artwork is supplied.
Windows, Linux and browsers have no shell unread indicator or badge Settings in
this version, and do not bind the unread projection or invoke the Dock commands.
Their existing banner behavior is unchanged. No taskbar overlay, tray icon/menu,
new image assets or tray dependency is added.

Observable setter failures appear in Settings; **Check Dock permission** retries
using current unread intent. There is no automatic retry loop or claim of OS
display acknowledgement.

### macOS permission setup

Settings → Notifications → Dock unread badge shows the actual macOS badge
setting. **Allow notifications and badges** explicitly requests Alert, Sound and
Badge for a fresh NotDetermined identity. **Set up Dock badges** explicitly requests
Badge alone when an already Authorized identity reports NotSupported. Startup,
focus, and **Check Dock permission** only read settings; they never register or
repair permissions. Denied authorization and explicitly Disabled badges are never
re-requested. macOS System Settings controls badge opt-out. Errors withhold the dot
and are shown; a later focus or explicit check can retry a failed read.

This permission capability requires an actual macOS `.app` bundle. Unbundled
`tauri dev` never calls UserNotifications or borrows Terminal's badge permission.
The native bridge is necessary because the official Tauri notification plugin's
current desktop permission methods return Granted without querying these settings.
Existing banner delivery/clicks and their acceptance limits above are unchanged.
Windows and Linux do not use the macOS permission bridge or display its controls.

### Validation boundary

Tests use real relay/unread services for projection transitions, deferred native
boundaries for ordering, default-adapter command dispatch, and mounted Settings
controls for explicit setup. Native tests cover the authorization/setting matrix,
no startup mutation, error recovery and rejection of unbundled framework calls.
No browser journeys are added: these contracts are below the browser layer.

These checks do not prove a visible Dock badge. Native macOS acceptance must
exercise startup/arrival/read clearing, account/community/access changes, reload
and exit under an isolated packaged identity. First permission, explicit
missing-badge setup, deny/disable and legacy-banner interaction also need native
acceptance. Distribution signing and packaged account support remain separate work.
