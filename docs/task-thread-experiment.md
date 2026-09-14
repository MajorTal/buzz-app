# Task-thread experiment

Testing the [Rooms model](https://github.com/block/buzz/pull/7615) in Buzz 1.0: project = channel, task = thread. Branches can share the task's conversation.

This living manifest is the experiment's source of truth. The goal is automatic branch/PR visibility in the repository channel, linked to the task conversation, without agent bookkeeping.

## Current experiment

- Create task metadata with the [task script](https://github.com/block/buzz-app/blob/jtennant/thread-task-plugin/src/bundled/task-details/README.md), using the existing thread. Don't create a native Buzz task or another task channel.
- The client and script share a file on this Mac, scoped to John's account and community. GitHub permissions are unchanged.
- The client's Assign button saves the assignee and posts a tagged reply as John to start work. Script updates only save metadata. Monitor remains our workaround for posting repository links.

First pilot: the muted-call sound fix in Berd Voice, with repository links in Berd Repo.

On John's Mac (Node 24; authenticated `buzz` on PATH):

```sh
node /Users/jtennant/Development/buzz-onedotzero/scripts/task.mjs create --viewer 67252b09c31a995daa63aada26569fbc6a3d12f573113f001ce7432f870da820 --community https://buzz.block.builderlab.xyz --thread '<buzz-message-link>' --title '<task-title>'
```

Use `get`, `list`, `update`, or `delete` for subsequent changes; `update --assignee <agent-pubkey>` changes assignment without waking anyone.

## Flow 1: starts in a project channel

1. Start a focused project thread; Sol creates its task record with the script.
2. John chooses another agent in the client and clicks Assign.
3. The client posts a tagged reply as John in the task thread, asking the assignee to start work.
4. The assignee creates a branch. Monitor creates a branch thread in the repository channel, linking back to the task.
5. Implementation proceeds. CI/automatic-review placement is undecided: task thread or repository thread.

## Flow 2: starts elsewhere (later experiment)

1. An idea emerges in a thread outside the project channel.
2. Choose an existing project or create one, then create a task thread in its channel with the relevant context.
3. Post the task link in the original thread and continue work in the task thread.
4. Branch and PR links appear in the repository channel as in Flow 1.

Eventually, the original thread's task link expands inline. The task thread shows a backlink at the time the link was posted.

## Flow 3: related discussion, existing task (later experiment)

1. Another thread raises something relevant to an existing task, possibly already underway.
2. Post a link to that task in the related thread, with a brief explanation of the connection. No new task or conversation move is needed.
3. The link expands into the task thread; a chronological backlink in the task thread exposes the related discussion. Both remain in their original locations.

## Later

- Automatic linking through harness context (possibly environment variables), a crawler, or both. A channel workflow is another possible approach; none is selected. Monitor is today's workaround.
- Expand task/branch links inline, with backlinks at the time of the source reference. Each message retains its canonical home and permissions; a reference does not imply origin.
- Shared metadata and an API to enforce the conventions.
