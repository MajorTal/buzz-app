# Buzz design system

The design system this app is moving to, imported from `block/buzz`'s `desktop-new`
worktree, including its in-progress layout playgrounds. It is the styling source
for new UI and for existing surfaces as they move onto the system. This initial
port adds the system and its viewer without migrating existing app surfaces.

## Ownership and locations

- `src/shared/design-system/`: shared components, tokens, styles, chip presentation helpers, registries and colocated tests.
- `tests/fixtures/design-system/`: standalone viewer, documentation pages and interactive specimens. It renders the real shared components, not copies.
- `scripts/design-system/`: type, color, contrast, authoring and token-consumer checks.

Read `AGENTS.md` for canonical authoring rules and `DESIGN.md` for explanations
and examples. The viewer renders these files directly. Proposed work retains its status; historical examples in the design
guide are rationale, not a claim that those features were ported.

## Run from the repository root

```sh
bin/pnpm install --frozen-lockfile
bin/pnpm design:dev
```

Open http://localhost:1442/tests/fixtures/design-system.html.
The same fixture URL works under the normal web dev server.

```sh
bin/pnpm design:typecheck
bin/pnpm design:check
bin/pnpm design:census
bin/pnpm design:test
bin/pnpm design:test:browser
```

The browser command builds the host and viewer, then tests Chromium and WebKit.
`bin/pnpm design:build` produces `dist/design-system`; serve that directory and
open `tests/fixtures/design-system.html`. Hash links survive static-host reloads.
The build rejects source outside the system/viewer and copies no public directory,
native configuration or source maps. No publishing configuration is included.

## What is intentionally absent

No session shell, navigation controller, agent setup/activity, composer,
conversation feature, relay client, native adapter, local lab or identity data.
Blank layout playgrounds and generic inline reference presentations are retained.

## Compatibility boundary

The host owns the appearance lifecycle and now loads the shared palette,
typography roles, materials and component styles through its coordinated entry.
Existing UI keeps temporary legacy styling until deliberately migrated. Shared
primitives mark their own styling boundary, including portal roots; new product
compositions use those primitives and named roles, never viewer furniture.

See [the host integration contract](../../../docs/design-system.md#incremental-system-integration)
for compatibility names, text scaling, keyboard focus and actual-app regression coverage.
The viewer stays an independent document and preference owner. Workspace experiments
remain excluded from host startup; BentoWorkspace still reads viewer preferences
and needs a host adapter before product adoption.

## What validation establishes

`design:check` runs the scoped type/color/contrast guards and the app-wide
authoring audit. The audit parses CSS and TSX using PostCSS and the parser shipped with pinned
Vite. It checks color-bearing declarations, static classes/conditional branches
and literal inline styles, including directly imported system components. It is
not a proof about computed styles, CSS classes restyling components indirectly,
re-exported components, arbitrary named CSS colors or dynamic class construction. Exact existing
findings are recorded in `scripts/design-system/authoring-baseline.json` so new
occurrences fail even in legacy files. Removed findings require removing their
baseline entries; there is no automatic baseline refresh command.

Token and component registry tests verify inventory against source; viewer tests
verify registered components have specimens. `design:test` also exercises the
guards with valid and invalid fixtures. Root `check` and Vitest run these in CI.
The census reports usage, not whether a pattern deserves promotion.

Earned-name reasons live beside default color-role declarations in `styles/tokens.css`,
not in a script allowlist. The guard reports missing or malformed reasons with
the next action; approval and design quality still require review.
