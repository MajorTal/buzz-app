# Packaged human identity and relay access

Native macOS without the live development broker asks the user to **Use an existing
key** or **Create a new identity**. These are alternatives. Import accepts an nsec,
validates its checksum and secp256k1 scalar, and persists that exact key before
adopting its public identity. It never generates a replacement after an import,
read or write failure. Denied/unavailable/corrupt storage is not first run.

One native owner keeps the key in memory after successful restore. The new
create-only Keychain item is service `dev.local.buzz.foundation.identity` in release
builds, or `dev.local.buzz.foundation.identity.debug` with Rust debug assertions,
account `human`, in the default macOS file Keychain. Debug worktrees share the debug
item, not the release identity; ports and frontend dev mode do not isolate it. It uses the same security-framework
primitives as the existing agent adapter, but does not use or change agent
credentials or old Buzz's `buzz-desktop/secrets` blob. A competing item refuses
overwrite. There is no file/environment fallback, automatic legacy migration,
key replacement or delete command. Windows/Linux storage is explicitly unavailable
in this slice; those platforms skip onboarding and keep the unavailable shell.
No user key belongs in release configuration.

A shared credential blob can reduce repeated OS prompts by caching many credentials
after one read. For this one human key, one cached item retains that read-once benefit without
coupling human writes to agent credentials or old-app blob writers. This is not a
claim that per-secret storage is always superior or that prompts are eliminated.
Consent, app signing and update behavior require attended native verification.

## UI and sensitive data

Settings exposes Profile in Personal space as well as in a selected community.
Identity details remains available if the community profile cannot load. The full
npub and hex public key can be copied. The nsec is absent from the rendered field
until Reveal; Copy can fetch it without revealing it. Hide, leaving Profile,
window blur and document hiding retire pending reveals and clear the displayed
secret. Failed private-key actions report fixed errors. Copy deliberately leaves
the key on the OS clipboard; the UI warns about that.

The app UI passes a private string through IPC only during explicit import/export
interaction. JavaScript/IPC string memory is not guaranteed zeroized. Native
key bytes and temporary storage buffers use zeroizing owners, but this is not a
claim that every framework allocation is wiped. No secret is put in public
snapshots, plugin service registrations, localStorage, logs or relay events.
The main app and its same-origin plugins are trusted, not isolated security
principals; plugin JavaScript can invoke `identity_export` directly. Not registering
a plugin key service is an API ownership choice, not a sandbox. The main-webview
command permission is not proof of a human gesture.

## Packaged connection

A public native viewer hydrates the existing public-key-scoped local profile and
memberships. On macOS, app composition supplies the native relay adapter after
identity restoration. Only the selected saved community opens on restart; Personal
space stays disconnected. Discovery failure leaves the community retryable.
Native sessions do **not** fall through to the dev broker signer.

The native identity owner signs event templates and authenticates HTTP with
NIP-98, including the exact request URL, method, body hash and a fresh nonce for
each attempt. Native networking permits only the discovery, join-policy, invite
acceptance/claim, query and event routes on HTTPS origins, with bounded bodies,
timeouts and no redirects. JavaScript never obtains the private key for transport.
NIP-11 `self` establishes relay authority; the operator-contact `pubkey` is not
a substitute. The existing live owner handles WSS/NIP-42 authentication and
signature verification. IPC permissions remain limited to the main WebView.

Community admission, kind-0 profile reads/publication and the adapter's advertised
message/event writes use this identity. [Join recovery](communities.md#packaged-admission-and-recovery)
records public progress before remote changes. The existing durable outbox retains
uncertain delivery across restart; retry uses the same signed event with fresh HTTP
authentication. Events older than 15 minutes get a strong ID readback instead of
being republished or silently re-dated. Missing/failed readback retains uncertainty;
the user must inspect the conversation before explicitly sending a new message.

Optional capabilities are absent until implemented: protected media/upload,
workflow commands/history, repository HTTP, lifecycle and other broker-only
helpers are not claimed by this adapter. Public HTTPS avatars/icons can display;
protected media does not gain access from the image CSP allowance. NIP-FI assertion
acquisition is not implemented, so deployments enforcing it are outside acceptance.
Windows/Linux custody, credential migration and release-signing acceptance remain
separate limitations.

Development with `VITE_BUZZ_LIVE=1` continues to use its pinned legacy broker
identity, and does not offer native private-key controls. Creating/importing the
new native item does not update that old blob. Future reset/rotation would not
synchronize copies automatically; neither operation is in this scope.

## Try the UI without credentials

Use the existing environment-free fixture Vite config:

```sh
bin/pnpm exec vite --config tests/fixtures/agent-control.vite.mjs --port 1547
```

Open `/tests/fixtures/identity.html`. It uses mock IPC and an in-memory public
fixture key, not Keychain or a relay. Import accepts only the displayed fixture
key. Reset and simulated restart affect fixture state only. **Never enter a real
nsec.** Browser exercises prove UI behavior, not secure native persistence.

Before real-key use or a usable-release claim: independent custody review,
isolated native consent/denial/import/create/restart checks, human UI feedback,
and installed-app live read/send/receipt/restart acceptance are still required.
Do not launch/restart someone's desktop app or inspect their credentials to test.
