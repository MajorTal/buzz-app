---
title: Detachable plugin windows - Plan
date: 2026-09-14
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
status: phase 1 in progress
---

# Detachable plugin windows - Plan

## Goal capsule

**Objective.** On desktop, any contributed page (Messages, Projects, Agents,
Terminal, external plugins) can leave the main canvas into its own OS window,
and windows can hold any combination of pages, like browser tabs. Home stays in
the main window.

**Product authority.** Decisions below were made with the product owner on
2026-09-14. Open blockers: none; deferred checks are listed per phase.

## Product contract

### Decisions

- Desktop only (Tauri). Web keeps the single-window shell unchanged.
  *(session-settled: user-directed — chosen over web `window.open` popups: no
  drag between browser windows, and the live broker is desktop-only anyway.)*
- A window is a tab container. A page lives in exactly one window at a time;
  detaching moves it, never duplicates it.
  *(session-settled: user-directed — "any combination, just like a browser tab".)*
- Home and Settings stay in the main window. Detached windows carry the tab
  strip and the macOS traffic-light inset only; community switcher, profile and
  Settings are main-window chrome. Detached windows follow the main window's
  selected community.
  *(session-settled: user-approved — chosen over a full header per window to
  keep one source of truth for community selection.)*
- Each window runs the full app (services, plugin runtime, relay session) and
  renders only its assigned tabs. A central host window or shared worker is a
  later refactor, funded only if measured cost warrants it.
  *(session-settled: user-approved — chosen over a main-window RPC host: no
  cross-webview serialization of the relay contract, plugin contract unchanged,
  and the relay layer already coordinates instances through IndexedDB, Web Locks
  and BroadcastChannel.)*
- Guard rails the owner asked for: nothing fires or publishes twice; no window
  shows stale or missing data it could have had.
