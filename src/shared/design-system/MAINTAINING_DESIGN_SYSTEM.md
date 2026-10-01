# Maintaining the design system

The system records shared decisions so you can build a clear, consistent interface.
Use it as a starting point. When a real design needs something it cannot express,
improve the system rather than forcing the design into an unsuitable pattern.

## Start with a real use

Build the screen or interaction in front of you. Reuse the existing colors, type,
surfaces, and components, then inspect them in context.

A new use can reveal a missing state, an unsuitable token, or guidance that no
longer fits the product. Explain the need where you make the change. Avoid adding
options for situations no current surface needs.

## Choose colors by purpose

Use semantic surface, text, border, and affordance roles. The palette supplies
light and dark values; components should not choose palette steps directly,
even when a role uses the same step in both modes.

Add only the states the control needs, such as hover, pressed, or disabled.
Check the paired text and update the registry and viewer in the same change.
Legacy names support existing callers during migration; use semantic names for
new work.

## Share what repeats

A shared component should provide the same appearance and interaction wherever
it is used. Build the first version with its feature. When a second real use
appears, decide which part belongs in the system:

- Share generic controls and visual building blocks.
- Keep Buzz-specific behavior with the product capability that owns it.
- Share a complete arrangement only when another surface needs that arrangement.

Prefer small components with clear responsibilities. Do not add a catalog of
unused variants or a collection of unrelated boolean options.

## Review states in context

Check default, hover, pressed, selected, disabled, and loading states where they
apply. Selection must remain clear after the pointer moves away. Preserve
keyboard operation and focus restoration alongside pointer behavior.

The shared global stylesheet currently hides focus outlines by explicit design
decision. This is a known exception to visible keyboard focus, not an accessibility
pass. Follow [Temporary focus appearance](DESIGN.md#temporary-focus-appearance)
and do not add local replacement rings.

Inspect narrow, intermediate, and wide layouts in both themes. A specimen alone
cannot prove that a component works in its product context.

## Use checks as evidence

Automated guards protect shared decisions such as contrast, type roles, and
paired theme values. Keep deliberate exceptions named and explained in the
owning guard. If exceptions reveal a repeated need, revisit the rule rather than
adding more local workarounds.

Passing checks establishes only what those checks measure. Combine them with
rendered inspection and the affected interaction before calling a change validated.

## Leave the decision easy to find

Update the token, component, or guidance that owns the decision. Show useful
states in the viewer, use the change in its real product context, and explain the
reason in plain language near the implementation.

Follow the root contribution workflow for iteration and validation. Keep proposed
work marked as proposed until it has the evidence needed for adoption.
