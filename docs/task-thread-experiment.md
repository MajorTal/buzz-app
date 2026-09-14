# Task-thread experiment

Testing the [Rooms model](https://github.com/block/buzz/pull/7615) in Buzz 1.0: project = channel, task = thread. Branches can share the task's conversation.

This living manifest is the experiment's source of truth. The goal is automatic branch/PR visibility in the repository channel, linked to the task conversation, without agent bookkeeping.

## Current experiment

- When asked to start work in a focused project thread, treat it as the task. Keep all discussion there; don't create a native Buzz task or another channel.
- Post branch and PR links in that thread. We manually mirror them into the repository channel using Monitor, linking back to the task.
- CI/review notifications return to the task thread through Monitor.
- Project/task metadata is local to the prototype client and maintained by the operator. Agents use the conversation, not browser storage. GitHub permissions are unchanged.

First pilot: the muted-call sound fix in Berd Voice, with repository links in Berd Repo.

## Later

- Automatic linking through harness context (possibly environment variables), a crawler, or both. A channel workflow is another possible approach; none is selected. Monitor is today's workaround.
- Expand task/branch links inline, with backlinks at the time of the source reference. Each message retains its canonical home and permissions; a reference does not imply origin.
- Create or link a project task from a broader conversation, leaving an expandable reference there.
- Shared metadata and an API to enforce the conventions.

## Open questions

- Repository entries: messages, structured records, or both?
- How do we identify repository channels, discover work created outside Buzz, and correct mistaken links?

Update entries rather than duplicate them. Do not expose private conversations through links, backlinks, or previews; ambiguous crawler matches need confirmation.