- Launcher panels (Bestie, Agent Activity) detach like pages under a
  `panel:<key>` tab: a launcher in main, a full tab in a detached window, and a
  panel's own close returns it to main. Target-bound panels (GitHub, Profile,
  Terminal drawer) stay with the page that opens them.
  *(session-settled: user-directed 2026-09-14 — "should also be possible to
  detach the bestie from everything".)*

### Requirements

1. Right-click (or context-menu key) on a page tab offers **Move to new
   window**, **Move to main window** and **Move to Window N** for other open
   windows. Home has no menu.
2. Moving a tab out of the window that shows it selects the next remaining tab
   (main falls back to Home). A detached window whose last tab leaves closes.
3. Closing a detached window returns its tabs to the main window. Closing the
   main window quits the app.
4. Disabling or removing a plugin removes its tab wherever it lives; a window
   left without visible pages shows an explanation with **Close window**.
5. Window layout (which pages are in which window) is remembered per profile
   and restored on launch. Positions/sizes: phase 3.
6. Dragging a tab out of the strip creates a window; dropping it on another
   window's strip merges it there: phase 2.
7. Plugin authors see no new API. A moved page remounts, exactly as it does on
   a revision change today.

### Non-goals

- The same page open in two windows at once.
- Detaching target-bound companion panels (GitHub, Profile, Terminal drawer)
  independently of the page that hosts them.
- Full shell header (community switcher, Settings) in detached windows.
- Web support.

### Acceptance examples

- Move Messages to a new window: the main tab strip loses Messages and shows
  Home; the new window shows a strip with only Messages, follows the selected
  community, reads and sends normally.
- Move Agents into that window: its strip shows Messages and Agents; main shows
  neither.
- Close the detached window with the traffic light: Messages and Agents are
  back in main.
- Relaunch: the same distribution of tabs comes back.
- A mention arrives while Messages is detached: exactly one native
  notification, from the main window.
- Disable Projects in Settings while Projects is alone in a detached window:
  within a second the window shows the empty explanation; **Close window**
  works.

## Implementation plan

### Phase 1 — Windows, tabs and the move menu (this pass)

Rust owns the layout because it owns window lifecycle and the profile dir.

- `src-tauri/src/windows.rs`: `Layout { windows: [{ label, tabs: [pageKey] }] }`
  persisted to `<profile>/windows.json`. Main is implicit: every page not
  assigned to a detached window belongs to main. Commands `windows_layout` and
  `windows_move_tab(page_key, destination)` where destination is `main`, `new`
  or an existing label. Every change is persisted and emitted as `buzz:windows`
  to all windows. Window `Destroyed` for a detached label returns its tabs to
  main; `Destroyed` for `main` exits the app. Startup recreates saved windows.
  Labels are `tabs-<n>`; page keys are validated against the contribution key
  grammar (`plugin/page`).
- `crates/plugin-manager`: expose the profile directory (`Manager::root()`);
  no behaviour change.
- `src-tauri/capabilities/default.json`: windows `main` and `tabs-*`; add event
  listen/unlisten and window close.
- `src/features/windows/service.ts`: `WindowHost` with `label`, `isMain`,
  `snapshot()/subscribe()` of the layout, `moveTab()`, `close()`, and the pure
  `windowPages(layout, label, pages)` filter. Web fallback: main, all pages,
  `moveTab` unavailable.
- `src/app/services.ts` (FOUNDATION): create the host; bind message
  notifications only in main; in detached windows follow the main window's
  saved community selection through `storage` events.
- `src/app/navigation.ts`: pages filtered by window; detached windows redirect
  Home/Settings targets to their first tab; a selected tab that leaves the
  window falls back to the next tab or Home.
- `src/app/shell/AppShell.tsx` + `TabMenu.tsx`: hide Home tab, community
  switcher, launchers, page finder and profile outside main; per-tab context
  menu with the move actions; empty-window notice with **Close window**.

Deferred checks for phase 1 (must run in the Tauri build, not in Vitest):
WKWebView shares IndexedDB, Web Locks and `BroadcastChannel` across windows of
the same app (read-state publisher serialization depends on it); Terminal
sessions owned by a page that moves windows end or are orphaned until exit —
confirm which and document; second-window cold start time and memory.

Known limitation to document: outbox records created in one window appear in
another window only after that window restarts. Because a page is in one
window at a time this does not surface in the UI today; it matters only if a
second page starts showing the shared outbox.

### Phase 2 — Drag-out and drag-merge (implemented 2026-09-14)

Pointer-event drag on tabs and launchers (`PageTab.tsx`): after a 6px
threshold a ghost follows the pointer; releasing inside this window's own header
cancels, anywhere else calls `windows_drop_tab(pageKey, screenX, screenY)`.
The ghost is a native always-on-top window (`drag-ghost`, reused across drags,
cursor events ignored, non-focusable) moved by `windows_drag_begin/move/end`;
a DOM ghost would vanish at the source window's edge. Its transparent rounded
shape needs Tauri's `macOSPrivateApi`, acceptable while bundling is off (App
Store distribution would need an opaque ghost instead). The frontend coalesces
moves to one IPC in flight. After any move, Rust focuses the destination window
and emits `buzz:windows:activate` to it so the moved tab becomes selected.
Rust hit-tests the logical screen point against every other Buzz window's outer
rectangle (`window_at`): a hit merges the tab into that window, otherwise a new
window opens with its strip under the pointer. HTML drag-and-drop is not used
because it cannot leave a webview. Keyboard/menu path unchanged. Not included:
reordering tabs within a strip (order stays host policy), z-order awareness when
windows overlap (first hit wins).

Deferred check: `screenX/Y` and Tauri `outer_position` agree on multi-display
setups and on non-macOS platforms.

### Phase 3 — Restore positions and sizes

Persist window bounds in `windows.json`; restore with on-screen clamping.

### Validation

- Vitest: `windowPages`, web fallback, layout reducer, navigation fallback.
- Rust: layout moves, closed-window return, persistence round trip, invalid
  input rejection.
- Manual (`bin/just desktop`): the acceptance examples above, plus the
  deferred checks. `just scan` before integration; browser journeys are not
  affected by desktop-only code paths but must stay green.
