# Design rationale

`AGENTS.md` is the canonical authoring policy. This document explains the decisions
behind it; it is not a second rulebook or a copied token/component inventory.
Current values, roles, components and specimens live in the registries and viewer.
`README.md` explains how to run them. Historical examples below explain decisions,
not a claim that every referenced feature was ported to this client.

## Stewardship

The system is shared memory of deliberate decisions, not a gate a designer must
pass through. Its purpose is to make common choices easy while leaving room for
specific, surprising or new design. Product work supplies the evidence: a repeated
need can reveal a useful abstraction, and a one-off can reveal a faulty ramp or a
missing component state. A passing check establishes only the properties it tests,
not that an interface is good.

For example, a prototype's lighter search field exposed a neutral step that was
too heavy. Correcting the shared ramp improved every quiet compact surface using
that step; a search-only color or fractional stop would have hidden the finding.
A real component variant similarly keeps shared behavior intact instead of
creating another component whose interaction will drift.

Exceptions are design decisions worth explaining. Several exceptions pointing in
one direction are evidence that the system's rule may need changing. The guard
cannot approve a pattern, infer product intent or judge a live preview. It can
require the reason to be recorded and direct an agent back to the human when that
reason is unknown. Mandatory completion steps live in AGENTS.md.

## Posture

Buzz is a place where people build together and bring agents into the room.
Everyday surfaces stay quiet, crisp and functional. Character belongs in identity,
guidance, transitions and ceremony rather than ordinary chrome. Color as signal
keeps conversations and work more prominent than their containers.

## Color: why the ramps are public

Each palette step has separately authored light and dark values. A component using
`bg-purple-3` already changes with the mode; this differs from stock Tailwind,
where one numbered color is a single literal. The system's palette reconciles
light and dark once, rather than making every screen do it again.

| Layer | Example | Purpose |
|---|---|---|
| Palette | `--purple-9`, `--neutral-4` | Authored mode-aware steps; the source of color values |
| Semantic roles | `--bg-panel`, `--text-primary` | Named relationships, system rules or approved UI patterns |
| Components | Button, Panel, Tabs | Shared visual treatment and interaction |

The old families layer added thirty names with one reader each. Answering a color
question meant following three references across two files. Removing it, and later
unused semantic roles, shortened the path from rendered color to its decision.
This history argues against speculative naming—not against an approved pattern
that intentionally gives a reused relationship one stable name.

## Why a semantic name can be useful

**Different steps by mode.** A panel needs a different relationship to its
surroundings in light and dark. One mode-aware step cannot express that additional
relationship. A semantic role contains the pairing; the component uses the same
name in both modes. The same reasoning applies when a new treatment needs, for
example, neutral 1 in light and neutral 2 in dark. A component-local dark override
would distribute ownership of that decision across its callers.

**A system rule.** The text emphasis names keep three levels recognizable. Even
where `text-primary` uses the same step in both modes, the name represents a
reading hierarchy rather than an incidental color. The single border role serves
a similar purpose.

**An approved repeated pattern.** A tinted callout repeated across screens can
benefit from one semantic name even if its light and dark definitions reference
the same step. The pattern, not the coincidence of a color, supplies the meaning.
Counting consumers can provide evidence; no count establishes human approval.

The `@earned` annotation beside a token records that decision. A check can verify
its presence, category and relationship to the declarations. It cannot verify
that a sentence is true or that the human approved it. Approval remains a review
question, never something an agent can manufacture to satisfy CI.

## Choosing a palette step

This is a general map, not an inventory or a guarantee of contrast:

| step | job | example |
|---|---|---|
| 3 | a tinted surface | `bg-purple-3` |
| 4 | that tint, hovered | `bg-purple-4` |
| 8 | colored border or focus ring | `border-purple-8` |
| 9 | solid fill | `bg-purple-9` |
| 10 | that fill, hovered | `bg-purple-10` |
| 12 | coloured text on a neutral surface | `text-purple-12` |

The map proved useful across hues but did not make every pairing readable. Red-11
looked more obviously red, yet measured below the body APCA target on a dark panel
and floating composer. Red-12 cleared those contexts. Green and blue hover fills
also needed inspection because a lighter dark-mode hover can reduce white-text
contrast. A numerical step is a starting point, not the result of measurement.

Palette values began with Radix Colors (MIT), copied as values rather than a
package dependency. The neutral ramp is authored against the product's real panel
stack. Current deviations and measurements belong beside the values they explain.

