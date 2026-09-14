# Local task details

Open a conversation thread, then choose **Task details** in the channel toolbar. The plugin uses the host's existing channel-panel drawer. Enter a title, optional description and assignee, and repository/branch entries; choose **Save locally**.

Records live in this app profile's localStorage, keyed by account/community scope, channel, and the verified thread root. Opening different replies in the same thread reaches the same record. These details are not relay events, shared assignments, or agent notifications. Clearing local app storage removes them. Unsaved edits are discarded when the panel closes or changes threads.

This first slice has no PR lookup, Git operations, or task creation on the relay. Assignee is a local text field, not an identity picker. The built-in catalog entry requires a native rebuild to appear in an already-running desktop binary; browser development picks it up through the frontend.

Focused checks:

```sh
bin/pnpm exec vitest run src/bundled/task-details/data.test.ts src/app/pages.integration.test.mjs
bin/pnpm exec playwright test --config tests/browser/playwright.config.mjs task-details.spec.mjs --project chromium --project webkit --no-deps --workers=1
```

The browser journey uses signed fixture relay data with the production plugin, thread reader, and editor. It verifies save/reopen, canonical-root reuse, stale-save rejection, and no relay publication. Live-community use, native presentation, and the full scan remain separate checks.
