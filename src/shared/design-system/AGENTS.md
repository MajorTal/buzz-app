# Design system handoff

This is the app's design system. New UI and surfaces moving off the existing styles should use it.
This initial port does not migrate existing surfaces; that is a boundary of the PR, not a prohibition on adoption.
Read DESIGN.md and MAINTAINING_DESIGN_SYSTEM.md before editing.
Use semantic color roles and complete type roles; keep Base UI behavior and Tabler icons.
Block UI is the visual target. Palette steps belong in shared token definitions, not new component recipes.
Preserve keyboard-only focus and test light/dark and narrow/intermediate/wide views.
Components live in ui/, values in styles/, documentation metadata in tokens/ and ui/registry.ts.
The standalone viewer lives in tests/fixtures/design-system and imports the real shared components.
Do not import features, plugins, native adapters, or app startup into this system or viewer.
When wiring it into the app, use the shared components and tokens rather than the viewer's documentation furniture.
Integrate global styles deliberately through the host entry point instead of layering two resets, and keep the host appearance owner.
The theme helper is viewer-only; app surfaces read appearance through the host.
Run the root design:typecheck, design:check, design:test, and design:build scripts.
