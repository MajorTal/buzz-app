# Plugin architecture

## Purpose

Buzz should make it practical for people and agents to build new product experiences with code. A designer should be able to build an experimental Channels page using real data and useful components, without implementing relay operations. A developer experience team should be able to add rich integrations to conversations without owning the surrounding application. And end customers of buzz should be able to extend the installed app dynamically, without having to contribute upstream or run the dev server.

Plugins are the unit of contribution and installation. They can contain substantial implementations: several components, their own layout and interactions, and multiple contributions. The foundation is ordinary React components, shared data and execution capabilities, and a small number of explicit extension points.

## The first two authoring experiences

**A page (target authoring experience).** A builder creates a plugin that registers
a page, reads shared channel views, and builds a new interface. They should be able
to reuse timeline/message components or build their own, owning the complete page
implementation and its behavior and appearance. Bundled source demonstrates this composition. The conversation preview
now supplies host Composer/Message through a generated type-only author entry;
broader supported external reuse remains an [author-contract gate](status.md#open-acceptance-and-product-gates).

**Rich conversation content.** An integration plugin recognizes a link to a GitHub pull request or a native Buzz object and supplies a panel showing that object. The Channels page decides where the panel appears. Another page can display the same content in a different arrangement.

Both experiences use real session capabilities. As AI integrations become available, authors should be able to consume those capabilities without rebuilding authentication, execution, or state handling. The first [Agents slice](agents.md) shows the existing Buzz library read-only; mentions use current channel membership and existing runners.

## Ownership

| Area | Responsibility |
| --- | --- |
| Application host | Startup, plugin installation and activation, page navigation, Settings, and recovery. |
| Page plugin | Its complete React tree, local interaction state, internal navigation, and arrangement of panels. |
| Panel plugin | Recognizing a supported target and implementing the content and interactions for that target. |
| Shared capabilities | Session state, relay access, retained data, and eventually agent operations and external connections. |
| Reusable UI components | Useful rendering and interaction behavior, configured through ordinary props. |
| Cordis | Dependency availability and resource lifetime across plugin activation, replacement, and disposal. |

Bundled and local plugins use the same contribution contracts. Within the source
tree, shared implementation code remains importable without another registration
layer; this is not a promise that external artifacts can import host source paths.


## Code arrangement

```text
app/                    host, startup, navigation, Settings
plugins/                installation, lifecycle, contribution ownership
features/pages/         page contract and host rendering
features/panels/        target resolution, launcher contract and reusable card/frame
features/shortcuts/     in-app binding dispatch, focus rules and plugin ownership
features/relay/         shared channel data, queries, profiles and durable delivery
features/messages/      reusable timeline, message, thread and composer UI
bundled/channels/       Channels navigation, sidebar, page layout and panel placement
bundled/projects/       title-only Projects page scaffold
bundled/agents/         read-only current-Buzz agent library page
features/agents/        shared session-owned local library view
bundled/github/         builtin GitHub panel plugin
bundled/bestie/         builtin companion panel and its snake launcher
```

Channels is the page-authoring example, not a thin registration wrapper over a
host-owned product page. Keep page-specific components, styles, interactions and tests
beside `bundled/channels/index.tsx`. New page plugins should do the same. At the
owner’s request, reusable conversation UI lives in `features/messages`: timeline,
message rows, thread panel, composer, delivery presentation and reading geometry.
Other source plugins can compose those components through ordinary props, with
internal session/destination isolation rather than caller-dependent remount keys.
Import shared capabilities through the existing relay and panel contracts; do not
create a second connection, cache or outbox inside a page. The conversation preview exposes only Composer/Message in a stable component bag;
source imports are not a versioned external SDK. See
[conversation component ownership](channels.md#reusing-conversation-ui).

## Starting contracts

A plugin exports `inject` and `apply(ctx)`. Pages register with
`ctx.pages.register({ id, title, layout?, companion?, component })`. Panels register with
`ctx.panels.register({ id, title, matches, launcher?, component })`. IDs are local to the
plugin; the registry adds installation identity and revision and removes the
contribution when its Cordis scope ends.

A page calls `panels.resolve(target)` and renders `PanelView` with the resulting
contribution, the target string, and a close callback. The first active matcher
wins; a throwing matcher is skipped. Panels receive `{ target, close }` plus
optional host context. A conversation host may supply
`context: { channelId, canOpen, open }` for contextual panel-to-panel actions.
`canOpen` is advisory active-target availability; `open` re-resolves at click time
and returns false after the originating opening, channel, session or host
presentation retires. This is not a global navigation API or an access grant.
Channel-header launchers use the separate public `channelContext` metadata
contract described below; launcher/fallback panels need not have either context.
A plugin that needs shared data declares `relay` in its
injection list and passes those capabilities to its components using a closure,
just as the bundled Channels page does. The conversation preview adds only the two demonstrated component surfaces.

Channels owns its selected channel and docked target. The panel view isolates
render failures and remounts on target or revision changes. Unloading a plugin
removes its contributions and closes its panel. Other pages can use these same
contracts with their own layout and local navigation.

The initial distribution contains Channels, Projects, Agents, GitHub, Bestie, Emoji, Mentions, Profiles and Terminal. Projects
is an enabled-by-default scaffold with only a centered title and no relay dependency.
GitHub recognizes repository,
pull request, issue, and commit URLs and loads public object details on demand.
Unsupported URLs retain ordinary link behavior. Private GitHub connections and
agent operations remain future shared capabilities.

### Channel-header launchers

A panel may additionally contribute `channelLauncher: ComponentType<ChannelLauncherProps>`.
Channels renders these in its conversation header with public `context`, `pressed`,
`available()` and `toggle(target)`. The page owns a single bottom drawer; a launcher
selects its **exact active contribution**, not target matching. `available()` and
`toggle()` are revoked when the mounted context or contribution is retired. Optional
`PanelProps.channelContext` carries the current displayed public context to a channel
panel; ordinary link/host panels do not supply it. It is presentation metadata, not
signing authority. Plugins decide when to capture it into their own work.

Channels keeps layout and channel/thread selection. The Terminal plugin binds its
mounted launcher into the existing shortcut dispatcher, and owns sessions separately
from drawer mounts. No global selected-channel store, extra shortcut listener or
host companion change is required. Disabling/replacing a contribution closes its
drawer, and re-enabling starts closed. See [Terminal](terminal.md) for native support,
session behavior and validation limits. This is a host-matched preview addition,
not cross-version capability negotiation.

### Top-bar launchers and the companion slot

A panel may supply `launcher: { icon, target }`. The host renders the decorative
image (generic icon on failure) and uses the panel title as the button label.
`target` is an opaque string, including an empty default; it is not an agent URI.
Launcher-only panels use `matches: () => false`. Clicking selects that exact active
contribution, bypassing target matching so another plugin cannot intercept it.

App owns one launched-panel selection, separate from a page’s local target. The
selection starts closed, repeated clicks toggle it closed, and navigation preserves
open intent. Disable/replacement invalidates the installation object; re-enable
stays closed even at the same key/revision. A stale close cannot dismiss a later
opening, including a later opening of the same contribution. Ordinary close returns
focus to the launcher if available.

Pages explicitly opt in with `companion: true` and receive `{ companion?: ReactNode }`,
a ready-to-render card. They must place it in **every** state, including no relay,
loading and empty data. Channels places its local target above this card in one
right column. Non-opted/legacy pages and Home/Settings use the generic host fallback;
there is never a second simultaneous host dock. The fallback frame stays mounted
while opening/closing to preserve page-local state. `PanelCard` and `PanelFrame`
are ordinary shared components, not another registry.

Only open intent crosses pages: the panel component can remount under a new page,
so this mechanism does not promise persistent agent sessions or drafts. Bestie
currently supplies art and truthful not-connected copy, with no send control or
agent API. Both browser and Rust native/CLI catalogs list it as independently
enabled by the normal bundled policy; saved disabled flags still win.

`main.tsx` creates the shared services once; `app/App.tsx` owns startup screens,
navigation, and built-in Settings. `app/services.ts` composes the core services.
Settings and Recovery subscribe directly to plugin management. Page render errors
stay in the page boundary rather than being copied into plugin configuration.

`plugins/manager.ts` is the plugin subsystem's entry point. The app supplies the
Cordis context and bundled manifests/modules. Storage defaults to the platform
adapter, with an optional override for tests. React is provided as `ctx.react`;
external JSX plugins declare `inject = ["react"]` to use the shared instance. The manager
constructs its module loader and execution adapter internally, observes configuration,
and selects the desired plugins (including enabled flags and safe mode).

### Loading from folders and repositories

Desktop Settings → Plugins loads a folder with the native folder picker, or an
HTTPS/SSH Git repository (including GitHub `owner/repository`). An optional branch
or tag is separate from the repository URL; GitHub `tree` URLs are rejected with
guidance rather than ambiguously splitting branch names and subfolders. Discovery
lists built plugin folders by path, name and manifest ID, including nested `dist`
folders. Choose one and explicitly install/update; the same preview can install
another plugin without fetching again. New plugins stay disabled. Updates match
**manifest ID**, even across repositories, and preserve the saved enabled state:
an enabled update may activate immediately except in safe mode. The UI warns before
that action. Installed artifacts do not watch/pull the source; import again to update.

The Rust manager owns acquisition and immutable preview artifacts, with a bounded
single pending preview per native process. Replacing/closing a preview discards it;
leaving Settings ignores and discards a late result, never automatically installing.
Acquisition is separate from the manager's ten-second management-write timeout.
Installation uses the exact captured bytes and retains the existing artifact hash,
profile locking, rollback, recovery and safe-mode behavior. An uncertain write retains
the preview identity for same-artifact retry; it does not refetch or rebuild.

Local discovery skips symlink directories, `node_modules`, `.git` and `target`, and
uses `cap-std` directory-relative reads to confine descendant path resolution. Files
must be regular, non-symlink UTF-8 text; candidate folder names must be UTF-8 and are
not lossily normalized. Discovery never evaluates modules. Git is a required local
tool: a shallow no-checkout clone reads committed blobs, without hooks, filters,
submodules, LFS downloads or project scripts. Only HTTPS/SSH are allowed; inherited
Git config, URL rewrites, credential helpers and interactive prompts are disabled.
SSH uses the existing agent/known hosts, not user SSH config; password entry, HTTPS
private-repo sign-in and custom SSH-config aliases are not supported in this slice.
Repository URLs/refs are passed as arguments, not a shell command. Private/internal
HTTPS hosts are not prohibited; this is not a public-network-only policy.

Git acquisition has a 60-second deadline (including blob discovery), an observed
256 MiB repository limit and bounded command output; transport processes are killed
on failure before temporary cleanup. These are polling limits, not hard OS quotas.
Folder traversal checks a 60-second budget between directory reads (a hung filesystem
syscall is not forcibly cancelled), 32 nesting levels and 20,000 entries. A preview
holds at most 32 plugins / 32 MiB; each artifact retains the 8 MiB limit. No builds
are run: source-only folders explain that the author must supply `manifest.json`
plus the self-contained `plugin.js`. Separate assets/TSX/runtime dependency resolution
remain outside API v1. Browser Settings truthfully directs users to desktop rather
than adding a second external-plugin storage or broadening CSP. Native commands need
a rebuilt/restarted desktop process; frontend HMR alone cannot add them.

`plugins/storage.ts` isolates browser storage and desktop IPC. `plugins/modules.ts`
imports and caches executable revisions. `plugins/runtime.ts` adapts Cordis lifetimes
and owns activation status; contribution services receive a read-only readiness view
of that same status. There is no separately synchronized status store.

The runtime receives only the desired plugins. It retains cancellation and cleanup
barriers around asynchronous imports and replacement; Cordis owns dependency
availability and effect disposal. Stopping plugin management stops polling and its
owned plugin lifetimes. App shutdown starts manager disposal and root-context
disposal together: a hung plugin cannot delay cancellation of shared sessions,
requests or subscriptions. The returned promise rejects after 10 seconds if cleanup
has not finished; it does not claim that arbitrary plugin code has stopped. Plugin
replacement still waits for the predecessor's actual cleanup, even after a timeout.
React owns only subscriptions and presentation state.

Relay consumers use `session.channels` for channel views,
`session.profiles` for shared identities, and `session.read` for
finite filtered event reads, and `session.unread` for shared observed badges and
cancellable reading intent. See [relay query ownership](relay-queries.md) and the
[unread capability, durability and limitations](unread.md).

Plugins subscribe to `ctx.relay` connection snapshots and bind work to the current
ready session. `useRelayConnection(relay)` is the React adapter; remount session-owned
views with a key including both scope and generation (for example,
``key={`${connection.scope}:${connection.generation}`}``). Scope distinguishes
retained communities whose generation numbers may match; generation distinguishes
reconnections within one scope. Persist drafts and view intent under scope alone,
not generation. Reactive filtered reads use `session.observe`;
writes use `session.outbox` or the `session.messages` convenience methods. Reads,
live traffic and local events share reconciliation, with no separately injected
write service. Dispose owned views when their plugin or session scope ends.

The [Profiles plugin](profiles.md) supplies read-only human/agent identity panels.
Shared message UI opens exact public-key targets through ordinary page callbacks;
no inline-renderer or panel contract extension is needed.

## Navigation targets and visits

The host provides `ctx.navigation` to plugins declaring `navigation` in `inject`.
`open(target)` returns a presentation result, not merely an accepted address:
`opened`, `failed` (with a reason), `superseded`, or `cancelled`. The host owns one
history driver, toolbar/keyboard traversal, and a 15-second attempt deadline.
A visit has stable identity; retrying/reclicking preserves that visit and Forward,
while a new destination truncates the forward branch. Leaving aborts the old
attempt, and late completion cannot acknowledge a replacement attempt.

Version-1 `OpenTarget` supports Home, Settings sections, contributed pages with
optional versioned JSON routes, and account/community-bound conversations.
The boundary copies, freezes and bounds route data; an address is never an access
grant. Scoped targets require the original viewer and an already joined community.
An explicit `scope: null` restores Personal space; omitted page scope leaves the
current community alone. Unknown providers/routes fail with the target retained
for retry, rather than silently opening another page.

Pages receive optional `navigation` in `PageProps`. Ordinary pages acknowledge a
successful mount inside the render boundary. Pages declaring `handlesNavigation`
acknowledge their domain presentation with `navigation.complete(...)`; Channels
waits for its requested channel window or exact-message reveal/focus. `navigation.resolve(target)` normalizes a
pending default destination within the same visit, caller and original deadline;
it does not start competing navigation. Normalization revokes the old request.

A page request belongs to the exact active registration and mounted host
presentation. Its signal aborts and its callbacks return false after removal,
replacement, unmount or scoped-community invalidation, even before React cleanup.
A reactivated provider receives a fresh request for the still-pending visit.
Session-aware pages bind each rendered connection with
`navigation.forSession(relay, connection)` and pass that request to their
session-owned subtree; Channels demonstrates this boundary. Replacement revokes
the bound request synchronously without revoking static page authority or resetting
the caller's deadline. These are trusted-plugin lifecycle fences, not a sandbox.

`route: { version, validate }` opts a page
into versioned route parameters. These are host-matched preview types through
`@buzz/author`, not a cross-version runtime compatibility promise.

Browser `#buzz=` addresses and session history support reload and Back/Forward.
`targetLink`/`parseTargetLink` define a `buzz://open` locator codec that omits the
sender's viewer; `bindSharedTarget` pins it for an admitted recipient. **This slice
does not install native OS deep-link or notification-click ingress or migrate legacy
Buzz links.** Message-addressed conversations show the selected verified row in a
bounded detail surface, ignoring optional `threadRootId` hints. Completion requires
the exact row to be visible and focused; unavailable targets never fall back to the
channel head. Ingress adapters must reuse this validated target/completion lifecycle.

Drafts, reading geometry and sidebar view intent remain domain-owned, outside
visit history. Saved sidebar preferences live in the relay session, not in the
mounted page; see [sidebar ownership](channels.md#ownership).

## Conversation contributions

The conversation preview exposes top-level `registerTool`, `registerCompletion` and `registerInline`
methods and stable `conversation.ui.Composer` / `.Message` components. Generated
type-only `@buzz/author` declarations support the independent Composer Lab example.
This remains a host-matched preview, not a stable cross-version SDK. Shared session
ownership and trusted-plugin authority do not change.

### Composer ownership and mention tools

The standard composer is reusable host UI in `features/messages`, not a mandatory
Composer plugin. Page plugins may compose it through `conversation.ui.Composer`
(or source props), or build their own editor against the shared session. Optional
chooser UI belongs in tool plugins: `bundled/emoji` and `bundled/mentions` use the
same `registerTool` contract. No page imports their implementations. Optional numeric
`order` (default zero, lower first; ties by contribution key) keeps visual and
keyboard order stable across asynchronous activation and re-enable. Mentions uses
`-10` to retain its position before default-order tools such as Emoji.

Tools receive `insertText`, `insertMention({ pubkey, name })` and `focus` commands.
Mention insertion atomically records visible text and exact notification intent;
`true` means the edit was accepted, **not** that membership or delivery succeeded.
The host serializes successive commands using the latest draft and selection,
enforces text/recipient limits, and revokes commands on tool removal/replacement,
editor destination/session change, disabled/read-only state and unmount. Names are
presentation, never recipient resolution. Editing/pasting over an identity span
removes its intent under the existing draft rules.

**User intent outlives the tool that created it.** Disabling Mentions removes its
chooser, not selected recipients, their visible disclosure/removal controls, scoped
drafts or pending messages. The session still owns roster/profile data, membership
checks, signing and publication/retry. Plugins remain trusted same-process code;
revocable editor commands do not sandbox the session capabilities they receive.

This preview is host-matched: a tool using `insertMention` needs a host providing
that command. The generated type-only `@buzz/author` package and `apiVersion: 1`
are not runtime capability negotiation or cross-version compatibility promises.

### Composer completion providers

Emoji and Mentions each register a separate `registerCompletion` contribution.
The host observes focused, enabled textarea text and collapsed UTF-16 selection,
then chooses the valid syntax match closest to the caret (greatest range start),
with `order` and contribution key breaking ties. This lets a later emoji trigger
win over an earlier multi-word mention query. Matchers
must not depend on asynchronously arriving session data: the winning component owns
reactive roster/profile/catalog filtering. Only that component mounts. An empty
result without status/retry hides the menu while keeping the provider subscribed.

Providers receive immutable observation/range evidence and `publish(result)`—not
DOM, focus or replacement commands. Results contain stable IDs, labels, optional
detail/decorative previews and either text or an exact `{ pubkey, name }` mention.
The host copies edit/query primitives and caps publications at 50 choices. A
publication returns its own withdrawal disposer (or `false` after revocation).
Providers must withdraw synchronously when the data supporting a displayed choice
changes, and republish from the new snapshot; unrelated notifications must not
leave a withdrawn result without pending work. Cleanup cancels asynchronous work.

The host binds callbacks to the exact contribution, editor revision and query.
Edits (including same-text input), selection changes, blur, composition, disabled
state, plugin replacement, destination/session change and unmount revoke old work.
Acceptance rechecks the actual DOM text/caret/focus and atomically replaces the
query through the existing mention-draft path, retaining its text/recipient limits.
Typing/pasting a name alone never creates notification authority. Accepted mention
intent survives optional plugin removal and remains subject to session validation.

One host-owned, viewport-bounded portal renders the active listbox. Focus stays on
the textarea with `aria-controls`/`aria-activedescendant`; arrows follow stable IDs,
plain Enter/forward Tab accept, and Escape dismisses pending results. A rejected
displayed choice must not fall through to sending. Retry is a selectable menu action
using the same arrow/Enter/Tab path, including when there are no results. Modified
keys, Shift+Enter/Shift+Tab and IME events retain ordinary editing behavior.

Emoji lazily copies native-only records (including aliases and keywords) from the
pinned data package; it does not use Emoji Mart's mutable global search singleton.
Community matches come only from the current session catalog. Mentions performs
bounded background enrichment through the shared profile directory, not per-key
network reads or a separate identity cache. Multi-word filtering stays in the
provider so a delayed name can appear without another editor event.

This is the same host-matched preview as toolbar tools, not version negotiation or
a sandbox. Inline mention pills remain outside this completion implementation.

Formatting needs selection transforms. Attachments and voice need shared media
capabilities, destination-bound asynchronous work and cancellation; accepted
material belongs to the draft, not the optional tool. Add these contracts against
real workflows rather than declaring the toolbar a universal editor API.


## In-app keyboard shortcuts

The host composes one `ShortcutsService` in `app/services.ts`. Plugins declare
`inject = ["shortcuts"]` and call `ctx.shortcuts.register(shortcut)`; their bindings
use the same matching/dispatch rules as host-owned Settings and text sizing.
There is no OS-wide hotkey registration, native accelerator API, or command bus.

```ts
import type { Context, Shortcut } from "@buzz/author";
export const inject = ["shortcuts"];
export function apply(ctx: Context) {
  const shortcut: Shortcut = {
    id: "show-details",
    title: "Show details",
    binding: { key: "k", mod: true, shift: true },
    when: () => detailsViewIsAvailable(),
    run: () => showDetails(),
  };
  ctx.shortcuts.register(shortcut);
}
```

`binding` is one binding or a nonempty array of aliases. `key` matches the logical
`KeyboardEvent.key` case-insensitively, not a physical `code` (Space is `" "`,
not `"Space"`). `mod` means Command
on Apple platforms and Control elsewhere; Shift/Alt and the other primary modifier
match exactly. IME/AltGraph events and already-prevented events are never consumed.
The window listener runs in the bubbling phase, after local editor handlers.

By default bindings do not run in editable targets (including open Shadow DOM),
while a dialog is open, or repeatedly on a held key. Explicit `allowInEditable`,
`allowInModal` and `repeat` opt in; `when` checks current eligibility without
re-registering. `run` may return a promise; throws/rejections are logged and isolated.
Only a selected binding prevents the browser default. An eligible held binding
still prevents the default when its repeat handler is suppressed.

IDs are namespaced by installation. Only active revisions participate; disable,
failed activation, replacement and Cordis disposal remove eligibility. Plugin ties
are resolved by ascending namespaced ID, independent of activation order. Host
bindings are reserved even while unavailable (Settings does not navigate behind a
modal). `snapshot`/`subscribe` expose ready plugin registrations, not host bindings
or a promise that every binding wins every current focus conflict. The host-only
registration method is deliberately absent from the injected type contract; plugins
remain trusted same-process code, not sandboxed adversaries.

See [`shortcut-counter`](../examples/plugins/shortcut-counter/README.md) for a
self-contained external plugin using the real service without a DOM listener.
The generated type-only `@buzz/author` exports `Shortcuts`, `Shortcut`, `KeyBinding`
and `RegisteredShortcut`. This is a host-matched preview: older hosts without the
`shortcuts` capability cannot activate such a plugin. `apiVersion: 1` alone is not
runtime feature negotiation. Chords, user rebinding, conflict UI and command palettes
are outside this initial contract.
