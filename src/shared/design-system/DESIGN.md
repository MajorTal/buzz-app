# Design guide

## Direction

Buzz adopts Block UI's visual language and semantic color grammar. Base UI
remains the behavior layer; Buzz owns styles, composition and product semantics.
Use Inter and JetBrains Mono, public dependencies and generic examples. Do not
copy private packages, proprietary fonts, internal product data or private source.

## Semantic colors

Use `color / purpose / emphasis / state`: surface, text, border and affordance.
An affordance is a control or action color. CSS spells these `--surface-panel`,
`--text-standard`, `--border-prominent` and `--affordance-subtle-hover`.
Tailwind utilities include `bg-surface-panel`, `text-standard`,
`border-prominent` and `bg-affordance-subtle-hover`. Text and border registrations
stay in separate namespaces so they cannot accidentally share a value.

Components choose roles, not palette steps. The palette is an implementation
detail, even when a role uses the same step in both themes. Add a role only for
an actual use, document it in the registry and measure its intended pairings.
Legacy utilities and host aliases remain while their callers migrate. Do not
add new uses. Whole materials such as glass still travel as one shared recipe.

Panel navigation uses `affordance-panel-hover` for its quiet hover and the shared
`affordance-selected` for persistent selection. In dark mode, the unfilled panel
row needs a quieter hover than a filled subtle control; these are distinct roles.

Anchored popup selection uses `affordance-popover-selected` (neutral 2 light /
neutral 6 dark). It stays visible on `surface-popover` independently of the quiet
neutral button and tab hover fill; mention and emoji suggestions use this
role for their active completion highlight.

## Foundations

The interface uses shared color, type, spacing and shape roles. Primary actions
are neutral. Text uses Inter for reading and labels, and JetBrains Mono for code
and identifiers. Regular (400) supports reading; Medium (500) marks labels and
structure. The Typography page documents each role’s complete setting.

Panel padding is 24px, control inset 16px, group gap 32px and page-section gap
64px at the default scale. Values are rem-based. Full-window gradient backdrops
and glass navigation support both color modes; content panels use opaque neutral
surfaces. Dark text roles are selected for contrast on their intended surfaces.
Host compatibility names resolve to the shared tokens.

Features own layout, data and behavior. The foundation guard covers `src/`,
including the Emoji Mart adapter. Layout dimensions, emoji artwork geometry and
terminal ANSI/artwork remain renderer-owned; terminal controls use shared colors
and mono type.

This guide describes how to use the system: surface relationships, hierarchy,
identity, interaction and composition. The token registry documents the available
values and their purpose.

Run `pnpm design:dev` and open `/tests/fixtures/design-system.html` to see the system
rendered from the tokens themselves.

## Identity shapes

Human avatars are circular. Agent avatars are squircles. Use the shared
Avatar `shape="circle"` or `shape="squircle"`; the shape carries identity meaning,
not density or emphasis. The caller supplies identity type from domain data,
never a name or picture heuristic. `size="fill"` fills the owning layout’s
available space. Shape clips the artwork, never the interactive focus target.
Avatar-only controls use `IconButton variant="avatar"` so the surrounding backdrop
shows through their cutouts at rest, hover, press, and while a menu is open. The focus
target stays unmasked. Its keyboard-ring recipe remains subject to the temporary focus
appearance policy below.
Circular and squircle avatars can add `statusBadge="online" | "away" | "offline"`. The dot
uses a semantic green, yellow, or grey role with light and dark values. Its inset
cutout and dot scale with the existing avatar size; the dot is separate from the
clipped artwork, and avatars without a badge retain their full shape. The agent
cutout and badge follow the squircle contour; agent badges use live presence and leave
unknown status unbadged. All three statuses use solid fills: green for Online,
yellow for Away, and grey for Offline, with semantic light and dark values.
Online retains its step-10 center inside a 1px inset, same-hue step-11
outline, which supplies the 3:1 non-text boundary on supported opaque surfaces.
Away uses an unoutlined Amber 10 fill at the designer's explicit request.
**Known accessibility tradeoff:** the light Away badge falls below the WCAG
1.4.11 3:1 non-text contrast target on supported neutral surfaces. The contrast
guard reports exact accepted light-mode role/color/surface pairs; other pairs
remain enforced. This exception is not an accessibility pass. Dark Away meets
3:1 on these opaque surfaces. Offline stays unoutlined. Keep badge footprints, Bézier
artwork cutouts, presence behavior, and accessible names with the shared Avatar owner.

For a separate trailing action attached to a row, use `IconButton shape="row-end"`
in a stretched flex slot. It keeps the size-selected width, fills the row height,
and rounds only the right corners with `radius-row`. Decorative inverse corners
on the left extend the state fill around the preceding row's rounded edge without
expanding the hit target. They inherit the fill, including hover/pressed/menu-open
states, rather than painting over the adjacent surface. Hover uses the same
contextual row highlight as NavigationItem, not the brighter floating-button
step. Shared pressed and keyboard behavior remains unchanged.

## Public identity text

Public-key recognition labels use the shared pure formatter in
`src/shared/identity/public-key.ts`: `npub…` followed by the last three canonical
npub characters by default. This is text, not a component or a new identifier.
Use `formatPublicKey` for one label; use `publicKeyLabels` for an ambiguous group
so distinct keys receive a common suffix length that makes them distinguishable.
Inputs are public identity keys in hex, never credentials. Invalid inputs produce
no label; do not echo an invalid value as a fallback. Raw hex cannot establish
whether a caller supplied a secret: callers must use public-identity fields only.

Keep the full key for routing, persistence, identity comparisons, and explicit key
copy actions. Short labels are recognition aids, not proof of identity. Full-key
inspection/export surfaces remain explicit exceptions. Reuse this formatter for new
abbreviated public-key displays; migrate existing surfaces deliberately.

