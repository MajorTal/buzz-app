# Task-thread experiment

We are testing the [Rooms in Buzz model](https://github.com/block/buzz/pull/7615) in Buzz 1.0: a project has a channel, a task has a thread in that channel, and an implementing branch can share the task's conversation.

## Current experiment

A person asks an agent to work in a focused thread in a project channel. That thread becomes the task. The agent creates a branch and eventually a PR, keeping planning, implementation updates, and review in the same thread. The repository has a separate channel where branch and PR links point back to this conversation.

The conversations, branches, and PRs are real. Project and task metadata are currently local to the prototype client, not native Buzz objects. Repository-channel associations do not change GitHub permissions.

## Agent behavior

- When asked to start work in a focused project thread, use that thread as the task. State a short task title and intended outcome if they are not already clear. Do not wait for a separate request to create a task.
- Reuse existing task context and any suitable existing branch. Do not create a native Buzz task, another task channel, or a duplicate discussion.
- If the current conversation is broader than the requested work, propose a focused task thread in the appropriate project channel before starting. That transition is outside the first pilot.
- Work normally: reproduce the problem, make the smallest fix, and validate it. Report the repository and branch when created, then the PR URL when opened, in this thread.
- Keep progress, questions, review, and CI follow-up here. Keep PRs draft and do not merge without explicit approval.
- The prototype operator attaches local task metadata. Agents cannot assume they can read or update the person's browser storage; use the conversation as shared context and do not claim a local record was saved without confirmation.

## First task: muted-call sound fix

Use the existing task thread in Berd Voice to fix the unmute sound played when ending a muted call. Work in the Berd repository. Confirm the reported behavior on current main, add a regression test, and preserve normal behavior for the next call.

After the branch exists, the prototype operator manually posts its link and the task-thread link in Berd Repo using the Monitor identity. Add the PR link when available. Monitor is our workaround; the agent does not need to create this association. CI/review wakes can also return to the task thread through Monitor.

## Later experiments and open questions

- Automate repository-channel entries using execution context, discovery, or possibly a channel workflow. No mechanism is selected yet.
- Expand ordinary thread links inline and show permission-filtered backlinks chronologically. A reference does not necessarily mean that the source conversation originated the task.
- Create or link tasks from broader conversations, including selecting or creating a project.
- Define shared metadata and an API so correct task creation and linking do not depend on agents following prose instructions.
