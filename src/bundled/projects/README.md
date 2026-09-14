# Local projects

In Projects, choose an existing channel and mark it as a project locally. The page uses the shared relay channel list for current names and lists the local task records saved for threads in that channel. Project and task buttons use the host's conversation navigation.

Project markers are stored separately per account/community and channel. Task details and markers are local to the current browser or app, not shared with agents or synced to another device. No relay writes or duplicate channels are created. A missing channel is not evidence that its local marker should be deleted.

Checks: `bin/pnpm exec vitest run src/bundled/projects/data.test.ts` and `bin/pnpm test:browser tests/browser/task-details.spec.mjs --project chromium --project webkit --no-deps`.
