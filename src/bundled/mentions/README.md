# Mention rules

`version 1` · `client contract` · `uses existing tags`

## Abstract

This contract says who a user can mention in a channel message, how a client
orders the choices, when Space completes a mention, and what a client sends when
the user mentions someone outside the channel. Clients that follow it give the
same search the same list and send the same tags.

The `buzz.mentions` plugin implements the chooser. The relay message writer and
message fold implement the tags. This directory owns the spec and the
[portable fixtures](mention-rules.fixtures.json).

This is an extraction of the behavior in
[buzz-app #257](https://github.com/block/buzz-app/pull/257) and
[buzz-app #258](https://github.com/block/buzz-app/pull/258), with the archive
rule from [#256](https://github.com/block/buzz-app/pull/256) and the prose rule
from [#303](https://github.com/block/buzz-app/pull/303). It adds no event
kind. It uses `p` tags and the two-field `mention` tag that other Buzz clients
already write. Labels come from the
[contextual identity names](../identity-naming/README.md) contract.

MUST, MUST NOT, SHOULD, and MAY have their RFC 2119 meanings.

## Terms

- **Key**: a Nostr public key, as 64 lowercase hex characters.
- **Choice**: one key the user can mention. It has a **name** (the identity's own
  name), a **label** (the name shown in the chooser, possibly qualified, for
  example `Wes’s Honey` or `Honey · 4prr`), and **aliases** (the real names known
  for that key). A choice with no known name has no aliases. Its label is only a
  key fallback.
- **Member**: a key in the channel's current member list.
- **Outside**: a choice that is not a member.
- **Recipient**: a key that the message addresses and notifies.
- **Reference**: a key that the message names without notifying.

## Scope and authority

Choosing a person does not give them access. A mention does not promise that an
agent will accept or answer. The existing channel membership, add-member
permission, and session invitation rules stay the authority. Labels are
presentation only. Clients MUST send and store exact keys, not labels.

This contract does not define profile validation, archive state, presence, or
agent ownership proof. Ownership here is a display hint from profile metadata,
not authorization.

## 1. Choice set

For a stream or forum channel that is not archived and not read-only, the choice
set is:

1. the channel's members;
2. the agents that the client offers for mention in this channel; and
3. people and agents found by a community directory search for the current query.

DMs and sessions MUST NOT add directory people. A session that invites agents
uses its own agent list instead of item 3. Archived or read-only channels have
no choices. Clients MUST exclude invalid keys and identities known to be
archived, except the viewer's own key: a user always sees themself. Unknown
archive state does not exclude a key.

Labels MUST be resolved against the whole choice set, not only the rows that
match the search. Directory people with no cached profile still take part, so
namesakes get qualified labels.

## 2. Query syntax

Inline completion opens on `@` at the start of the text or after whitespace,
`(`, `[`, or `{`. The query is the text from after `@` up to the caret. It MUST
NOT contain `@`, a line break, or a tab. It MAY contain spaces. A client MAY look
back only 160 characters from the caret. A caret outside the text gives no query.

A query with a space is **admitted** only while it is still the start of a
known name (case-insensitive). A query that is a complete known name plus a
trailing space is not admitted, so the user can keep typing prose. The known
names are the aliases and labels of the current choice set, including people
that the directory search for this query found. This check is the `admission`
fixture section.

Admission does not decide whether the client searches. A multi-word query can
name someone the client does not know yet, for example `@Mary J` for a Mary
Jane outside the channel. The client MUST still run the directory search for
it (subject to section 6), and it checks admission again with the names that
search finds. The client MUST close the inline chooser for a query that is not
admitted only when no directory search for it is pending and the last search
did not fail. While the search runs, the chooser shows no rows for that query.
If the search fails, the chooser keeps its error and a way to retry. The
desktop UI test "a failed multi-word directory search keeps its error and
retry" in [session-agents.test.tsx](session-agents.test.tsx) covers this case:
`@Mary J` fails, then Retry finds Mary Jane. The one case where the client MAY
skip the search is the refuted prefix in section 6. An `@` inside a mention
that the user already selected does not open a query.

## 3. Matching (normative)

Normalize the query and each name by trimming at both ends and lowercasing
(ECMAScript `trim` and `toLowerCase`). An empty query matches every choice at
tier 0. Otherwise, a name matches the query at the first tier that applies:

| Tier | Rule |
| --- | --- |
| 0 | The name equals the query |
| 1 | The name starts with the query |
| 2 | A word of the name equals the query |
| 3 | A word of the name starts with the query |

Words are split on runs of Unicode whitespace. Nothing else matches. Text inside
a word does not match: `oney` does not find `Honey`.

A choice's **match** is the tier of its label. If the label does not match, the
match is 4 plus the best tier among its aliases. A choice with no aliases never
matches a non-empty query. Public keys, npubs, and key fallback labels MUST NOT
be searchable.

## 4. Order (normative)

Remove choices that do not match. Sort the rest by the first rule that differs:

1. Members before outside choices.
2. Lower match.
3. Lower best alias tier (the **base match**). This lets `Fizz` rank above
   `Fast Fizz` when both labels match at the same tier.
4. Agents that the viewer owns before all other choices, people included.
5. Block label, by UTF-16 code unit order of normalized labels. Agents with the
   same values for rules 1 to 4 and the same normalized name form one **block**.
   A block's label is the lowest normalized label among its agents. A person, or
   an agent with a name of its own, is a block by itself.
6. On an equal block label: a person before an agent block. Two agent blocks
   are ordered by normalized name, and two people by key.
7. Inside a block:
   1. more recent explicit choice in this channel first;
   2. managed agents first;
   3. presence: online, then away, then unknown.
8. Normalized label, by UTF-16 code unit order.
9. Key.

Every rule is a key of one choice, so the order is the same for any input order.
A person or another name never sorts between two agents of one block. Ownership
and recency never override membership or match. Recency is the
client's memory of explicit selections in this channel. The desktop keeps it in
memory for 100 channels and 100 keys each.

## 5. Space selects only an exact, unique name

When the user types Space after a query, the client selects a choice only if all
of these are true:

- the normalized query is not empty;
- exactly one choice with aliases has an alias or label equal to the query;
- no choice has an alias or label that starts with the query plus a space; and
- that choice is shown and can still be chosen.

Check this against the full choice set, not only the shown rows. Otherwise Space
is a normal space. Tab, Enter, and a click select the highlighted row.

## 6. List stability (desktop behavior; not in the fixtures)

These rules keep a row from moving under the user's pointer or keyboard.

- Members and offered agents SHOULD show without waiting for the directory.
- A shown row MUST NOT move while the query and the open chooser stay the same.
  New rows are added only at the bottom. Directory people come after the rows
  already shown.
- A row that becomes unavailable stays in place and is disabled. Enter and Tab
  MUST NOT select it or fall through to Send.
- A client MAY show at most 50 rows and ask the user to type more.
- A client SHOULD wait for a short typing pause (desktop: 200 ms) before a
  directory search. While a search runs, it SHOULD keep matching people from the
  last finished search. It MAY cache finished searches for the session. It MUST
  NOT cache failures or searches that find no one. A new opening of the chooser
  searches again for such a query.
- A search refutes its query when it finds no one, reports no more pages, and
  the query contains a letter or digit. After that, a client MAY skip the
  directory search for a longer query that starts with the refuted query, and
  treat it as finding no one. It MUST NOT skip the search for an exact 64-hex
  key, because that is an author lookup that name prefixes cannot refute. A
  retry, or any new search, clears the refutation.

## 7. Sending to people outside the channel

When a draft addresses an outside key in a stream or forum, the client MUST ask
before it sends. The prompt names the outside people. It offers these actions,
like block/buzz desktop:

| Action | Shown | Result |
| --- | --- | --- |
| Invite | With add-member permission | Add each outside key. Wait until the relay confirms membership. Then send with those keys as recipients. |
| Do nothing | With add-member permission | Send. Outside keys become references. Nobody is added or notified. |
| Send anyway | Without add-member permission | The same as Do nothing. |
| Close or Escape | Always | Do not send. Keep the draft. |

Adding a member from this prompt MUST NOT start an agent. The sent message is
what notifies it. If the draft or its attachments change while adding runs, the
client MUST stop and keep the draft. It SHOULD report partial additions. Member
recipients in the same message are notified as usual.

## 8. Tags (normative)

A kind 9 channel message (or its reply) carries:

- one `["p", key]` tag per recipient; and
- one `["mention", key]` tag per reference.

Each list MUST have unique, valid, lowercase keys, at most 32 per list. Every
recipient MUST be a member when the message is written. A writer MUST reject the
message instead of dropping or converting a bad key.

A reader:

- MUST treat each valid `p` key as an addressed mention;
- MUST treat each valid two-field `mention` key as a reference (it names the key
  for display, and MUST NOT notify or wake it);
- MUST NOT treat a three-field `mention` tag (for example
  `["mention", key, "agent-address"]`) as a reference. Other Buzz clients write
  that form next to a `p` tag as display metadata for an addressed agent;
- MUST ignore invalid keys and remove duplicates, keeping first-seen order; and
- MUST resolve names for both lists. A key in both lists is addressed.

## Conformance fixtures

[mention-rules.fixtures.json](mention-rules.fixtures.json) holds semantic inputs
and literal expected outputs. It has no signed events and no labels to compute:
each choice supplies its own label.

| Section | Tests |
| --- | --- |
| `ranking` | Sections 3 and 4. `expected` is the full ordered key list. |
| `space` | Section 5. `expected` is a key or `null`. |
| `query` | Section 2 syntax. `expected` is `{start, end, query}` or `null`. |
| `admission` | Section 2 multi-word rule. `expected` is a boolean. |
| `tags.write` | Section 8 writer. `expected` is the ordered `p` and `mention` tags, or an error class: `not_member`, `invalid`, or `too_many`. The sender is a member in addition to `members`. |
| `tags.read` | Section 8 reader. `expected` is `{mentions, references}`. |

Choice defaults: `label` is `name`, `aliases` is `[name]`, and `agent`, `owned`,
and `managed` are false. `history` maps a key to recency (higher is newer).
`presence` maps a key to `online` or `away`; a missing key is unknown.

Section 6 and the prompt in section 7 are interaction rules. Test them with
client UI tests. The desktop tests are in
[session-agents.test.tsx](session-agents.test.tsx) and
`tests/browser/mention-rules.spec.mjs`.

Run the fixtures against the desktop code from the repository root:

```sh
bin/pnpm exec vitest run src/bundled/mentions/mention-ranking.test.ts \
  src/bundled/mentions/mention-query.test.ts \
  src/features/relay/fold.test.ts src/features/relay/mentions.test.ts
```

## Desktop adapter (informative)

- Choice set: [mention-candidates.ts](../../features/messages/mention-candidates.ts)
  and [use-mention-choices.ts](use-mention-choices.ts). Directory pages come from
  [useMentionDirectory.ts](useMentionDirectory.ts).
- Matching, order, and Space: [mention-ranking.ts](mention-ranking.ts).
- Query syntax: [mention-query.ts](mention-query.ts).
- Outside-channel prompt: [useNonmemberMentions.tsx](../../features/messages/useNonmemberMentions.tsx).
- Tags: [messages.ts](../../features/relay/messages.ts) writes them, and
  [fold.ts](../../features/relay/fold.ts) reads them.

## Sources and precedents

- [Contextual identity names](../identity-naming/README.md): the structure and
  fixture style of this spec, and the source of labels.
- block/buzz, inspected at `20131488528e35e6c50f4ccdb0490a9135c28edf`:
  [message_tags.rs](https://github.com/block/buzz/blob/20131488528e35e6c50f4ccdb0490a9135c28edf/desktop/src-tauri/src/events/message_tags.rs)
  writes two-field `mention` reference tags and the three-field `agent-address`
  form. This contract uses the same shapes.
- block/buzz, inspected at `930b8bb800d8149ce29a881ba4c5d9f424580434`:
  [NonMemberMentionDialog.tsx](https://github.com/block/buzz/blob/930b8bb800d8149ce29a881ba4c5d9f424580434/desktop/src/features/messages/ui/NonMemberMentionDialog.tsx)
  is the source of the section 7 actions.

Keep one canonical spec and fixture set. Other clients can link here or vendor a
pinned version.
