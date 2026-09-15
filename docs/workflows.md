# Workflows plugin

The bundled page owns the editor and drafts. The existing relay session owns
configuration reads and commands through its reader and durable outbox; the dev
broker owns authentication and the fixed run-history route. The relay executes
workflows. No separate connection, cache, outbox, scheduler or backend changes.
See the [capability contract](../src/features/workflows/types.ts).

## Scope

- Channel-scoped saved configurations; new drafts start disabled.
- Form editing for message/reaction triggers and Send Message/Delay actions.
  Other definitions stay in YAML; opening them does not rewrite their contents.
- Save with the original owner/channel/UUID and signed `expected-revision`.
  Warn on broad message or schedule activation, not ordinary enabled edits.
- Confirmed deletion request, manual run, and on-demand run/trace history in
  20-row pages with the relay's exact `(before,beforeId)` cursor.
- No approval UI, webhook-secret handling, lifecycle negotiation, alternative
  signed-host adapter or plugin command-replay API. Webhook-trigger saves are
  blocked at both the editor and signing boundary, including raw YAML.

## Recovery and limits

The outbox journals intent/signature before publication. A verified echo does
not replace the result-bearing receipt. Restored commands never run automatically;
result text stays ephemeral, outside the journal. Workflow intents cannot be replayed
through generic Outbox Retry either; inspection and dismissal remain available.

**Check saved configuration** resolves an unknown save only when a fresh verified
head matches its owner, channel, UUID and exact signed revision. Missing/different
heads retain the draft for review. Dismissal clears the notice and editor lock
only after durable dismissal; it neither undoes nor repeats a command. Unknown
runs stay unknown: only a returned run ID identifies a requested run.

Saving a configured enabled flag does not prove runtime activation or cancellation.
Legacy deletion can retain a visible definition; accepted delivery is not proof
of runtime cleanup. These backend limitations are displayed, not repaired here.

Reads begin on UI interest and stop on unmount or access loss; no background poll.
Transient socket recovery cancels stale reads but retains the draft and active
HTTP receipt correlation; refresh checks current data. Actual access loss purges
private snapshots before callbacks. Drafts are editor-local,
not durable, and never move between viewers or communities. The broker preserves
same-origin checks, signature validation, captured principal quotas, cancellation,
fixed upstream paths and bounded history/receipt bodies.

## Validation boundary

Offline regressions cover the editor, exact-save recovery, uncertain commands,
session isolation, broker authorization and history. This is not live acceptance:
create → edit → run → inspect against an unchanged backend and packaged-native
acceptance remain unverified. Live credentials, native launch and real workflow
writes require separate consent; no backend work belongs to this plugin PR.
