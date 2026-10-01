# Shared design system adoption

Buzz uses shared semantic colors, Inter and JetBrains Mono, and Base UI interaction
primitives. The visual direction follows Block UI’s controls and states. Public
fonts, packages, and generic examples keep the system independent of private assets.

Use this map to find the shared owner before changing a product surface.

## Shared owners and app uses

| Area | Shared owner | App uses |
| --- | --- | --- |
| Colors and type | Surface, text, border, affordance, and complete type roles | Host aliases forward to shared roles. Feature CSS uses role names; inline links pair text and hover roles. |
| Actions | Button and IconButton | Retry, refresh, delete, recovery, composer send, and picker triggers. Standard sizes are 32/40/52px minimums. Labels stay on one line; surrounding layouts reflow whole controls or scroll. |
| Forms and choices | Field, Input, Textarea, RadioGroup, Checkbox | Profile, community setup, appearance, plugin import, and workflow editing. |
| Search | SearchField | Channels, pages, members, and GIFs retain their query, refs, and keyboard handlers. |
| Navigation | NavigationItem | Settings, channel rows, shell destinations, Home, and community choices. Route destinations use button semantics, not tab semantics. |
| Tabs | Tabs | Emoji/GIF connects tabs to panels with Base UI keyboard activation. Workflow mode keeps its feature-owned editor view. |
| Modals | Dialog and AlertDialog | Page search, community setup, and workflow confirmations. Pending work prevents dismissal; focus restoration follows the shared contract. |
| Panels and headers | Panel and PanelHeader | Settings, channels, and companion cards share appearance. Features own grids, scrolling, docks, and subscriptions. |
| Feedback | Toast | Agent-start, live-update, sidebar preferences, and Settings recovery use a source-owned stack. Form errors, blocked pages, and lasting paused-state context stay inline. |
| Hints | Tooltip | Control hints and agent activity support keyboard access and dismissal. Controls keep their own accessible names. |
| Sessions and activity | NavigationItem, Button, IconButton, Panel, PanelHeader | Session history, agent choice, child-channel navigation, and activity actions retain unread, admission, draft, and focus behavior. Base UI owns their menus. |
| Media stages | `surface-inverse` and `text-inverse` | Preserve the stage’s existing values and measure text pairings. Renderers own image and video pixels. |

## What stays with the feature

Shared appearance does not transfer ownership of product data or interaction.

- **Rich editor:** caret, IME, selection, and completion logic stay with the editor. Completion rows keep `aria-activedescendant` while using shared colors and type.
- **Media:** GIF and image tiles retain native selection buttons and geometry. Search, retry, playback, and zoom actions use shared controls. Image zoom uses a native range with semantic colors; there is no shared Slider. The renderer owns modal focus, drag regions, playback, and timecodes.
- **Emoji Mart:** the shadow-root adapter retains native search behavior. Search mirrors the shared 40px minimum field, 12px corners, 14px body type, inset fill, metadata placeholder, and perimeter stroke. Keyboard focus and reduced motion are immediate. The widget uses the host appearance preference.
- **Disclosures:** persisted channel groups and diagnostic content retain native disclosure semantics and local state.
- **Identity and navigation:** avatars, previews, links, mentions, and thread summaries keep their existing owners. Composer mentions use inert InlineChip rendering. Editing or deleting a mention removes its explicit intent; host-owned recipient avatars can clear that intent without changing authored text. Sessions may still route to the selected or sole agent.
- **Host defaults:** Panel marks its surface separately from interactive controls, so native product and plugin content inside it can still receive host defaults.
- **Compatibility:** legacy utilities forward to shared roles for existing callers and plugins. Use semantic names and shared components in new work.

## Form adoption

Agent import uses shared Input and Select styling. Do not add feature selectors
that repaint shared inputs, textareas, or selects.

Field owns environment variable-name and link-lab URL errors. Workflow validation
stays in `editor-model.ts`, with field and step locations on each issue when known.
Form mode connects name, message, delay, and timeout errors to their controls and
reveals step options when a timeout needs attention. YAML mode shows validation
on the YAML field and restores its helper text after correction.

Unsupported conversion to Form mode is a separate notice: valid advanced YAML
remains valid and saveable. Keep request failures, permissions, and whole-workflow
problems in feature-level notices instead of marking an unrelated field invalid.
Shared styling does not change save gates, secret handling, or relay validation.

## Check a migration

Exercise pointer and keyboard paths, loading, failure, and recovery. Inspect both
themes, narrow layouts, and enlarged text in the actual app; a viewer example
cannot confirm that the host loads the right stylesheet.

Retain browser coverage for community joining, workflow save/recovery, draft and
sidebar persistence, media insertion, and focus. Media coverage includes tab/panel
associations, keyboard activation, and search clearing. Moving to shared styles is
not a reason to remove a browser journey or weaken its behavioral assertions.

Follow [the contribution workflow](contributing.md#interactive-product-iteration)
for iteration and completed-batch checks. Record deferred checks. A draft PR or
running preview does not establish native behavior or full validation.