Identity display names use the active naming policy, not a separate composer rule.
The default policy compares trimmed resolved names case-sensitively (`Honey` and
`honey` are different). It ranks the viewer human, other humans, viewer-owned agents,
then other agents. Unique names stay plain; ties do not choose an arbitrary winner.
Readable owner/agent labels come before last-four npub endings, extended only when
needed. These policy qualifiers are distinct from standalone abbreviated-key labels.

Views supply the comparison set: channel members for reading (plus the referenced
historical identity), DM participants for DM labels, and complete eligible choices
before search filtering for pickers and composer chips (plus existing recipients).
Removing a selected chip does not remove an otherwise eligible namesake from that
set. Repeating one identity is not ambiguous. Live profile and membership changes
update display labels, never authored message source, recipient spans, copyable
text, or notification targets. Accessible names spell out a public-key ending
when the policy uses one. With no active policy, use profile/caller fallbacks.

When an existing composer chip gains a qualifier, reveal only the qualifier with
shared settle motion; newly inserted chips appear at rest. Ordinary typing must
not replay the reveal. The suffix stays visible while a long name ellipsizes.
Removal is immediate and reduced motion disables the reveal animation.

## Posture

Buzz is a place for people and their agents to build together. Keep everyday
surfaces quiet and functional so the conversation stays central. Use character
in identity, guidance, transitions, and ceremony. Use color to convey meaning.

## Surface and depth

Use the surface that matches the content and its position in the interface.

- **Panels:** the shell uses one `Panel joined` around navigation and content on the gradient backdrop. Nested Panels keep their opaque fill and clipping but lose independent borders, corners, and shadows. The layout owner separates adjacent regions with `border-standard` hairlines. Standalone Panels keep their own outer treatment.
- **Recessed regions:** use `bg-inset` for a region pushed into its surrounding surface. Use quiet fills where they communicate separation; reserve outlines for boundaries that need to be identified.
- **Reading surfaces:** documentation and dense prose sit on `bg-panel`. Keep page-wide gradients behind product chrome and panels, where their changing contrast will not interfere with reading.
- **Borders:** use `border-standard` for quiet separators, `border-prominent` for controls, and `border-focus` for keyboard-focus recipes. Errors and warnings have their own boundary roles. Measure the actual pairing in both themes.
- **Shadows:** use the two shared elevation values and keep them subtle. Light mode relies on shadow; dark mode also raises the fill’s lightness. Do not strengthen a shadow to separate a dark floating surface.

### Floating surfaces

Menus, Select, Popover, and PreviewCard share `floating-surface`: an opaque fill,
primary boundary, panel radius, and lift. Each component owns its content spacing
and interaction. Shared material does not make these controls interchangeable.

Default and wide menus, content popovers, pickers, dialogs, and alert dialogs use
24px `radius-panel` corners. Short action menus and compact account popovers opt
into 10px `radius-row` corners, a 4px list inset, and 8px inner rows. Choose compact
for the content, never automatically because the viewport is narrow.

Floating rows use `affordance-floating-hover` (neutral 2 light / neutral 5 dark).
Supporting text becomes standard text on highlight. Keep persistent selection
independent of hover. Compact menus use `affordance-subtle-hover` with immediate
feedback and retain their separate selected fill.

### Glass

Use glass where a gradient, image, or content is visible behind it. Apply the
complete material so fill, blur, rim, and optional shadow stay together.

- More opaque glass reads as a higher layer. A brighter fill alone does not communicate the same depth.
- Keep the rim’s light direction consistent across surfaces. Use a border role when you need a visible boundary rather than a material edge.
- Avoid adding a glass fill when the region already covers an identical glass parent. Two `glass-2` layers composite to 0.77 alpha and become more opaque than either intended layer.
- Panels and chrome normally sit directly on the gradient. Text placed there needs inspection because its contrast changes with position; small decorative labels may be deliberate exceptions.

**Unresolved contrast:** opaque token checks cannot validate glass over a variable
backdrop. A rendered dark-mode sample of primary glass over Night garden ranged
from `#162e28` to `#1e4a3c`. In the brighter area, `text-secondary` measured Lc 58
and `text-tertiary` Lc 43, below their 60 and 45 targets. Review real product
content before choosing a fix: dim the backdrop, increase glass opacity, or keep
metadata off that glass surface. These measurements do not establish a general
contrast guarantee.

### Match controls to their surface

Use `Tabs variant="chrome"` for a glass pill on the backdrop and `variant="panel"`
for an underline on a plain surface. IconButton also provides a `chrome` variant.
A chrome selection can blend into a white panel; choose the appropriate variant
instead of retinting `--bg-chrome-selected` for one caller. Keep shared behavior
in one component and show both surface variants in its examples.

Panel tabs keep labels at intrinsic width and scroll within the Base UI tablist
when space is limited. Keyboard navigation reveals the focused tab. The surrounding
panel grid must have a shrinkable column so tabs do not widen other content.

## Temporary focus appearance

The shared global stylesheet currently hides focus outlines at the designer’s request
while forms are being polished. The override in `styles/globals.css` takes precedence
over the keyboard-ring recipes in this guide. This is a known visible-focus
accessibility exception, not an accessibility pass. Keep focusability,
Tab order, input modality, selection, and focus restoration intact. Do not add
local replacement rings or disable keyboard interaction. Shared text fields now use
a border flush with the field perimeter: surface-inset fill and a 1px
border-prominent stroke fading over 150ms ease for pointer interaction. The
field-scoped --border variable selects transparent, active, or error color for
the reserved 1px border, so state changes do not shift the layout. Keyboard
focus and reduced motion change immediately. Composite fields own one stroke
around the input and actions; error strokes retain priority. Placeholders use
text-metadata, one step quieter than supporting text, in both themes. This supersedes
the older keyboard-only
and no-container-ring recipes for these fields. Existing component
recipes remain so this temporary visual decision can be reversed in one place.

## Surface-aware interactions (proposed)

