# Buzz design system

Shared components, tokens, and styles for Buzz. Use them for new UI and when
migrating existing surfaces. The system originated in the `block/buzz`
`desktop-new` worktree; its layout playgrounds remain experimental.

Read [the design guide](DESIGN.md) for product decisions,
[Maintaining the design system](MAINTAINING_DESIGN_SYSTEM.md) for how to evolve
them, and [the agent guide](AGENTS.md) before editing with an agent.

## Where to work

- `src/shared/design-system/`: shared components, tokens, styles, chip presentation helpers, registries, and colocated tests.
- `tests/fixtures/design-system/`: the standalone viewer and its interactive examples, using the real shared components.
- `scripts/design-system/`: type, color, contrast, and token-consumer guards.

## Run the viewer

From the repository root:

```sh
bin/just design
```

Open [the local viewer](http://localhost:1442/tests/fixtures/design-system.html).
`bin/pnpm design:dev` starts the viewer directly after dependencies are installed.
The same fixture path works on the port printed by `just web`.

## Check and build

Use the root contribution workflow to choose checks for the current iteration.
The system provides these scoped commands:

```sh
bin/pnpm design:typecheck
bin/pnpm design:check
bin/pnpm design:census
bin/pnpm design:test
bin/pnpm design:test:browser
bin/pnpm design:build
```

The browser command builds the host and viewer, then tests Chromium and WebKit.
`design:build` writes `dist/design-system`; serve that directory and open
`tests/fixtures/design-system.html`. Hash routes support static-host reloads.
The core build rejects application imports and bundles shared artwork explicitly.
It copies no public directory, native configuration, or source maps. Publishing is
not configured.

## Viewer boundaries

The core viewer runs without app startup, sessions, agent setup, conversation
features, relay services, native adapters, or live identity data. It includes shared
Composer examples, generic inline references, and blank layout playgrounds.

**Patterns → Messages** embeds a separate local fixture with production
message renderers and sample data. It does not add product imports to the core
bundle or start live services. See [message
specimens](../../../docs/design-system.md#message-specimens).

## Host integration

The host owns appearance and loads the shared palette, type, materials, and
component styles through one coordinated entry point. Existing callers may still
use compatibility styles until they migrate. Shared primitives mark their styling
boundary, including portal roots. Product compositions use those primitives and
semantic roles.

See [the host integration contract](../../../docs/design-system.md#incremental-system-integration)
for compatibility names, text scaling, focus, and app regression coverage.
The viewer owns its separate document and preferences. Workspace experiments stay
out of host startup; BentoWorkspace needs a host preference adapter before adoption.
