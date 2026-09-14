# Task-thread experiment

Testing the [Rooms model](https://github.com/block/buzz/pull/7615) in Buzz 1.0: project = channel, task = thread. Branches can share the task's conversation.

This living manifest is the experiment's source of truth. The goal is automatic branch/PR visibility in the repository channel, linked to the task conversation, without agent bookkeeping.

## Current experiment

- When asked to start work in a focused project thread, treat it as the task. Keep all discussion there; don't create a native Buzz task or another channel.
- Post branch and PR links in that thread. We manually mirror them into the repository channel using Monitor, linking back to the task.
- CI/review notifications return to the task thread through Monitor.
- Project/task metadata is local to the prototype client and maintained by the operator. Agents use the conversation, not browser storage. GitHub permissions are unchanged.

First pilot: the muted-call sound fix in Berd Voice, with repository links in Berd Repo.

## Flow 1: starts in a project channel

1. Start a focused thread and ask the agent to work.
2. Mark that same thread as a task; continue the discussion there.
3. When the agent creates a branch or PR, Monitor posts its link in the repository channel, pointing back to the task thread.

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
