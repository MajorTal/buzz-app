# Shell design

The shell is owned by `src/app/shell`, independently of relay operations and page
content. `App.tsx` composes startup/recovery, built-in Home and Settings, and the
existing contributed-page lifecycle. Home is a small scaffold landing page; it
only links to available pages and Settings. Navigation removes disabled plugins
from page choices; a retained destination whose provider is unavailable displays
an explicit failure with retry instead of silently selecting another page.
Browser controls, host shortcuts and toolbar arrows traverse the same visit history.
Settings sections are destinations. Personal-space page visits use explicit null
scope, distinct from a plugin's unspecified community scope. Focus-only skip links
do not add visits. Plugin recovery remains available in Settings → Plugins without
blocking Home, Profile or Appearance.

See [design system and appearance](design-system.md) for Light/Dark settings,
semantic tokens, UI authoring rules and the local component reference.

## Where to change the design

- `src/shared/styles/globals.css` owns the semantic palette exposed to Tailwind:
  `ink`, `muted`, `line`, `soft`, `shell`, and `shadow-surface`. Default element
  styles live in Tailwind's base layer, so utilities can override them normally.
  Existing feature CSS variables remain available for incremental adoption.
- `src/app/shell/presentation.ts` owns page labels, icons and navigation ordering.
  Home comes first, then Messages and Projects; other contributed pages follow by
  displayed label with a full contribution-key tie-breaker. Tabs, Home links and
  page search share this policy, independent of plugin activation/re-enable order.
  Channels is presented as Messages. Legacy tone props are retained for
  compatibility; all pages share the supplied gradient and repeating CSS dots.
  Add recognized page presentation here without changing plugin contracts.
- `AppShell.tsx` owns the 56px header, scrollable centered navigation, contributed panel
  launchers, Settings access, community switcher, and page frames. Equal-width
  left/right header tracks center tabs on the window, not the leftover space.
  Below 700px the tab pill moves to a centered second row to avoid collisions.
  Full-height pages get a 16px outer gutter (8px on narrow screens) and own their
  card surfaces. The shell adds no white backing behind them. Document pages
  scroll inside the remaining viewport.
- `Settings.tsx` presents Profile, Plugins and Appearance as selectable sections in a left
  sidebar, opening on Profile. When the content area is narrow (including beside
  a companion panel), the section buttons form a compact row above the content.
  Navigation and details scroll together inside the solid container at narrow
  widths, so wrapped navigation cannot consume the detail pane's height. Wide
  layouts keep independently scrolling navigation and details.
  Native buttons use normal Tab/Enter navigation and expose the current section.
  `ProfileSettings.tsx` edits the local default inline with Save and Cancel,
  sharing fields and validation with community setup. Cancel restores the saved
  profile; switching sections retains an unsaved draft while Settings is open.
  Leaving Settings discards that draft. Saving does not publish to communities.
  Plugin rows retain accessible native-button switches and show only names and
  controls. A Folder/Git import area above the list previews plugin subfolders and
  requires explicit install/update; its draft survives section switching, but
  leaving Settings discards it. Import controls are desktop-only. Management errors remain visible.
  Switches use aria-disabled plus a busy guard so a management transition does
  not discard keyboard focus.

Use utilities for layout and component styling. Shared navigation states live in
small component classes; avoid adding unlayered global rules that override
utilities or reaching into a page's CSS module from the shell. Respect reduced
motion with Tailwind's `motion-reduce` variant.

## Desktop chrome

Tauri uses `titleBarStyle: Overlay` and `hiddenTitle` on macOS. Native traffic
lights have a reserved 104px left area before the community switcher only in the
macOS desktop runtime. This inset does not move the centered tabs. Web gets no
inset or imitation window controls. Other
platforms retain their native decorations. Drag regions are limited to the
header background; controls remain clickable. The main-window capability grants
only titlebar dragging and the internal native maximize action used by Tauri's drag
handler, plus scoped HTTP(S) opening for [external links](channels.md#run-the-integration).
See [Tauri window customization](https://v2.tauri.app/learn/window-customization/).

The top-right group contains enabled plugin launchers (Bestie supplies the snake),
a page finder, and the local avatar. `ProfileButton.tsx` subscribes to the community
service's local default profile and opens an anchored account dropdown containing
Settings; there is no separate top-bar Settings button. The disclosure uses native
buttons and normal Tab order, dismisses on Escape/outside click/focus leaving, and
returns focus to the avatar on Escape. Selecting Settings focuses the main region.
The avatar does not display the selected community's profile. It uses a configured
HTTPS picture directly, with the name's first letter on a missing/failed picture
or a person icon when unnamed. No sample person's photo is used as the user's
identity. See [community/profile ownership](communities.md).
`PageSearch.tsx` uses a native modal dialog for focus containment, Escape dismissal,
and searching available page destinations. Projects is a bundled, enabled-by-default
page scaffold with only a centered title; Apps waits for a functional destination.
`CommunitySwitcher.tsx` replaces the full-height rail:
its top-left button opens a native dialog for Personal space, existing communities,
and Add a community. The trigger is focused before opening so Escape restores
keyboard focus in WebKit as well as Chromium.

Visible copy uses Buzz, never “workspace.” The legacy `workspace` layout identifier
and CSS variable are implementation details retained for plugin compatibility.

## Assets

`public/` contains browser icons copied from Buzz's desktop icon family. Tauri's
PNG, ICNS, and ICO files are in `src-tauri/icons` and explicitly configured in
`tauri.conf.json`. Replace both sets together when the source branding changes.
The source attribution is in `NOTICE.md`. `public/shell-gradient.png` is the
exact supplied 564×1002 image, stretched across the shell to retain the complete
blue/yellow/white composition. A 36px repeating CSS radial gradient supplies dots
behind, never over, opaque cards; it makes no relay request at runtime.

## Review

Run `just iterate` for UI changes and `just scan` for the broader review checks.
Check Home, Messages, and Settings; toggle a bundled plugin off/on and confirm its
navigation entry follows; inspect a narrow viewport. On macOS, verify titlebar
alignment, dragging, double-click zoom, and Settings access in a built app.

## Messages

The Messages feature owns separate rounded sidebar, conversation and contributed
panel cards, with 16px gutters. A single right panel fills the conversation height;
the right-column grid splits available height evenly between a local link card
and the launched companion card. Below 1000px
the right column overlays the conversation; below 650px it fills the page area.
Each card contains its own overflow, keeping the composer and close control visible.
Channels opts into the reusable companion prop and owns both cards, including a
companion-only view without a selected channel or relay. Home/Settings and legacy
pages use the host fallback frame; opening from those pages does not navigate away.
Disabling Bestie removes its snake and open card without evicting a local link card.
The shell supplies the outer page gutter. Channel previews, roster labels, and routine refresh
and freshness indicators are omitted. Conversation options → Diagnostics keeps
manual refresh, outbox inspection, and timing capture available on demand.

The composer preserves the session's text sending and keyboard behavior. Its
rounded input and lavender send arrow follow the reference; unsupported upload,
mention, and rich-formatting actions are not presented as working controls.
Delivery renders like an ordinary message immediately. After ten seconds from the
message timestamp, unsuccessful/unconfirmed sends show a small notice. Confirmed
messages never show a success label. Retry remains available for failed/unknown
operations. `delivery.test.ts` covers the timing boundary and terminal states.

The shared conversation layer now supplies bounded thread reading/replies and
[session-owned unread indicators](unread.md). These are separate from this styling
pass: counts remain observed rather than exact, manual unread is local-only, and
reading intent belongs to reusable conversation UI rather than shell navigation.