Opaque surface owners provide a CSS interaction recipe: `interaction-panel`
(default and Panel) or `interaction-floating` (Dialog, floating-surface and
popover-surface). The recipe follows the painted DOM root, including portals;
there is no React provider or runtime color detection. Native modal adapters
using the floating fill opt into the same utility. Transparent groups inherit;
a nested opaque Panel resets. Feature-only surfaces must opt into the recipe
matching their paint; an arbitrary background utility alone is not a context.

Inherited custom-property aliases resolve on the owner, not again on each child.
The ordinary recipe binds at every theme owner (`:root` and scoped `.dark`),
including always-dark media inside a light app. This default belongs in the base
layer: explicit floating, nested Panel and semantic recipes must win on the same
node. Adding a scoped theme requires rebinding its dependent aliases too.
Do not override upstream `--affordance-*` values on a wrapper to retint controls.
The existing semantic exceptions have named shared recipes: `interaction-availability`
on the status owner uses `data-status="online" | "away" | "offline"` (unknown stays
neutral) for the documented status capsule fills, while `interaction-navigation`
on the sidebar keeps channel rows and session selection equally quiet. Apply these
only to their semantic owners, not as general styling escape hatches. Button and
NavigationItem still do not accept caller-supplied `className`; popup portals keep
their own floating recipe. Availability's existing contrast exceptions remain
recorded in `docs/presence.md`.

Actions consume contextual fill/hover/pressed/selected/boundary roles rather than
redefining global semantic tokens that also color avatars or chips. Floating
rows remain transparent at rest, then use the existing floating highlight with
standard supporting text. Persistent selection is separate from hover. Compact
menus retain their quieter highlight and use a distinct selected fill.

Fields retain surface-inset and their existing invalid/disabled/focus behavior;
only active boundaries adapt to the surrounding surface. Actions inside an
InputGroup reset to the ordinary recipe because their backdrop is the inset
field. Unchecked checkbox/radio and outline boundaries use the contextual
boundary too. Prominent/destructive actions and switch geometry/state colors
are unchanged. No extra hover affordance is added to static content.