## Surface and depth

Soft fills distinguish regions without drawing attention to their edges. Dense
rows often separate themselves through content or spacing; cards make more sense
for widgets, galleries and settings groups. A fill that means inset should not
quietly become the generic treatment for every grouping.

Light-mode elevation is legible through a subtle shadow. On a dark background,
a lighter floating surface conveys depth more effectively than a stronger shadow.
Glass adds another distinction: less translucency reads as a higher layer, whereas
a brighter translucent child can look like the same material.

A border measurement made the ownership problem concrete. Neutral-4 in dark mode
measured about 1.08:1 on a panel and 1.09:1 on the floating composer. Neutral-5
matched the floating surface itself. Moving the dark side of `border-primary` to
neutral-6 improved the shared boundary instead of fixing one documentation frame
with a private color. Text and borders have different jobs despite sharing the
word “primary.”

Tabs exposed a different mismatch: chrome glass over a white panel disappeared
into its selected pill. The useful distinction was a component variant—chrome
versus panel—not another tint or another Tabs implementation. Both variants share
keyboard behavior, accessibility and Base UI parts.

Glass has real costs. Repeating a translucent fill on a child that covers its
parent compounds opacity; two identical layers are not one layer. A directional
rim communicates material, not a solid boundary. Glass over a flat fill offers
little benefit for its compositing cost.

One contrast question remains deliberately unresolved: sampled dark glass over
bright regions of Night garden put secondary and tertiary text slightly below
target. The opaque-pair guard cannot see that composition. Dimmer bright stops,
more opaque glass or avoiding metadata on glass are different design choices;
real product content is needed to choose among them.

## Typography and state

Type roles combine size, line height, tracking and weight so identical labels
stay identical. Two weights distinguish content from structure/emphasis. Adding
weight just for selection or unread state would give that same distinction a
second meaning. Bold within prose is different: the paragraph owns size and the
phrase owns emphasis, so body type plus semibold composes naturally.

The short type scale reflects a dense conversational app rather than a document
outline. In the original screen census, one size covered most text and two sizes
covered almost all of it. More intermediate steps invited distinctions the product
did not need. Mono roles are optically smaller than their sans partners because
equal numeric sizes make mono pull attention from surrounding prose.

Relative sizing preserves the person's text preference and zoom. Fixed sizes and
arbitrary relative literals solve different halves of the problem: one freezes
scaling; the other still fragments the shared scale.

Persistent selection needs to work without a cursor present. Disabled describes
unavailability, not another level of quiet emphasis. Hover is a relative change
in contrast whose direction depends on the surface. These distinctions explain
why a palette alone cannot encode interaction semantics.

## Contrast and registration

APCA is the design target because it considers polarity and better reflects some
saturated-fill pairings than the WCAG 2 ratio. WCAG remains important to reporting
and compliance; APCA measurements alone are not a conformance claim. Disabled
text and decorative hairlines have different purposes from necessary information
and control-identifying boundaries.

The guard measures configured opaque text/surface pairs from the token source.
It does not discover every rendered pairing, certify glass, or replace inspection
in both modes. If a fill supports neither light nor dark readable text, choosing
the less-bad text is not a solution to the fill.

Registration once hid two real defects. Registering text and border “primary” in
Tailwind's shared color namespace made borders resolve to the text color. Later,
a role's intended text value passed contrast while its generated utility resolved
to a different fill value. Dedicated text and border namespaces and source-bound
registry tests make those claims checkable. Measuring a correct value that no
browser consumer receives gives false confidence.

## Components, ownership and documentation

A shared component is a promise that an interaction and its visual language mean
the same thing wherever they appear. Base UI supplies interaction primitives;
Buzz supplies visual decisions and product semantics. Reusing a component's
variant preserves both owners. Overriding its states at a feature call site makes
the shared promise harder to maintain.

The host owns appearance lifecycle, including preference recovery and portals.
The standalone viewer is an independent document. Importing its preference helper
into product UI would create a second owner, even if both initially display the
same mode. The host integration contract is documented separately in
`docs/design-system.md` because it describes product behavior, not design policy.

The viewer renders real components and imports the canonical guidance directly.
Its registries hold descriptions and proposed/core status; tests bind checkable
facts to source and require specimens for registered components. A generated
second inventory is unnecessary when those existing owners can be checked.
Human-authored specimens still explain meaningful interaction states—an inventory
scanner cannot choose the best demonstration.
