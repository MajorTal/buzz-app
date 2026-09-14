# Task-thread experiment

Testing the [Rooms model](https://github.com/block/buzz/pull/7615) in Buzz 1.0: project = channel, task = thread. Branches can share the task's conversation.

## Current experiment

- When asked to start work in a focused project thread, treat it as the task. Keep all discussion there; don't create a native Buzz task or another channel.
- Post branch and PR links in that thread. We manually mirror them into the repository channel using Monitor, linking back to the task.
- Project/task metadata is local to the prototype client and maintained by the operator. Agents use the conversation, not browser storage. GitHub permissions are unchanged.

First pilot: the muted-call sound fix in Berd Voice, with repository links in Berd Repo.

## Later

- Automatic linking; a channel workflow is one possible approach. Monitor is today's workaround.
- Expandable thread links and chronological, permission-filtered backlinks.
- Tasks originating in broader conversations.
- Shared metadata and an API to enforce the conventions.
