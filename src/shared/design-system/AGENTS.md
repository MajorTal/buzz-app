# Design-system rules

This is the canonical policy for new and migrated Buzz UI, including product
consumers, the standalone viewer and design-system tooling—not only this folder.
The root and viewer instructions route here; they do not copy these rules.
`DESIGN.md` explains decisions and examples; `README.md` owns setup and commands.
The registries and live viewer own the inventory, not a second handwritten list.

## Choose and grow the system

- Use existing shared components and their variants before assembling styles.
  Product code owns composition, content and behavior; shared visual treatment
  belongs in the component. Layout classes are fine; do not cancel its colors,
  typography, shadows, opacity or interactive states at the call site.
- Use authored palette ramps for ordinary color choices. Semantic names are
  earned by a light/dark step mismatch, a rule a ramp cannot express (such as
  three text emphasis levels), or an established UI pattern approved by Morgan.
  A repeated color alone is not proof of a repeated pattern.
- **No local light/dark color overrides.** When one UI job needs different steps
  in light and dark, reuse the semantic token for that job or create one with
  the pairing in `styles/tokens.css`. Both modes use the same name at the call
  site. If the shared ramp or role itself is wrong, propose fixing that owner
  instead of adding a token to conceal the defect.
- An approved pattern may use the **same palette step in both modes**. That is
  valid, not an exception to work around. Record its reason immediately before
  the light/default token declaration as `/* @earned pattern: <approved pattern
  and reason> */`. Use `@earned rule:` for an established system rule. For a
  mismatched pairing use `@earned modes:` and explain the relationship. Material
  treatments use `@earned material:`. The check verifies a recorded reason, not
  the truth of the design judgment or human approval.
- If a reason is missing, preserve any approved semantic decision and record it.
  Without evidence of approval for a pattern, ask Morgan; do not fabricate a
  reason, quietly replace the token with a palette step, or weaken the guard.
- Color literals live in the central palette/material definitions. Do not use
  stock Tailwind colors, local literals, or opacity/color mixing to manufacture
  a shade. Genuine translucency belongs in a named material; whole-element
  fading is different. Use glass as a complete treatment, not its private fill.
- Search by intent before adding. Build from a current need, not a speculative
  catalogue. Generic reusable UI belongs here; Buzz-specific behavior stays
  with its feature. Propose promotion when a second use establishes repetition.
  Use enumerable variants, never visual boolean props or parallel components.
- Keep Base UI behavior and Tabler icons. Inspect Base UI for the matching
  interactive primitive before writing one; use native elements when there is
  no matching primitive or the component is static.
- When the system cannot express the right design, propose improving the system.
  Do not distort the design or hide a local workaround. Exceptions require a
  deliberate, documented design decision; recurring exceptions suggest a missing
  role or a rule that needs changing.

## Visual and interaction contract

- Quiet everyday chrome; color signals meaning, not decoration. Never use status
  colors decoratively or as the only carrier of meaning.
- Documentation and dense reading sit on an opaque panel, not a page-wide gradient.
- Choose the surface job first: backdrop, panel, inset, floating or glass. Use
  `border-primary` for shared neutral boundaries; do not invent border weights.
  Group with spacing or a quiet fill rather than boxing every item. Cards have
  no default fill; dense data normally uses rows rather than cards.
- Text uses named type roles as a whole setting: no arbitrary sizes, leading or
  tracking. Use 400 for content and 600 for structure/emphasis; body emphasis may
  compose `font-semibold`. State is not weight. Sentence case, never tracked-out
  labels. Relative sizing preserves zoom and the host's text preference. Readable
  sans text has a 12px default floor; the authored mono roles are optically smaller.
- Keep default, hover, selected and applicable disabled states clear. Selected is
  persistent, not stronger hover; selected no-op toggles have no hover. No extra
  pressed styling. Never hide the only recovery action.
- Preserve assistive semantics, one owner per label, and equivalent keyboard,
  pointer and shortcut paths. Authored focus rings require both
  `html[data-keyboard-navigation]` and `:focus-visible`; no container focus rings.
- Design in light/dark and narrow/intermediate/wide together. Check actual
  text/surface pairings, not isolated swatches. Target APCA Lc 60 for body and 45
  for large/non-essential text; report WCAG contrast too where applicable.
  Disabled text is not for needed information. Automated opaque-pair checks do
  not certify glass, control boundaries or rendered accessibility.
- Motion explains change. No animated blur; direct manipulation follows the
  pointer without easing and must not select text during a drag.
- Copy is short and actionable. Labels say what happens; empty states explain
  purpose and next steps; errors explain what happened and how to recover.

## Ownership and change completion

- Components live in `ui/`, values in `styles/`, inventory in `tokens/` and
  `ui/registry.ts`. Update the relevant registry and live specimen in the same
  change as an addition. Preserve proposed/core status; documentation is not
  proof of product adoption. Facts derivable from code must be checked against it.
- The viewer imports the real components. Neither the system nor the standalone
  viewer imports features, plugins, native adapters or app startup. Product UI
  must not import viewer furniture.
- The host owns appearance and global-style integration, including portal roots.
  Do not layer a second reset or preference owner into the app. The theme helper
  here is viewer-only; layout experiments need a host adapter before adoption.
- Read the relevant `DESIGN.md` explanation before changing a design decision.
  Update this file when policy changes; update the explanation only when the
  rationale changes. Do not duplicate token values or component inventory there.
- Run the scoped commands in `README.md`: types, guards, unit tests and viewer
  build; exercise affected browser journeys in Chromium and WebKit for viewer or
  component behavior changes. Follow the root contribution workflow for iteration
  versus integration gates and report deferred checks.
- Existing legacy findings are recorded individually, not exempted by folder.
  Do not add new violations or refresh that baseline to make checks pass. Remove
  entries as their owning UI is migrated. CI is a backstop, not a design reviewer.