The floating control mappings are proposed, not an accessibility certification.
Dark floating action fills are neutral-6/7/8 at rest/hover/press, on the
neutral-raised (#282828) floating surface; those fill edges are below 3:1. The contextual control
stroke uses neutral-9 and clears 3:1 against that outer surface. This proof does
not change focus appearance: the viewer's temporary outline suppression remains,
while the host's separate stylesheet still renders keyboard rings. That existing
host/viewer mismatch needs a separate decision. Glass/inverse/media surfaces
retain their existing explicit treatments, outside this opaque-surface proof.

The Floating surfaces viewer shows actions, rows, fields and choices in actual
shared Panel/Dialog/Popover components, including a nested Panel reset. Verify
both themes, portals, supported states and actual product flows before adoption
is called complete; token math alone cannot validate the CSS cascade.

## Controls

Button and IconButton share prominent, subtle, ghost, inverted, destructive,
outline and link emphasis. Inverted is for an inverse surface; link keeps its
background clear and underlines on interaction. Their 32 / 40 / 52px sizes are sm / md /
lg at the default scale, with minimum
heights that accommodate larger text. Text buttons use `--radius-capsule`
(1.625rem / 26px): capsule-shaped through the default 52px large size,
clamped naturally on shorter controls, and bounded on taller ones. Reuse this
role for similarly sized actions; `--radius-pill` remains the fully round role
for circles and pills of any height. Fields retain `--radius-control`.

Button labels stay on one line and do not shrink in flex layouts (`whitespace-nowrap
shrink-0`). Parents must reflow whole controls or provide
scrolling when space is limited. Composite reply summaries may reflow whole
avatar/count groups without wrapping individual labels. Small buttons use 16px
side padding and 16px icons; medium and large use 24px side padding and 24px icons.
Standard Button labels use the complete `text-label-sm` role with an 8px icon gap; the
extra-small capsule uses `text-caption`.

IconButton defaults to round and uses the same sm/md/lg sizes. Existing names
remain compatibility aliases: primary/solid → prominent, quiet → subtle,
compact/toolbar → sm, default → md, large → lg. Do not add new alias call sites.
Buzz's tint and chrome icon variants remain for composer and backdrop actions.

Disabled controls retain their filled, outline, or unfilled treatment and cannot
activate. Loading retains the label's geometry, accessible name, focus and variant
colors while blocking activation; never swap in a differently sized loading label.
Pointer hover uses shared state timing; expanded triggers retain pressed emphasis.
Keep keyboard-only focus and reduced-motion behavior owned by the system.

IconButton also offers `xs` (20px with 12px icons) for dense formatting actions. Mode
toggles remain `sm`.

IconButton defaults to round across all sizes and variants. Use `shape="control"`
only when a rectangular control shape is explicitly needed. Disabled ghost icons
remain unfilled; their muted foreground communicates unavailability without
adding a container to an otherwise empty toolbar.

Composer picker surfaces use the 24px `--radius-panel` role and the shared
popup motion below. Filtering does not stagger results. Search fields follow
the shared form treatment below.

Field groups label, input, help and error using Base UI. Input and Textarea
carry the shared field appearance. RadioGroup is for one choice, Checkbox for an
independent choice and Switch for an immediate on/off setting. Use the native
form semantics exposed by those Base UI primitives rather than duplicating them.

For finite choices, use Select: its inline layout fits compact toolbars and
`variant="field"` fits labelled forms. The proposed `variant="compact"` fits
trailing row choices: a small ghost trigger with a visually hidden accessible
label, bounded single-line value, and full choice text in the popup and value hint.
Its popup has an 11.25rem minimum (bounded by the viewport) and reserves the
selection-mark slot in every option so selecting the widest label cannot resize it.
The caller owns its column width. `align="end"` anchors a trailing choice popup
to the trigger’s right edge; the default remains `start`. Pass `disabled` explicitly
when the choice is unavailable. For searchable choices, use the shared Combobox parts; keep
filtering, custom-value commits, and async requests with the feature. Its Control
owns the label, input and integrated browse caret; Popup and Item own the shared
menu presentation. Use its loading state while discovering options, and keep
retry/cancel actions with the feature. Do not style a native select as an Input
or attach a separate round button to mimic a combobox.

### Form composition

Select and Combobox chevrons rotate 180 degrees to reflect the trigger's
aria-expanded state. Use duration-state (150ms) with easing-settle for a
reversible transform transition. Keyboard navigation and reduced motion switch
the orientation immediately. Loading indicators keep their separate behavior.

Fields share a 40px minimum size at the default scale, the control radius,
text-body (14px / 20px), and the 16px control inset. Derive vertical padding from the control
size, text line height, and boundary; do not force a fixed height that clips
larger text or wrapped Select values. Textarea uses the control inset on all four
sides (16px at the default scale), with manual vertical resizing and a code variant.
In Chromium and WebKit, the native resize grip uses text-metadata and sits 4px
(space-1) inside the corner. Keep it visible at rest. Preserve the native resize hit target and
leave the browser grip unchanged where custom resizer styling is unsupported.

Use Field once per input/textarea, with an 8px internal gap. Select's field
variant, SearchField, and Combobox.Control already own their label and supporting
text; do not add a second Field around them. Use description/error for connected
help and validation. An error replaces the secondary description until it clears;
keep the accessible description synchronized with the visible message. Validation
strokes belong to the outer field, never its auxiliary buttons. Keep feature-owned
asynchronous status connected through
aria-describedby. Forms own 16px between adjacent fields and the 32px section
gap between named groups.

InputGroup shares the inline frame for SearchField and Combobox. Icons use an
8px gap, and trailing actions retain a stable slot. SearchField uses the same
12px control radius as other fields, with no separate navigator shape. Focus belongs to
the input or action,
while the frame owns the active perimeter stroke. Read-only values can be
read and copied; disabled actions cannot change a value. Search clear restores
input focus. Features still own filtering, custom values, and async recovery.

SearchField, Combobox.Control, and code Textarea default to no autocorrection,
capitalization, or spellcheck. Callers can override these defaults explicitly.
Ordinary Input and prose Textarea retain platform defaults. Check the defaults in
`ui/SearchField.tsx`, `ui/Combobox.tsx`, and `ui/Textarea.tsx` when adding an exact-text
field.

The Forms page in Just Design documents states, usage, and a form-in-dialog
example. Review it with both themes, narrow widths, and enlarged text before
introducing another form treatment.

Select and Combobox popups use a 150ms entrance and 120ms exit from the shared
state/fast duration tokens. Fade opacity with easing-state and move 4px from the
trigger with easing-settle, reversing the direction above the trigger. The
designer-requested blur from 4px to zero is a narrow exception to the general
no-blur-animation rule. Base UI owns transition presence and dismissal; keyboard
navigation and reduced motion remove the transition, movement, and blur.

### Menus, popovers, and choice rows

Use Menu for actions and lightweight choices, Popover for supporting content or
short forms, and Select/Combobox for form values. Both anchored surfaces reuse
`floating-surface`, viewport collision handling, and the shared popover layer.
Features own their data, callbacks and save/cancel behavior; Base UI owns focus,
keyboard navigation, positioning and dismissal.

Menu group labels belong inside MenuGroup. Selection checks sit at the trailing
edge; the pointer/keyboard highlight is independent of that persistent selection.
Keep the parent row highlighted while its submenu is open. Use `tone="danger"`
for destructive actions and MenuNote for explanatory or status copy outside the
keyboard item list. Long lists scroll inside the popup.

ChoiceRow arranges a label, wrapping description, optional artwork and trailing
metadata. It adds no second click target or tab stop. Keep its slots non-interactive
and let the containing item own state and padding. Use the small shared avatar
for identity choices, retaining human/agent shapes.

PopoverPopup uses 16px content padding, or `padding="list"` when its rows own their
spacing. Use `size="compact"` with list padding for short account/action surfaces: 14rem
width and 10px corners. `MenuPopup size="compact"` uses the same corner, inset, row and
hover treatment for short action lists. Content and wide popovers retain 24px corners.
Name it with PopoverTitle or aria-label; PopoverDescription connects
supporting copy. Hover opening is optional and remains configured by its feature.
Use `padding="none"` for an embedded picker that owns its internal spacing, such as
emoji/GIF content.
Menus and popovers use a quicker version of the form dropdown motion: 75ms entry
and 60ms exit (half the state/fast duration tokens), a 2px offset and blur-to-sharp
opacity fade. Movement uses
easing-settle; opacity and filter use easing-state. The offset follows the actual
placement side toward the trigger, including collision flips and nested menus.
This extends the designer-requested blur exception to these anchored surfaces.
Keyboard navigation and reduced motion remove transitions, movement, and blur. The Just
Design Menu, Popover and ChoiceRow pages
show these contracts and their compositions.

## Compositions

PanelHeader owns one consistent header frame: leading `navigation`, title/icon,
and trailing `actions`. Use a toolbar IconButton with ArrowLeft for a local back
action and X for closing the panel. The default 2.5rem (40px at the default root size)
minimum height aligns conversation,
thread, profile, tabbed workspace, and Todos headers. The compact variant shares
this height. Headers use 0.25rem inline padding (matching the centered 2rem controls’
block inset), 1rem identity icons, and
0.25rem gaps between action buttons without reducing their hit areas. Navigation
tabs use 1rem icons or fill avatars and 0.5rem leading padding.
Header spacing, icons, and controls scale with rem; separators remain
1px hairlines. Titles and actions may wrap when their content needs more room.
Navigation state, focus restoration, and content transitions belong to the host.

Composer pickers reuse PopoverPopup and anchor above the whole composer with a
4px gap, preserving the shared popup behavior and material.

Dialog composes a Base UI modal with a shared title, optional description, body,
close button and actions. Pending operations set preventClose so Escape and the
close button agree. It retains the app's explicit dismissal behavior: outside
clicks do not discard a form by default. Channel-management modals explicitly
opt into `dismissOnOutsideClick` and reuse their Cancel/Close path, including
nested confirmations that dismiss only their own layer. `preventClose` blocks
pointer dismissal as well as Escape and Close. Provide initialFocus for search dialogs and
finalFocus when a flow has an external trigger or opens a second dialog.
An explicit finalFocus applies only while focus is still in the closing popup
or on the page body. If the user already moved focus elsewhere, closing leaves
it there, as the default `true` does (`ui/finalFocus.ts`, shared by Menu,
Popover and Dialog).
Editors can supply `headerActions` beside Close and `leadingActions` before the
trailing footer actions. Footer actions wrap as whole controls, never shrinking
single-line labels. When one action exceeds the available width, the footer
scrolls horizontally from a safe start edge so both ends remain reachable.
`onEscape` may return true to consume Escape for an
inline layer (such as an inspector) before dismissing the dialog. Nested modal
layers still use Dialog so Base UI owns their focus trap and dismissal order;
`placement="right"` and explicit `dismissOnOutsideClick` suit inspector sheets.
Use `size="expanded"` for viewport-filling reading surfaces such as code diffs;
the body scrolls while the shared title and close action remain available. This
changes only size, not modal ownership or dismissal behavior.
Use `text-label` (16px, 500 weight at the default scale) for the shared Dialog
title. Group the title and optional description with `--space-2` (8px), beside
the close button so its hit area does not enlarge the text gap. The body owns
vertical padding matching the dialog's horizontal padding: `--space-6` (24px),
or `--space-4` (16px) at the compact breakpoint. Do not add an outer flex gap
on top of that body padding. Create/Edit channel forms opt into
`headerGap="compact"` for a 12px heading-to-body gap at every breakpoint;
other dialog compositions retain their default spacing. Their privacy confirmation
steps also opt into `footerGap="compact"` for 8px between the final checkbox row
and the actions; returning to the form restores the normal body-bottom padding.
For a bounded dialog with fixed controls above a list, use `height="stable"`
with `bodyLayout="flex"`. The body becomes a non-scrolling flex column; the
feature supplies a `flex: 1; min-height: 0` composition with fixed controls and
one flexing scrollport. Keep all results and recovery feedback reachable in that
scrollport. Without footer actions, the flex body omits its bottom padding so
only the popup supplies the outer bottom gutter. With actions, it retains the
body-to-footer spacing. The default flow layout and other dialogs remain unchanged.
The shared Dialog uses state opacity and settling transform tokens for a centered
0.98-scale entrance, with fast timing on exit. Base UI owns transition presence;
keep the controlled component mounted while setting `open={false}` for an exit.
Reduced motion, keyboard navigation, and Escape dismissal are immediate. Pass
`motion="none"` for frequently used surfaces such as the search palette.
Channel Create/Edit privacy confirmation opts into a keyed `step` inside that same
modal. The complete surface crossfades over 200ms with 4px blur: the form grows to
1.05 while confirmation grows from 0.95 to 1; returning reverses those positions.
This explicitly requested, bounded dialog transition is an exception to the
no-blur rule below, not a new default for dialogs. One stable Base UI title and
description label the modal; outgoing content is inert and hidden from assistive
technology. Reduced motion, keyboard navigation and `motion="none"` swap steps
immediately. The caller still owns draft state and focus between steps; no second
modal, backdrop or write owner is introduced. This opt-in is for content-sized,
centered dialogs; expanded, stable-height and side-sheet compositions are unchanged.


Use Accordion for collapsible sections. Form sections pass `keepMounted` so
collapsing them preserves local input state; leave the default for static content.
Use `variant="form"` when the surrounding form owns spacing. It removes outer
margins while keeping the shared row and panel padding. Adjacent disclosure rows
form one stack; avoid inserting form-section gaps between individual rows.

Use Tooltip for short hints on labelled controls; use PreviewCard for richer
content. Tooltip owns its description link and inherits placement, focus and
Escape behavior from Base UI. Overlay layers keep menus and hints above dialogs.
Hints use text-caption (12px / 16px), with space-1 vertical and space-2 horizontal
padding. Pointer entry uses the shared state duration (150ms), fading from a
0.97 scale, 2px downward offset and 2px blur; exit reverses it with the fast
duration (120ms). This designer-requested blur is a tooltip-specific exception.
Base UI instant states and keyboard navigation skip transitions; reduced motion
keeps only the fade.

ToastProvider mounts once in the host. ToastNotice belongs to the source that
owns its state and recovery: unmounting the source removes its notification,
without reporting user dismissal. Gate notices from hidden Settings sections
explicitly; portals do not inherit a hidden ancestor. Keep form errors and
blocked-page recovery inline.

Use `useToastNotification` for completed-action feedback that must outlive its
source row (such as copying profile metadata); the host stack owns its finite
expiry. Keep source-owned recovery on ToastNotice.

Use a finite timeout for transient feedback. Recovery defaults to no expiry and
no dismissal unless the source supplies onDismiss; preserve all recovery actions.
The bounded, scrollable stack keeps older actions available without covering the
shell header or composer. F6 enters notifications, Tab reaches actions. Modals
remain above the stack. Content updates do not restart expiry; timeout changes do.

Tabs with content use renderPanel, which lets Base UI connect each tab and panel.
Route navigation uses NavigationItem with aria-current instead. Tabs can also
compose NavigationItem through the `navigation` variant: these retain tab
semantics, use 12rem widths with ellipsis and a subtle selected fill, accept
avatars/icons, and place a sibling close
button over reserved trailing space. Navigation tab strips scroll horizontally with a
thin native scrollbar. The main
channel header uses the same control with a single non-closable tab with
`showSelection={false}` (no selection or hover fill); channel
actions remain in the header action slot. The settings launcher uses
`data-highlight-expanded="false"` to preserve disclosure semantics without a
sticky pressed treatment; the selected tab owns the open-state indicator.

NavigationItem
offers an `option` variant for picker rows with even 8px padding and immediate
hover feedback. It forwards normal button events, refs and data attributes so unread observation,
preloading and product shortcuts remain with the caller.

PreviewCard may expose one supplemental action through `actionRef`, such as copying
an identity's full npub. Action previews open without a delay so immediate Tab
navigation reaches the action. They remain non-modal and never take focus on hover. Tab
from the trigger reaches the action; Shift+Tab returns to the trigger; forward Tab
continues after the trigger. Escape dismisses the preview before restoring focus,
but never pulls focus back if the user moved it during exit. Closing previews
are no longer Tab destinations or pointer targets.
Scrolling anything that contains the trigger dismisses a hover-opened preview: a
still pointer cannot report that its trigger moved away. A keyboard-focused
trigger keeps its preview, hidden while the trigger is scrolled out of view
unless focus is inside it.
The positioned portal owns its layer above dialogs. An optional content anchor
keeps previews near compact identity content inside wider actionable rows. Identity
previews prefer above that content (with Base UI collision handling), leaving
the hovered row’s trailing action unobstructed.

## Menu row corners

Default and wide menus use `--radius-pill` for every row. First, middle, and last
items keep the same highlight shape, including grouped choices and submenu
triggers. Compact menus use their shared 8px inner corners within the 10px outer
surface.

Use these shared recipes. Do not add positional or feature-local radius overrides,
derive a new inset radius, or change the global row radius for one menu.

## Align row content, not state backgrounds

When composing NavigationItem lists inside dialogs or padded panels, align the
leading content column with the heading. With icons, this means the icon slot;
labels form a second consistent column. Give mixed icons and identity fallbacks
the same slot (24px in the page search palette), retaining each
icon's intended size within it.

The hover and selected backgrounds may extend beyond that content edge. Offset
the list wrapper by the existing `--space-control-inset` rather than removing
NavigationItem padding, moving the heading, or overriding the row's paint. The
surrounding composition owns this offset; it is not a global navigation change.

Preserve at least `--space-2` of outer gutter. At the dialog's compact breakpoint
(480px), its padding is 16px, so reduce the outward offset from 16px to 8px. That
small content inset is intentional: the row background and keyboard focus must
stay clear of the dialog edge. Scrollable lists also need space inside their
scroll container for the focus outline; account for that space in the offset.
Align empty-state text with the same leading content column.

Check the composition with no highlighted row, hover, selection and keyboard
focus, in both themes and at narrow widths and enlarged text. Content alignment
should remain legible without a state background to explain it.

## State

Define default, hover, pressed, focus, selected, disabled, and loading states where
they apply. Keep the same control recognizable across those states.

- Pressed changes the fill without moving the control.
- Loading preserves the label’s space and blocks repeated activation in behavior, not just CSS.
- Hover adds contrast appropriate to the surface: a light row darkens, while a dark chip may lighten.
- Selection remains visible after the pointer leaves. A selected toggle-group item does nothing when selected again and has no hover treatment.
- Disabled means unavailable. Do not use it as a quieter text-emphasis level.
- Keep a way to recover visible even when a state assumption or visibility rule is wrong.

## Emphasis

Use three text levels: primary content, supporting text, and metadata. Primary
and supporting text should carry most of the interface. If you need more hierarchy,
first adjust size, weight, position, or grouping rather than adding a fourth color.

Name borders for their purpose: quiet separation, control boundaries, or focus.

## Type

Use complete type roles when building a screen. The raw ramps (`--type-size-*`,
`--type-leading-*`, `--type-tracking-*`, `--type-weight-*`) supply values; roles combine
them into Tailwind utilities such as `text-body`. Both live in `styles/typography.css`.

Color and type roles use separate namespaces. Color registers as `--color-*`; type
registers as `--text-*`. For example, `text-standard text-body` combines a color with a
complete type setting.

The active sizes are 12, 14, 16, 18, 20, 24, 28, 32, 36, 44, 56, 72 and 96px
at 100% interface size. Sans roles use Inter and mono roles use JetBrains Mono.
Values scale with the host interface-size preference.

- Components use named roles, never private primitive sizes. The viewer shows
  each utility’s semantic role and complete setting alongside the size ladder.
- A role carries size, leading, tracking and weight together. Display, title,
  and heading roles use unitless 1.1 leading so wrapped headings have breathing room.
- Regular (400) is for reading; Medium (500) is for labels and structure.
  Existing `font-semibold` consumers resolve to Medium.
- Mono uses `detail/body-xsmall` at 12/16 with 0.03em tracking.
  `--type-xsmall-size` points to the existing 12px step, keeping the semantic
  independent from caption even though their sizes currently match. `text-mono-lg` and
  `text-mono-sm` are compatibility aliases for this same setting, not extra sizes.
- Caption uses 12/16 and 0.0133em tracking. Buzz’s `text-body` uses 14/20; `text-label` uses 16/24 and `text-body-lg` uses 20/28.
- Preserve text preferences and browser zoom. Author values in scaled rem and
  keep layout geometry independent of text scaling.

Typography provenance: the ramp and role settings derive from the pinned
[Block UI typography
specification](https://github.com/squareup/design-blockinterface/blob/eff766161ba8aaee3258ca107f0d904dd542c708/blockUI/docs/type.resolution.draft.json).
The values documented above define this system, including the 12px xsmall role.

## Both modes

Design and inspect light and dark mode together. Elevation, glass, and accent text
need their own values in each mode.

- Accent text is darker than its fill on light surfaces and lighter on dark surfaces.
- Tints are pale in light mode and deep in dark mode; their names describe their purpose.
- Check text with its actual fill and backdrop, including interactive states.
- The original design exploration was light-only. Buzz’s dark values are authored choices and should be revised when rendered evidence shows a problem.

## Density and rhythm

Choose the content structure first: a list, reading column, gallery, settings
group, or workspace. Use generous space by default, with tighter relationships
inside a group than between groups.

- Dense data uses edge-to-edge rows and dividers where a line helps track the row.
- Distinct swatches, type samples, and avatars often need only space between them. Avoid adding a card or divider when the content already separates itself.
- Show samples on the surface where they will be used. Glass needs a backdrop; a white swatch on white needs a quiet boundary.
- Cards group widgets, gallery items, or settings. They sit on `bg-panel` with spacing or a hairline and have no default fill. Use `bg-hover` only for an interactive card’s hover state. There is no `bg-card` role; `bg-inset` is for recessed content such as inputs or code blocks.
- Use native thin scrollbars: `scrollbar-width: thin` and `scrollbar-color: var(--scrollbar-thumb) transparent`. The thumb is gray in both modes. Load the shared recipe into vendor shadow roots and let the browser control scrolling and visibility.

## Motion

Use motion to explain a change in state, position, or structure. Remove animation
that adds no useful information.

Direct manipulation follows the pointer without easing. Apply settling motion
after release, and prevent a drag from selecting text it passes over.

Keep blur fixed during general surface transitions; animate opacity instead.
The form dropdown, menu, popover, and tooltip sections document narrow,
designer-requested blur exceptions. Respect each component’s keyboard and
reduced-motion treatment.

## Colour structure

The palette supplies values. Semantic roles name their purpose. Components and
screens consume those roles so one shared edit can change every caller.

| Layer | Example | Used by |
|---|---|---|
| **Palette** | `--purple-9`, `--neutral-4` | Shared token definitions; each hue has authored light and dark steps. |
| **Roles** | `--surface-panel`, `--text-danger`, `--affordance-subtle-hover` | Component recipes and product screens. |
| **Components** | Button, Input, Dialog | Product features that need the same appearance and behavior. |

Choose a role by its job, even when it uses the same palette step in both modes.
Add roles for real uses and their required states; document the intended surfaces
and paired text. Do not generate unused role families from every palette hue.
Existing palette utilities and older role names are compatibility APIs while
callers migrate, not the default for new UI. Tailwind's stock palette is removed.

### Changing a color

Change a semantic mapping when one job needs a different value. Change a palette
step when its value is wrong for all roles that share it. Measure the actual
pairings in both themes; a numbered step alone does not guarantee contrast.
For example, warning boundaries use amber-11 in light mode and amber-9 in dark,
because the lighter amber steps cannot identify a control against a light panel.

Palette values are based on Radix Colors (MIT), with authored neutral ramps and
documented adjustments in `tokens.css`. These are values, not a component or
behavior dependency. Base UI remains the component behavior layer.

### Naming and usage

Use purpose, emphasis and state: `surface-panel`, `text-subtle`, `border-danger`,
`affordance-prominent-pressed`. Text and border roles register in their own
Tailwind namespaces so a border cannot accidentally inherit a text color.

- Use `text-danger` for error text and pair it with the documented surface.
- Add a categorical role when a feature needs to distinguish identities by hue.
- Keep transparency in shared material recipes. Do not dim tokens locally.
- Author both light and dark values; do not derive one by dimming the other.
- When two roles share a decision, reference the same token rather than copying a literal.

## Contrast

Buzz checks opaque text pairs against both **WCAG AA (4.5:1)** and its existing
**APCA** targets: Lc 60 for body/UI text and Lc 45 for metadata. Small metadata
still needs the normal-text WCAG ratio. Control and state boundaries use the
separate WCAG 3:1 non-text ratio; decorative separators and hover fills do not.

- **Use both measurements.** The ratio establishes the AA floor; APCA adds a
  polarity-aware readability check. A perceptual pass alone does not establish
  WCAG conformance, and a numeric pass does not replace rendered inspection.
- **Adjust the fill to support readable text.** If neither black nor white is legible on a solid fill, change its lightness while preserving the hue.
- **Derive paired text from its fill.** Generate `text-on-*` with the fill instead of setting it independently.
- **Share the pairing logic.** Desktop, mobile, and web use one implementation.
- **Size a text step against the worst surface it can land on**, including
  hover, pressed and selected fills. A step that only clears a panel at rest
  can fail when a menu row highlights.
- **Dark mode is not light mode inverted.** APCA is polarity-asymmetric:
  light-on-dark needs more separation than the same WCAG ratio suggests. The
  dark ramp's text steps are therefore lighter than a mirrored ramp would put
  them — steps 9 and 10 sit above where linear spacing would.
- **`text-disabled` is deliberately below target.** Low contrast is the signal
  that a control is unavailable. Never put information a person needs there.
- **`pnpm design:check` enforces this.** Every text role is measured against
  every surface it can sit on, in both modes, parsed from `tokens.css` so the
  check cannot drift from the tokens. Keep exceptions in the owning guard with a stated reason.
- **Check identity text on tint hover.** Measure its `text-*` role against the highlighted tint as well as its resting surface.
- **Decorative dividers have no contrast target.** WCAG’s 3:1 non-text requirement applies to boundaries needed to identify a control or state. Keep quiet grouping lines distinct from required control boundaries.
  Error and warning boundary roles must reach 3:1 against surface-base,
  surface-panel, surface-inset and surface-popover in both themes. The contrast
  guard checks these role mappings and status dots separately from text and
  decorative dividers.

### Link contrast

Inline links and mentions use Blue 11 with Blue 3 hover in both modes.
Blue 11 is tuned for the supported surface stack: #0b5fa8 in light mode and
#83c4ff in dark. These pairs have no link-specific contrast exemptions.
The contrast guard checks APCA and WCAG AA (4.5:1) on opaque text pairs, including
hover and pressed fills. Metadata uses neutral 9 (#5f5f5f) in light mode so small
labels remain readable even on the pressed neutral 4 surface.

### Quiet surface stack

In dark mode the panel is #1a1a1a, inset #101010, subtle control #232323,
popover #282828, ordinary control hover #2e2e2e, and floating row hover/ordinary
selection #333333. Floating controls and selection use #404040, with control
hover #595959 and press #737373. The popup separates from the panel without
consuming the ordinary control hover range.
In light mode panels and popovers remain white, inset/control fills #f5f5f6,
control hover #f1f1f2, floating row hover #f5f5f6, ordinary selection #e8e8e8,
and floating selection #dadada.
Borders stay decorative unless needed to identify a control or state.

### Relative sizing

Use rem for authored UI dimensions and spacing, semantic roles for text, and
unitless line-height. Dimensions are based on a 16px root at the default interface size.
The host interface-size preference scales the root, so text, numeric icons and
rem layout spacing grow together. Keep physical hairlines, optical offsets, and runtime
geometry returned by the browser or media APIs in pixels. Sidebar resize limits
and its 650px navigation breakpoint remain paired with their JavaScript owner;
the timeline measures its rem-sized leading region for Virtua's pixel start margin.

## Writing

Use direct, familiar language and remove words that do not help someone decide or act.

- Labels describe the action or destination in the reader’s terms.
- Empty states explain what belongs there and provide a useful next step.
- Errors explain what happened and how to recover, beside the affected control.
- Keep names and capitalization consistent across the flow.

## Accessibility

Give every interactive element an accessible name, with one owner for each label.
Use paired text roles on colored surfaces and verify the rendered contrast.

Keep keyboard, pointer, and shortcut paths consistent. When adding an input handler,
identify and check every supported way to reach the action.

The intended focus recipe requires both `html[data-keyboard-navigation]` and
`:focus-visible`. The app-root modality owner supplies the attribute; pointer
focus stays quiet, including programmatic focus during a drag. The shared global
outline suppression is a temporary exception: follow
[Temporary focus appearance](#temporary-focus-appearance) rather than adding a
local replacement.

Pair color with text, shape, or position. Solid avatar status badges are an explicit
product exception, including the light Away badge’s accepted contrast shortfall.
Preserve their fills and expose known status through the owning accessible label
or description. See [Identity shapes](#identity-shapes).

## Responsiveness

Check narrow, intermediate, and wide layouts, including enlarged text and browser
zoom. Use relative units for readable content so the interface respects the
person’s size preference. Allow content to reflow before it clips.

## Growing the system

1. Use an existing component before assembling its appearance yourself.
2. Choose a semantic role by purpose. Add a state sibling when the actual control needs it.
3. Keep each new role paired in both modes, document it in the token registry, and check contrast.
4. Fix shared decisions in their owner. Do not cancel shared styles from a feature stylesheet.
5. Keep layout, media geometry, editor semantics and data behavior with their product owner.

## Components

Reuse and compose existing components before adding another.

- **Behavior:** inspect Base UI before building an interactive shared component. Use its matching primitive for focus, keyboard behavior, positioning, portals, and dismissal. Buzz owns appearance and product semantics. Use native elements where Base UI has no matching primitive or the component is static.
- **Variants:** add a missing visual variant for a real use and mark it proposed. Do not cancel several existing states to force an unsuitable variant to fit.
- **Props:** use named variants for visual differences, never a new boolean appearance prop. Keep data and behavior props distinct from appearance choices.
- **Ownership:** keep a component with its first feature. A second real use can justify proposing it as shared.
- **Focus recipes:** require `html[data-keyboard-navigation]` and `:focus-visible` on the control. Do not rely on a base-layer reset to override component-layer styles or add a `:focus-within` ring around its container. Preserve these recipes while the temporary global outline suppression is active; shared fields follow the perimeter-stroke exception documented above.

## Using the system

Choose a component and a role by their purpose:

| Need | Shared role or owner |
| --- | --- |
| Page background | `surface-base` |
| Panel or card surface | `surface-panel` |
| Popup | `surface-popover` |
| Recessed region | `surface-inset` |
| Control states | Affordance roles |
| Labels and reading text | Text roles |
| Edges | Border roles |

When a shared role fails in context, measure its supported surfaces and repair the
shared decision. Do not substitute a palette step in one feature. For example,
`border-primary` uses neutral-4 in light mode and neutral-6 in dark so its quiet
boundary remains visible on both page surfaces.

A role names a purpose even when it uses the same palette step in both modes.
Repeated visual treatments belong in the system. If a real design exposes an
unsuitable rule, explain the conflict and improve the rule rather than working
around it locally.

## Icons

Phosphor is the only general icon family. Import named icons from `icons/index.ts`,
which re-exports individual upstream modules. Add exports as needed; no approval list.
SVG-only widgets use individual assets through `icons/svg.ts`. Do not import the
upstream packages elsewhere or reintroduce other icon libraries. All six native weights
remain designer choices: no size-to-weight or selection-to-fill rules. For chat and
conversation metaphors, prefer the rounded `ChatCircle` family (including `ChatsCircle`)
over square or teardrop variants; choose the matching dots, text, or slash variant when
the meaning requires it. Keep accessible names on controls and decorative artwork hidden
from assistive technology.

OneDrive is a designer-approved custom brand mark: its complete outline is recreated on
Phosphor’s square canvas, uses the same current-color and sizing behavior, and stays in
the shared icon gateway. It does not permit another general icon library.

### Picker search and choices

Mention and media pickers opt into `SearchField variant="capsule"`. Its shared
`search-field.css` recipe also styles Emoji Mart inside its shadow root: body-sm
typography, pill radius, standard panel fill, Phosphor icons, and a 32px clear
action. Other SearchField callers retain the default field treatment. Scrolling
picker results use the opt-in `buzz-thin-scrollbar` native scrollbar recipe.

Mention choices use `NavigationItem variant="option"` with 8px padding and
immediate hover/focus feedback. The picker owns arrow-key navigation and exact
identity selection; rows retain ordinary button semantics.
