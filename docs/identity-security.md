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

## Native community IO

Production native composition uses seven fixed commands from
`src-tauri/src/identity/relay`; it never selects the development broker:
`community_discover`, `community_query`, `community_sign_message`,
`community_sign_profile`, `community_publish`, `community_accept_policy`,
`community_claim`. Requests carry `{scope: {origin, expectedPubkey, generation,
revocation}, ...purposeFields}`; success returns `{scope, value}`. No generic URL,
HTTP method or signing operation is exposed. Native validates authority before
signing/dispatch and after IO; the host also fences returned scope/account.

Native constructs fresh URL/method/body-bound NIP-98 for fixed authenticated
endpoints. Data-event retries preserve the saved signature, timestamp and ID.
HTTPS only, no redirects or implicit HTTP retries; six native operations maximum,
20-second per-request / 5-second connect deadlines, bounded request/response JSON.
The host retains its shared origin/viewer admission lane and caps unresolved
invocations at six with a 25-second caller deadline. JS timeout/abort does not
prove native cancellation or callback reclamation.

The connector advertises finite verified reads and kind-0/9 writes only. Native
live/NIP-42, protected media, encrypted sidebar/read-state, agent activity/library
and GIF support are omitted, not silently routed to the broker. Public external
HTTPS image URLs remain usable. User-selected HTTPS origins can be private/internal;
this is not a public-network-only policy or a DNS-rebinding defense.

Setup acquires the existing origin/viewer session before local membership commit
and waits for its durable outbox to hydrate. Failed hydration is not an empty
journal. The same session/outbox survives local join. Profile recovery checks fresh
verified remote kind-0 state, never local pending projections: an accepted duplicate
may be a superseded event, not the current profile. Saved intent is retried by exact
ID; conflicting or superseded edits require explicit review, not automatic resigning.

Errors expose stable redacted codes and write outcomes `notSent`, `rejected`, or
`unknown`; a rejected retry cannot disprove an earlier uncertain write. Invite/policy
receipt expiry can reject retry after a successful claim. The dialog retains the
captured invite/receipt while retrying and never automatically re-accepts policy.
Profile or local setup cancellation does not undo remote membership.

## Validation boundaries

Native handlers use the same command registration as production, with synthetic
in-memory credentials and loopback HTTP. Host composition tests cover native
setup → profile publication → local join → message send → sign-out with mocked
invoke. Browser Account/profile/community journeys do not prove native IPC or TLS.

Remaining gates: actual invoke fallback/callback loss/reload recovery, broader
CI/integration and independent review, separately authorized synthetic packaged
workflow, independent existing-key input, and Windows/Linux secure-store adapters.
Unit mocks alone do not close these gates. Existing sessions and the durable outbox
remain the owners; exact signed unknown-outcome intent stays in its original
origin/viewer partition across account changes.
