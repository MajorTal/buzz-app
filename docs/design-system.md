# Design system and appearance

> **The design system going forward:** the imported system is documented in
> [the handoff README](../src/shared/design-system/README.md) and displayed at
> `/tests/fixtures/design-system.html`. New UI and existing surfaces moving off the
> current styles should use it. This initial port does not migrate existing surfaces,
> so the host styling described below still governs those callers until they move;
> the host remains the single owner of appearance throughout the transition.

The **host** owns appearance, including startup and recovery. A plugin must not be
required to render the shell correctly. Pages still own their layout and behavior;
this is shared styling, not a second component registry or a parallel `core/` tree.

## First release contract

Settings → Appearance offers **Light** and **Dark**, defaulting to Light. The choice
is device-local (`buzz-appearance.v1` in browser-origin localStorage), not a community
profile or relay event. There is no System mode, theme marketplace or appearance sync
between devices. Another same-origin window observes saved changes without rebuilding
pages or relay services. Failed storage reads open safely in Light; failed saves apply
for this session and expose a retry in Appearance. Invalid stored values use Light.

`public/appearance-init.js` runs as a parser-blocking same-origin script in the HTML
head, before the React bundle. It sets `data-color-mode` on `<html>`; CSS supplies the
palette and `color-scheme`. It requires no unsafe-inline script CSP exception. Its
storage key/parser is intentionally tiny and checked against the service in tests.
`src/shared/theme/service.ts` owns live state, storage events, DOM application and
browser theme-color metadata. `app/services.ts` owns its lifetime, including disposal.
The built-in palettes do not fetch anything or wait for plugin/relay startup.

Native window decorations and pre-WebView launch color are **not** controlled by a
CSS attribute. An attended packaged-app check is still needed before claiming native
chrome/relaunch parity; no broad Tauri capability or CSP expansion was added here.

## Tokens and shared controls

`src/shared/design-system/styles/tokens.css` owns the public palette and semantic
roles. `src/shared/styles/tokens.css` is a compatibility bridge for older callers,
not a second palette. The app imports one Tailwind reset and keeps its existing
appearance service, storage and startup ownership.

| Group | Examples | Purpose |
| --- | --- | --- |
| Surface | `--surface-base`, `--surface-panel`, `--surface-popover` | Page, card, popup |
| Text | `--text-standard`, `--text-subtle`, `--text-inverse`, `--text-danger` | Meaning and emphasis |
| Border | `--border-standard`, `--border-prominent`, `--border-focus` | Edges and keyboard focus |
| Affordance | `--affordance-prominent`, `--affordance-subtle`, `--affordance-danger` | Controls and actions |

Shared components consume these roles; features consume shared components.
Base UI owns focus, keyboard interaction, selection, portals and dismissal.
Buzz owns visual styles and product behavior. Build missing shared components
from Base UI rather than copying private components or wrapping another library.

Use complete type roles with Inter and JetBrains Mono. Do not import proprietary
fonts, private packages or internal business examples. Default, hover, pressed,
focus, selected, disabled and loading states are shared component decisions.
Loading must prevent repeated actions while preserving the label footprint.

The standalone design viewer imports the real shared controls without app startup,
identity or relay services. Check the actual app as well as specimens, in both
themes and at narrow, intermediate and wide widths with enlarged text.

## Future theme contributions (design boundary, not implemented API)

A theme's identity is separate from its `light | dark` color mode. Future first-party
or plugin definitions can contribute named, versioned semantic values; the host owns
validation, explicit user selection, applying/removing overrides and a built-in
fallback when a contribution disappears. Do not make feature components branch on
specific theme names. Do not advertise internal source imports as a versioned SDK.
Add a supported contribution API only with its first real external consumer and
unload/rollback tests. Trusted same-process plugins can already execute arbitrary
code; these authoring conventions are not a sandbox or CSS security boundary.

## Evidence and remaining validation

`shared/theme/service.test.ts` checks parser/bootstrap agreement, denied storage,
save/retry/restore, events and disposal. `tokens.test.ts` checks complete paint roles
and selected WCAG AA token pairs. These calculations are **not** a full rendered
accessibility audit (transparency, images and focus placement need inspection).

`tests/browser/appearance.spec.mjs` exercises the production frontend with fixture
relay data in Chromium and WebKit: Settings controls, reload, denied save/retry,
cross-window updates preserving a live draft/DOM/scroll anchor, responsive screenshots,
and the dark document while the entire application JS bundle is withheld. Existing
Settings journeys also cover the added navigation stop. No live relay writes occur.

