# Packaged identity — implementation contract

Work in progress, not release validation. Goal: Account setup, native key custody,
and existing session/read/outbox integration without `.env.local` or a development
broker. No pairing, generic renderer signer, framework fork or automatic generation.
Independent existing-key entry surface remains a product decision; this first
slice preserves explicit legacy copy and saved unlock without secret IPC.

## Identity IPC (native implementation / frontend handoff)

Standard Tauri commands. Successful responses are public-only snapshots:
`{ state: "signedOut" | "ready" | "unavailable", pubkey: string | null,
generation: string, revocation: string, busy: boolean, reason: ErrorCode | null }`.
`generation` is a decimal u64 revision (compare as BigInt, not Number).
`revocation` is an opaque UUID, scoped to this native process/revocation epoch.
It is a stale-intent fence, NOT a renderer permission or secret.

- `identity_status`, no arguments: immediate snapshot, no OS lookup or mutation.
- `identity_import_legacy`, `{ request: { expectedPubkey, generation, revocation,
  source: "buzzDesktopBlob" | "buzzDesktopPerKey", consent: true } }`.
- `identity_unlock_saved`, `{ request: { expectedPubkey, generation, revocation } }`.
- `identity_sign_out`, `{ request: { revocation } }`.
- Errors: `{ code }`, stable camelCase variants from `src-tauri/src/identity/dto.rs`.
  No native error text or request echo. `cancelled` means stale intent; reconcile
  status, NEVER retry a mutation with freshly adopted authority automatically.

Capture requests once at the user action. Activation checks BOTH revision and
revocation before admitting one blocking task. Admission consumes the revision;
completion consumes another revision. Retransmission cannot perform OS IO twice.
At most one OS operation is admitted, including cancelled work still blocked in OS.
There is no growing worker queue and no claim that sign-out cancels OS prompts.

Sign-out matches only revocation (not a status sequence / activation revision),
revokes immediately and rotates revocation. Thus it works with the pre-unlock
snapshot while an OS operation/reply is stuck, but a delayed duplicate cannot
revoke a later login. Status checks never invalidate sign-out. Completion of a
cancelled operation may leave a create-only saved copy, never active authority.
Ordinary renderer reload preserves native identity; true process exit revokes.

Frontend must fence stale/misrouted results and recover after a missing reply.
A JS timeout is not native cancellation or proof that Tauri freed callback memory.
Status recovery cannot stay pinned forever to a rejected/missing promise. Bound
app-owned requests and use explicit reconciliation, without URL tickets, receipt
ledgers, reload counters or periodic background polling. Saved public selection is
only a local hint; never derive signing authority from it. Clear old identity views
before calling arbitrary observers (host community owner integration is separate).

## Storage and platform status

Create-only versioned OS record; explicit selected legacy source, verify derived
public key before save, uncached read-back before activation. Sign-out does not
delete or modify saved/legacy keys. No plaintext fallback. Existing macOS adapter
is reused; Windows/Linux storage adapters and validation are STILL REQUIRED before
cross-platform readiness. Unsupported hosts must fail clearly, not silently fallback.

Tests use an in-memory store; platform adapter refuses live OS access under tests.
No native launch or real credential access in this development batch. Attended
package acceptance needs agreed app-data AND credential namespaces separately.

## Validation boundaries

The native handler, frontend controller, Account UI, account-isolated community
owner and terminal session-cleanup regressions use synthetic credentials. The
production composition still keeps native community IO disconnected: an active
Account must not silently select a development broker's potentially different key.
Browser development continues to use its existing broker.

Remaining gates: native purpose-bound reads/writes/onboarding; actual invoke
fallback/callback loss/reload recovery; broader integration checks and review of
native IO; separately authorized synthetic packaged workflow. Unit mocks alone do
not close the packaged/fallback gates. Existing sessions and the durable outbox
remain the owners; exact signed unknown-outcome intent stays in its original
origin/viewer partition across account changes.
