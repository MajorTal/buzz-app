# Local projects

In Projects, use **Add project** to choose an existing channel. Search filters projects and their saved task threads. Selecting a task opens its workspace: persistent task details above the original thread and reply composer. **View in channel** opens that same thread in its channel. Reload and Back retain the task address through the host’s versioned page route.

Project markers and task details are stored per account/community and channel in the [shared local task file](../task-details/README.md). Local agent scripts and browsers using this dev server see the same records; nothing is synced to the relay. Existing browser records are imported without overwriting the file. No relay writes or duplicate channels are created. A missing channel is not evidence that its local marker should be deleted.

Checks: `bin/pnpm exec vitest run src/bundled/projects/data.test.ts` and `bin/pnpm test:browser tests/browser/task-details.spec.mjs --project chromium --project webkit --no-deps`.
