# Contribution workflow

The repository pins just 1.58.0, Node.js 24.18.0, pnpm 11.8.0, Lefthook 2.1.12,
and Rust 1.97.1
(including Cargo, rustfmt, and Clippy) with [Hermit](https://cashapp.github.io/hermit/).
No global tool installation is required: `bin/hermit` bootstraps Hermit and tools
are downloaded on first use. Desktop development still requires the
[Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/).

From the repository root:

```sh
source bin/activate-hermit # bash/zsh; fish: source bin/activate-hermit.fish
just --list
```

Without activation, use `bin/just`, `bin/pnpm`, or `bin/cargo` from the root;
these proxies supply the pinned environment to child commands too. For example,
`bin/just web` needs no shell setup. With activation, commands also work from
subdirectories, relative to this project's justfile.

`bin/hermit` bootstraps from Hermit's public GitHub release. `bin/hermit.hcl`
selects the [public package catalog](https://github.com/cashapp/hermit-packages)
and does not override npm/pnpm registry or CA settings. Without local overrides,
dependencies use the [public npm registry](https://registry.npmjs.org/).
Existing user configuration such as `~/.npmrc` remains effective; keep any
organization-specific mirror, credentials and trusted CA paths there, not in Git.
No company package infrastructure, registry credentials or custom CA bundle is
required by this repository. Do not disable TLS verification or package integrity
checks. If your network intercepts TLS, configure its trusted CA locally rather
than committing machine-specific paths or disabling certificate verification.
No user-level npm configuration edit, Corepack bootstrap, or temporary
tool PATH is needed for a clean public-registry setup. Commit the `bin/` scripts
and package symlinks; `.hermit/` contains ignored local state.

All tool versions are unchanged by the public-tooling migration. The public
catalog does not yet include Node 24.18.0, so `bin/packages/node.hcl` pins its
[official downloads and checksums](https://nodejs.org/dist/v24.18.0/SHASUMS256.txt)
as a repository-local override. Remove that override when the public catalog
supports the same pin; do not silently downgrade it.

The pinned pnpm Hermit package supports Apple Silicon macOS but marks Intel macOS
(`darwin-amd64`) unsupported. Do not silently substitute a different pnpm version
on an unsupported platform; resolve that tooling gap first. Other platforms still
need their own validation.

- `just web`: install locked dependencies and start Vite.
- `just desktop`: install locked dependencies and start Tauri, which starts Vite.
- `just fullstack`: reserved, exits unsuccessfully with an explanation. It will
  eventually start local Docker services including the Buzz relay backend.
- `just iterate`: install locked dependencies, format Rust, apply Biome safe
  fixes, check TypeScript, and build the frontend. Remaining problems fail the command. No tests or
  native compilation run here.
- `just scan`: install locked dependencies, check formatting/lint/types, build
  the frontend, run Node/Vitest/plugin-manager tests, headless Chromium/WebKit
  journeys, Rust Clippy, and native Rust tests. It does not auto-fix source.
  This is broader validation, not a signed package or a cross-platform test.

Before the first `scan`, install the pinned browser engines with
`bin/pnpm test:browser:install`; missing engines fail rather than skip. Linux native
notification tests also require `dbus-daemon` (installed in CI). They start and stop
isolated test buses, never use the desktop session bus or display real banners. See
[browser regression coverage and measurement limits](browser-testing.md).

Installs run on every invocation to account for branch and lockfile changes.
pnpm reuses its shared package cache; no node_modules directory needs to be copied
into a new worktree. Native dependencies are fetched by Cargo as needed. Initial
downloads and native compilation can take time. Web and desktop dev use the same
port; run them separately or open the browser at the desktop dev server URL.
Both run the development broker with your identity when the public
`BUZZ_DEV_VIEWER` pin is configured in `.env.local`, and start without live
identity otherwise; see [the setup and Keychain requirements](../README.md#relay-channels).

## Interactive product iteration

While shaping the first version, default to **edit → human tries the running app
→ adjust**. A manual feedback handoff is not a review or shipping gate.

- Reuse the agreed development worktree and branch, with one owner of product
  edits. Keep one dev server running: `just web` for shared frontend work, or
  `just desktop` when native behavior matters. Vite handles supported frontend
  updates without a package rebuild. State when a reload/restart is needed;
  coordinate native launches with the human rather than restarting their app.
- Make small, coherent changes and hand them back as **ready to try**, naming
  what to exercise and which checks ran or remain deferred. Do not wait for E2E,
  native compilation, independent review, or a full build before each ordinary
  UI feedback round. Keep a short list of changed behaviors and deferred checks
  in task notes so the later validation pass has a bounded scope.
- Use editor/compiler feedback and cheap targeted checks where useful. Add
  focused regression tests with behavior, but do not make test-harness work a
  prerequisite for ordinary visual feedback. `just iterate` is an optional
  checkpoint, not a per-edit requirement: it installs, formats, type-checks and
  builds, rather than merely refreshing the app. Local checkpoint commits use
  the existing staged-file hook; no hook bypass is needed.
- When the human is happy with a coherent batch, finish its regression coverage,
  self-review, obtain independent review where risk warrants, and run one
  `just scan` before review/integration. Attribute validation to that snapshot;
  subsequent edits require appropriate revalidation. Fix failures and rerun the
  affected gate rather than repeating unchanged successful work just for a
  handoff. **Validated** means the required checks passed, not merely that the
  screen looked right.

### Performance is acceptance, not a follow-up

For changes that add startup/sidebar work, reads or channel switching, include a
short cold/warm check in the feedback round. Correctness-only passes do not
establish that opening stayed fast. Optional names, avatars and speculative work
must yield to opening/reading a conversation; keep relay admission and access
checks intact. A failed read must expose retry rather than leave a false spinner.

Use the focused [channel-opening contract](browser-testing.md#channel-opening-performance)
when changing that path; do not add the entire browser suite to each UI edit.
Record click-to-visible time separately for cold and warm states, and split cold
waiting into reader queue, broker admission, network and verification/render work.
Compare equivalent cache/connection states. After the human is satisfied, include
these regressions in the ordinary batch gate. Do not raise a budget just to make a
regression green; explain the changed work and obtain agreement.

Exceptions: check safety-critical changes (auth/signing, persistence/migrations,
protocol semantics, or destructive writes) before exercising those paths against
real data. State the risk and required check up front. Native, dependency and
build-configuration changes still warrant broad validation; `FOUNDATION` edits
still require explicit human guidance. Defer expensive validation during ordinary
product iteration, not safety or the final quality gate. Do not turn `iterate`
into an ever-growing full test suite.

## Git hooks

### Pre-commit checks

Install once **per worktree** after `pnpm install --frozen-lockfile`:

```sh
bin/pnpm hooks:install
```

The installer enables pre-commit and pre-push using Git's worktree-local
`core.hooksPath`, leaves sibling worktrees
alone, and refuses existing custom hooks rather than overwriting them. Repeat
installation is safe. Do not run `lefthook install`: the tracked Git hook calls a
custom `check-staged` group to avoid Lefthook's automatic partial-file stashing.

Pre-commit runs pinned Biome formatting and safe lint fixes on fully staged
JS/TS/JSON/CSS files, and rustfmt on individual staged Rust files. Remaining
warnings/errors block the commit; no unsafe lint fixes are applied. Deletions and
unsupported formats (including Markdown, HTML and YAML) are not formatted here.
The hook does **not** run types, tests, builds, Clippy, or a whole-tree formatter.
`just iterate` remains the fast whole-tree fix/build command; `just scan` remains
the full validation gate. Both reject remaining Biome warnings.

Before writing, the hook refuses partially staged supported files, non-regular
files, and differing/untracked formatter configuration in their ancestor paths.
Format and reselect partial hunks, or stage/restore configuration, then retry.
Only checked paths are restaged after all checks succeed; a failed check can leave
safe fixes visible for review but does not update the index. Unrelated changes and
existing stashes are left alone. Do not edit/stage concurrently with a commit.
This is a developer guardrail, not a security boundary or a substitute for the full
scan; changes to tool/config dependencies still require broad validation.

### Fast pre-push feedback

Pre-push runs the project TypeScript check (`tsc --noEmit`), then Vitest tests
related to the branch's changed JS/TS inputs, using the locally available merge
base with `origin/main`. Documentation-only
and native-only pushes skip this runner. Shared JS configuration/dependency
changes, source deletions, or a missing base run the full Vitest suite instead.
The selector explicitly includes theme tests for their directly read CSS/bootstrap
inputs, and the app composition test for source edits that its Vite loader hides
from the import graph.
It never fetches, installs dependencies, formats, builds Rust, or starts browsers.
Install dependencies when switching branches, not during a push.

This is advisory coverage of the current working tree, not a replacement for CI:
uncommitted edits can affect results, dynamic dependencies may not be selected,
and non-HEAD refs are explicitly left to CI. Type errors and test failures block
the push. TypeScript uses the root `tsconfig.json`; it does not typecheck plain
JavaScript browser tests or prove runtime service provisioning.
Do not edit files concurrently with hooks. First-use Hermit tool downloads can
add setup time; normal warm hooks use the pinned tools already installed.

## Pull-request CI

`.github/workflows/ci.yml` runs on every PR and push to `main`, without path filters
that could omit newly added tests. It splits the CI-selected `scan` coverage
across cached, parallel jobs rather than running the entire recipe several times.
[Three documented WebKit cases remain local-only](browser-testing.md#ci-coverage-and-local-only-webkit-checks);
the complete suite still runs with `pnpm test` / `just scan`:

- **JavaScript:** Biome, one TypeScript check, frontend build, all Vitest tests.
- **Rust and tool integration:** workspace formatting, Clippy, all Rust tests and
  doctests (including Tauri), and every Node integration test. The CLI integration
  tests build Rust and install scaffold dependencies; they are intentionally CI-only
  rather than part of pre-push.
- **Windows native notifications:** Clippy and all Tauri-package tests on Windows,
  using the repository Rust pin through rustup (Hermit is not available there).
  This compiles the Windows backend; it does not exercise OS banner interaction.
- **Browser measurements:** Chromium then WebKit, serially on an isolated runner.
- **Browser journeys:** four runners (Chromium and WebKit, two file-level shards
  per engine), each with two workers. They start alongside measurements on separate
  runners; `CI required` still requires both lanes. Each runner builds the native
  plugin-manager fixture in a separately logged setup step before starting
  Playwright. Its Rust cache is optional: a cache miss still builds the fixture,
  outside the browser subprocess timeout. No measurement is repeated on shards,
  and no retry hides a failure. Functional jobs also run when measurements fail:
  this spends more runner minutes for faster, independent feedback.
- **CI required:** fails unless every lane and every browser shard succeeds,
  including cancellation or an unexpectedly skipped lane. Configure this status
  as a required repository check; the workflow does not change branch protection.

Actions and tool versions are pinned, installs use the frozen lockfile, and
Hermit/pnpm/Cargo/browser caches avoid repeat downloads and cold compilation.
Superseded PR runs are cancelled. CI uses disposable Ubuntu/Windows runners and no live
Buzz identity or signing credentials. It is not native GUI acceptance, a signed
package, or a cross-platform release gate. `just scan` remains available locally;
CI does not add full scans to commit/push or ordinary interactive feedback rounds.

## Test organization

Keep component and service tests beside their owner, including integration tests
that belong to one subsystem. Use Vitest for these tests (`*.test.ts`,
`*.test.tsx`, or existing `*.test.mjs`); JavaScript tests do not need a TypeScript
rewrite just to move. `vitest.config.ts` discovers tests under `src/` and `dev/`.

- `src/app/pages.integration.test.mjs` exercises the actual bundled app composition;
  `src/plugins/runtime.test.mjs` covers plugin activation and disposal.
- `dev/relay-broker.test.mjs` lives beside the Node-only development broker. Other
  broker integration tests remain with the community/relay behavior they exercise.
- `tests/integration/` is for cross-system journeys. The plugin CLI test keeps
  Node's runner because it builds the Rust CLI, scaffolds a separate project, runs
  its build and installs the resulting module.
- `tests/browser/` contains the automated whole-app Chromium/WebKit journeys.
- Rust integration tests stay under their owning crate's `tests/` directory.

`pnpm test` runs all four layers: Node integration, Vitest, Rust plugin-manager,
then Playwright. Updating a test's location must also update discovery, imports,
fixture URLs and root-path calculations; moving a file must not silently drop it
from the gate.

### Manual browser fixtures

With `just web` running **without a `BUZZ_DEV_VIEWER` pin**, these separate diagnostic pages
use fixture identities/transports rather than the live broker:

| URL | Purpose |
| --- | --- |
| `/tests/fixtures/communities.html` | Local profile and join dialog; first profile publication deliberately rejected |
| `/tests/fixtures/relay-composer.html` (optional `?durable`) | Delayed signing/publication and one-time rejection for messages containing `reject` |
| `/tests/fixtures/relay-storage.html` | Real IndexedDB migration, signed restore, deletion and partition isolation |
| `/tests/fixtures/relay-startup.html` | Cold/warm send timings with 512 retained signed records |

These pages are manual diagnostics, **not automatically run by `pnpm test`**.
The scrolling gate does not replace their checks. Use a disposable browser profile
for their local storage; timings are diagnostics, not production guarantees.

## Foundation files

The standard source comment is `FOUNDATION: <responsibility and constraint>`.
Agent instructions for these files live in `AGENTS.md`: edits require explicit
human guidance, and foundation files have stricter code review standards.
