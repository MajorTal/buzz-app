# Local task details

Open a conversation thread, then choose **Task details** in the channel toolbar. The plugin uses the host's existing channel-panel drawer. Enter a title, optional description and assignee, and repository/branch entries; choose **Save locally**.

The prototype dev server and local agent script share `~/.buzz/task-thread-experiment.json` (override with `BUZZ_TASK_FILE`). Records are keyed by account/community, channel, and the verified thread root. Old browser records are copied on first use without overwriting file records; originals remain in browser storage. Closing or changing browsers does not remove file records. This is local development data, not relay state. Unsaved form edits are discarded when the panel closes or changes threads.

Choose an assignee using the searchable agent picker. **Assign** saves the task and queues a reply as you, tagging the agent to start work. Delivery uses Buzz's normal outbox; failures appear in the thread. **Save locally** only saves metadata. There is no PR lookup or Git operation. Projects refresh from disk every three seconds while open; use **Reload saved task** to refresh an open editor. Stale saves fail instead of replacing newer changes.

## Agent script

Run with the repository's Node 24 toolchain. `buzz` must be on PATH with access to the thread. Reads resolve a reply link to its canonical root; the script never posts messages or modifies the conversation.

```sh
node scripts/task.mjs create --viewer <owner-pubkey> --community https://buzz.block.builderlab.xyz --thread '<buzz-message-link>' --title 'Fix muted-call sound'
node scripts/task.mjs get --viewer <owner-pubkey> --community https://buzz.block.builderlab.xyz --thread '<buzz-message-link>'
node scripts/task.mjs update --viewer <owner-pubkey> --community https://buzz.block.builderlab.xyz --thread '<buzz-message-link>' --assignee <agent-pubkey>
node scripts/task.mjs list --viewer <owner-pubkey> --community https://buzz.block.builderlab.xyz
node scripts/task.mjs delete --viewer <owner-pubkey> --community https://buzz.block.builderlab.xyz --thread '<buzz-message-link>'
```

The viewer is the human account whose client displays the task, not the executing agent. `BUZZ_DEV_VIEWER` and `BUZZ_RELAY_URL` supply defaults. Updates change only supplied fields; `--assignee ''` clears assignment. `--description`, `--branches` (JSON array of `{id, repository, branch}`), and `--revision` are also supported. Create rejects duplicates; delete removes only metadata. JSON output includes the record revision for optional conditional updates.

Writes lock and atomically replace the file. A crashed writer can leave a `.lock` directory; after confirming no writer remains, remove that specific lock and retry. A malformed file is reported, not overwritten. The HTTP adapter is dev-only, same-origin, and pinned to `BUZZ_DEV_VIEWER`; local scripts are trusted local processes.

Focused checks:

```sh
bin/pnpm exec vitest run dev/task-store.test.mjs src/bundled/task-details/data.test.ts src/bundled/projects/data.test.ts src/app/pages.integration.test.mjs
bin/pnpm exec playwright test --config tests/browser/playwright.config.mjs task-details.spec.mjs --project chromium --project webkit --no-deps --workers=1
```

The browser journey uses signed fixture relay data with the production plugin, file service, thread reader, and editor. It verifies migration, script-side edits, save/reopen, canonical-root reuse, stale-save rejection, assignment, and deletion. Metadata saves stay local; explicit assignment posts a tagged thread reply.