Emoji Mart uses the root mode and an in-place attribute observer, disposed with the
picker. Browser regressions cover host Settings changes through an open widget,
opening in Dark, and no updates after disposal. Mutation probes exercise the startup
script, Settings writes/retry, host lifetime and widget initial/update/disposal paths.

The initial integration batch passed the theme/picker journeys in both browsers,
Node/Vitest/plugin-manager tests, formatting/types, build and Clippy. The broad browser
run was **89/90**, not green: WebKit's `initial-position.spec.mjs` reload case reported
a localhost access-control console warning. The identical failure reproduced on
pre-theme `742a770` (one failure, two passes); its cause is not diagnosed or suppressed.
Native Rust test targets compile but contain zero tests. Human light/dark visual
approval and independent source review do not replace attended packaged-app
chrome/relaunch acceptance. Browser evidence also does not cover third-party plugins
that hard-code their own colors.


## Text size and shortcuts

The host owns a separate device-local `buzz-font-scale.v1` preference (80–200%,
10% steps; default/reset 100%). Color-mode storage is unchanged. Settings →
Appearance supplies visible decrease/increase/reset controls and save-failure retry.
The bootstrap and appearance service apply `--buzz-text-scale`; invalid persisted
values fall back to 100%, and same-origin storage events re-read the latest choice.

Command+, opens Settings on Apple platforms. Command+= / Command++ increase text,
Command+- decreases and Command+0 resets. Other platforms use Control. Zoom works
while typing and in dialogs without changing browser/WebView zoom; Settings does
not navigate behind an open modal. The [shortcut service](plugin-architecture.md#in-app-keyboard-shortcuts)
also serves plugins and owns event dispatch/lifetime rules.

Only typography scales: root rem size, layout spacing, icons and native window
geometry stay unchanged. Shared Tailwind type utilities and built-in fixed-size
CSS typography consume the scale. Plugin text can inherit host typography or use
`font-size: calc(15px * var(--buzz-text-scale, 1))`; avoid multiplying inherited
font size by the scale again. Use unitless or scaled line-height so enlarged text
does not overlap. Independent plugins that hard-code sizes and third-party shadow
widgets need their own adapter; this is not a forced CSS rewrite of arbitrary code.

`tests/browser/shortcuts.spec.mjs` covers real key dispatch to Settings and actual
message/composer text, draft/node preservation, reset/limits/reload, modal/editor/
Shadow DOM guards, and the independent example's disable/re-enable path. These
Chromium/WebKit checks use a fixture broker, not native menu accelerators. An
attended desktop shortcut try remains necessary for native acceptance.

## Incremental system integration

The host entry `src/shared/styles/globals.css` now loads the shared system's
palette, typography roles, materials and component styles with one Tailwind reset.
It does not import the viewer's global entry, preference owner, docking vendor CSS
or workspace experiments. Panel styling remains defined only by the shared system.

Existing screens retain their palette, canvas, type sizes and native-control
recipes. Compatibility names are temporary, not the vocabulary for new work.
`bg-primary` retains the old action fill via an explicit compatibility utility;
`text-primary` and `border-primary` belong to the system. The old control radius
is explicitly named `--radius-legacy-control` to avoid overriding shared controls.
Legacy monospace utilities and native code retain their system font stack; migrated
boundaries select the shared mono face. No old paint role is aliased merely because it sounds similar: the current
palettes differ, and aliasing them would silently recolor unmigrated screens.

Shared primitives carry `data-buzz-ui`, including portal popup roots. Legacy
native-element selectors exclude that boundary and its descendants (without native CSS scope); shared typography starts there.
For new custom compositions use the same boundary and named type roles, not old
native-element styling. Inline chips deliberately inherit their sentence's type.
Do not nest legacy UI inside a migrated boundary without explicitly migrating it.
This boundary does not imply a Panel, padding, scrolling or page lifecycle.

The host's existing `data-color-mode` drives shared dark tokens directly, and
`--buzz-text-scale` feeds the type ramp once. Root size and layout geometry do not
scale. Startup bootstrap, preferences, recovery, cross-window events and theme-color
remain owned by the existing appearance service. The viewer retains its separate
preference and full-document typography; its settings do not change the host.
BentoWorkspace still uses the viewer preference helper and is not ready for app
adoption; no workspace experiment is imported by app startup.

The host mounts the shared input-modality hook once, including cleanup. Shared
keyboard focus remains visible; pointer focus does not acquire a ring.

The actual-app Appearance/shortcuts journeys cover startup, preferences, focus,
and the temporary font/color compatibility contracts. Remove compatibility checks
as their legacy consumers disappear; no separate legacy viewer or test suite is
needed. Browser checks do not establish native or packaged acceptance. Broad scan
remains an agreed integration-batch gate.
