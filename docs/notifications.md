# Notifications

The host provides one `notifications` service for built-in messages and trusted
plugins. Settings → Notifications stores account-local choices: alerts are on
by default, subject to system permission; master off preserves category choices.
Browser sound uses the Notification API. Desktop sound is managed in OS settings;
there is no separate audio player.

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
Permission and sound remain system-controlled; no permission-only plugin
or synthetic desktop permission prompt is installed. The main-window-only bridge
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

Desktop permission state is not observable through these backends. Settings
describes permission and sound as system-controlled, without ineffective desktop
permission or sound controls. The bridge accepts a submission before waiting for
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
