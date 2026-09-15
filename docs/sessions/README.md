# Sessions

Sessions are focused work conversations built on ordinary private channels.

## Current contract

- A session is the work conversation. The Sessions sidebar shows previous topics,
  with **New session** first and no search. Selecting one opens the conversation.
- Sessions are ordinary private stream channels. Creation, invitations, messages,
  roles, and membership use existing relay behavior. **No relay changes or new
  Sessions protocol are required or planned for this iteration.**
- The description marker `Buzz session (buzz.sessions/v1)` identifies sessions.
  An optional newline followed by `parent:<UUID>` nests a session under a channel
  in the app. Signed channel metadata restores this relationship; it grants no
  access and never substitutes for the session's own signed membership roster.
- Each channel has independent membership. Removing someone from a parent does
  not remove them from its sessions; parent additions and roles do not propagate.
  This is the accepted product behavior, not a pending inheritance rollout.
- Adding a library agent in a child session invites it to both parent and session
  through normal channel invitations. Sending waits for both real rosters. Failed
  invitations preserve the draft and retry the saved operation.
- New sessions can be created without a parent or beneath a Messages channel.
  A channel's hover menu starts a child; its hover chevron collapses the children.
  Changing a saved session's parent remains future app metadata work.
- Both entry points share the ordinary composer, centered at the bottom, and
  channel-style titles. The avatar-and-name picker sits before @ and opens upward.
  Explicit mentions take precedence over the selected agent. Without a selection,
  a sole agent is addressed automatically; multiple agents require a recipient.
- Published replies appear in the main session conversation. Sessions uses normal
  paged channel queries and complete message overlays, without new relay filters.
  Existing thread replies are also presented inline.
- Detailed activity remains private to the agent's owner. Do not build a shared
  activity feed for today's individually owned agents. Shared cloud agents may
  introduce a different visibility model later.
- Use real conversations and agents. No sample activity, fake sends, inferred
  permissions, or new execution/scheduling infrastructure.

## Ownership and protocol

- `src/bundled/sessions` owns the Sessions page and history navigation.
- `src/bundled/channels` owns parent-channel entry points and nested sidebar rows.
- `src/features/sessions` shares composition, recipient selection, and presentation.
- `src/features/relay/work-sessions.ts` uses the existing durable outbox for private
  stream creation (kind 9007), invitations (kind 9000), and receipt recovery.
- `dev/session-commands.mjs` restricts the host signing boundary to these exact
  command shapes. No custom relay operation or migration is needed.
- `session-window.ts` loads ordinary channel rows and complete message overlays
  with bounded paging. Signed membership remains the authority for reads.

## Validation and scope

Focused tests cover signed create/invite/send, duplicate-creation recovery,
independent memberships, rejected invitations and retry, parent revocation without
child revocation, flat conversation reads, Enter submission, recipient precedence,
and agent mention rendering. Real-agent creation and replies have been exercised
in the native app.

Moving and renaming sessions, archive/completion, sharing snapshots, and richer
prompt-linked activity remain future product work. This implementation keeps
memberships independent and detailed activity private to each agent's owner.
