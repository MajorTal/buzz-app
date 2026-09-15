# Design-system adoption

Base: PR #59 (`95a0196`). Adoption uses the existing palette, typography,
sizes and variants. Features continue to own layout, data and behavior.

## PR A: actions, switches, avatars and icons

- Settings action buttons use `Button`; shell icon actions use `IconButton`.
  Destructive Delete keeps its existing danger treatment until the shared system
  has an appropriate variant; adoption must not remove this existing cue.
- Notification and plugin settings use `Switch`. Its accessible-only label
  supports plugin rows that already render their name. Read-only busy switches
  preserve focus and reject activation; labeled switches support label clicks.
- Profile triggers, message and membership identities, thread participants and
  mention results share `Avatar`. Media resolution remains with callers. The
  existing single-initial treatment replaces local two-initial fallbacks;
  `alt=""` marks decorative artwork without duplicating its parent's label.
- React UI icons use Tabler. Emoji Mart's internal SVG adapter and supplied
  launcher/identity artwork remain outside this migration.
- Removed the legacy shared avatar, local avatar appearance and shell icon CSS.

The viewer's **Component adoption** page at
`/tests/fixtures/design-system.html#/design/component-adoption` compares historical
presentation specimens from #59 with the live shared components. The before
recipes are scoped to the viewer and retain #59's tokens, which this PR does not
change. They are not complete-screen screenshots. Both columns support light and
dark mode; synthetic controls never invoke app services. Keep these historical
recipes out of production imports.

## Remaining adoption batches

| Area | Remaining work |
| --- | --- |
| Forms and dialogs | Shared field/textarea and dialog presentation with actual callers |
| Navigation | Settings/page/channel destinations and channel search; preserve navigation semantics and prefetch behavior |
| Composer and pickers | Tool actions, search and tab presentation; preserve draft, selection and focus behavior |
| Startup/recovery | Shared actions in FOUNDATION files require explicit guidance |
| Compatibility | Remove old native-element styling and aliases as the remaining consumers migrate |

## Validation for the interactive draft

Type/design checks and focused behavior checks accompany the implementation.
The comparison and the actual app still need human visual review. Full `just scan`,
the complete browser matrix and native acceptance remain integration gates, not
claims established by this draft. No new compact recipes or toolbar contribution
APIs are part of PR A.
