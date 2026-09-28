# Workflows plugin

The bundled page owns the editor and drafts. The existing relay session owns
configuration reads and commands through its reader and durable outbox; the dev
broker owns authentication and the fixed run-history route. The relay executes
workflows. No separate connection, cache, outbox, scheduler or backend changes.
See the [capability contract](../src/features/workflows/types.ts).

## Scope

- Channel-scoped saved configurations; new drafts start disabled.
- Cards open a modal editor over the workflow list. Create begins with channel
  selection in that editor; the empty draft's primary action adds its first step.
  Form mode uses a selectable flow and contextual inspector, with insertion
  menus and removal. On narrow screens the inspector is a nested side dialog.
  Escape closes a menu, then inspector, then editor with a dirty-draft warning.
  Trigger and step-action choices use labelled field selectors. Pencil name
  editing commits on Enter/blur and reverts on Escape; invalid names remain
  explained outside edit mode. Settings and
  run history are disclosed separately; operation recovery stays visible.
- Form editing for message/reaction/diff/schedule/webhook triggers and Send
  Message/Delay/Call Webhook actions. Basic conditions cover text, author,
  reaction and message-ID comparisons; unrepresentable expressions stay Advanced.
  Basic literal whitespace is preserved; expressions that cannot rebuild
  losslessly stay Advanced. Incomplete Basic rows block saving and lossy view
  switches until corrected or explicitly removed, and participate in leave/unload
  warnings even when their YAML is unchanged. Step conditions and timeouts live
  under Run controls.
  Webhook URLs may contain relay-expanded templates; headers and request bodies
  are configuration visible to channel members, not a secret store. The relay
  owns destination safety and channel-owner/admin authorization.
  Schedules offer repeat presets, weekday and
  day-of-month pickers, a UTC run time and a five-field cron editor. Numeric
  weekdays follow the relay: Sunday=1 through Saturday=7; existing numeric
  cron fields are not renumbered. Six- and
  seven-field cron stays in YAML. Other definitions stay in YAML; opening them
  does not rewrite their contents.
- Save with the original owner/channel/UUID and signed `expected-revision`.
  Warn before enabling an unfiltered message trigger or a schedule that runs
  hourly or more often, not on ordinary enabled edits.
- Webhook triggers: the relay issues a secret once, when a workflow first
  gains the trigger. The save receipt hands it to a one-time dialog with the
  hook URL, masked value, reveal and copy; leaving before revealing or copying
  asks for confirmation. Delivery stays mounted across channel/landing navigation;
  pending secrets are shown sequentially, and session clear/access loss purges
  any displayed value. The secret is held in memory until that dialog takes
  it and never enters the outbox journal, operation errors or logs. The hook
  URL needs the relay HTTP base the host advertises; without it the dialog
  shows the relative `/hooks/{id}` route only.
- Destructive deletion confirmation, manual run, and on-demand run/trace history in
  20-row pages with the relay's exact `(before,beforeId)` cursor.
- No approval UI, lifecycle negotiation, alternative signed-host adapter,
  plugin command-replay API or JSON trigger inputs.

## Recovery and limits

The outbox journals intent/signature before publication. A verified echo does
not replace the result-bearing receipt. Restored commands never run automatically;
result text stays ephemeral, outside the journal. Workflow intents cannot be replayed
through generic Outbox Retry either; inspection and dismissal remain available.

**Check saved configuration** resolves an unknown save only when a fresh verified
head matches its owner, channel, UUID and exact signed revision. Missing/different
heads retain the draft for review. Dismissal clears the notice and editor lock
only after durable dismissal; it neither undoes nor repeats a command. Exact
readback does not retire a pending one-time-secret receipt, and a missing receipt
does not undo verified configuration success. Unknown
runs stay unknown: only a returned run ID identifies a requested run.

An empty successful deletion receipt is reconciled only by a fresh read started
after that receipt: the workflow's owner/channel/UUID must be absent from a
complete channel result. Grid deletion confirms on the grid without mounting an
editor. Confirming deletion in detail discards the local draft and returns to the
grid immediately, including on a synchronous submission error. The session/outbox
continues delivery; the landing remains mounted across channel/editor navigation
and owns readback and recovery. There is no deletion progress in the editor.

Pending cards remain visible with **Deleting…** and disabled actions. Confirmed
removal refreshes the landing without resubmitting deletion. Rejection restores
card actions. Submission errors, rejection, and unconfirmed outcomes use the
existing toast stack; uncertain results offer **Check saved configuration**, which
also resumes a paused read. Missing receipts, partial/failed reads, and retained
legacy definitions never establish removal. Explicit **Dismiss notice** confirms
that dismissal does not confirm, cancel, or repeat deletion; actions stay locked
until durable dismissal succeeds, and persistence errors remain recoverable.
Session clear/access loss purges copied data and recovery UI. Work already running
may continue. The compact **Refresh workflows** icon keeps the old app's label and
rereads definitions for the known channels; it does not rediscover project channels.

Saving a configured enabled flag does not prove runtime activation or cancellation.
Legacy deletion can retain a visible definition; accepted delivery is not proof
of runtime cleanup. These backend limitations are displayed, not repaired here.

The landing discovers workflows in serial batches of up to 128 participating
channel IDs, including authorized DMs. Each request uses one kind-30620 filter
whose `#h` contains the whole batch, reading all authors in 100-event pages.
Full pages continue with the relay's exact `until`/`before_id` cursor, preserving
same-timestamp definitions. Each batch finishes paging before the next starts
with a fresh cursor; retry and refresh also start at the head. Signed event IDs
are deduplicated before counting/folding, and non-advancing pages fail the read.
The existing reader/broker request and response byte budgets and per-request
deadlines apply to every page. 500 memberships need four initial requests plus
continuations for full pages. Single-channel detail reads remain capped at 100
events and mark saturated results partial. Completed landing batch reads are
retained in the session workflow capability: returning within ten seconds can
reuse the matching batch without another relay read, and older retained results
can warm the landing while a fresh read runs. Retaining a completed batch evicts
older retained batches that requested any of the same channels, including empty
results, so targeted save readback cannot leave an overlapping stale landing
batch reusable. Explicit Refresh, save readback, configuration commands,
receipts, disconnects, access loss, cache clear and session disposal bypass or
purge that reuse. Retention is memory-only and bounded; a finished scan is not
proof of an exhaustive runtime inventory.

Metadata renames/reordering do not restart discovery; new memberships add only
their missing reads. One stable status replaces
per-channel loading placeholders, and loaded cards remain visible during refresh.
Refresh deliberately rereads the current roster; save outcomes request readback
only for their affected channels. Verified editor readback also refreshes that
channel on the landing, including when the receipt arrived before the saved
head became visible. Read failures/interruption stop the queued scan
and expose one paused status and Retry without erasing already loaded configurations
or inventing errors for unread channels. Retry resumes only failed/interrupted and
unread channels; membership additions join that paused queue, not restart it.
The header Refresh still deliberately rereads the full roster. Global clear
purges copied results without automatic rereads; a changed membership set
re-establishes authorized interest. At most two capability views remain live,
including one invalidation observer when discovery is idle.

Reads begin on UI interest and stop on unmount or access loss; no background poll.
Transient socket recovery cancels stale reads but retains the draft. Live-session
commands use the shared socket's result-bearing OK receipt; disconnect after send
leaves the outcome unknown and never automatically replays the command. The dev broker requires a live owner and matched frontend/host versions; only
the pre-existing direct signed adapter retains HTTP publication. Refresh checks current data.
Actual access loss purges private snapshots before callbacks. Drafts are editor-local,
not durable, and never move between viewers or communities. The broker preserves
same-origin checks, signature validation, captured principal quotas, cancellation,
fixed upstream paths and bounded history/receipt bodies.

## Validation boundary

Offline regressions cover the editor, exact-save recovery, uncertain commands,
session isolation, broker authorization and history. The real-session browser
journeys cover navigating to the landing, exact readback both before and after
the receipt, masked secret delivery, and automatic landing-card refresh in
Chromium and WebKit. Component tests
cover sequential secrets, interruption, and purge after the dialog takes a value.
This is not live acceptance:
create → edit → run → inspect against an unchanged backend and packaged-native
acceptance remain unverified. Live credentials, native launch and real workflow
writes require separate consent; no backend work belongs to this plugin PR.
