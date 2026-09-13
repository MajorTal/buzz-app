# Client and community ownership

The app opens into Personal space with no joined community. The shell, local
profile editor, Home, Settings and plugin management do not wait for a relay.
`features/communities/service.ts` owns the local identity's default profile,
saved memberships and optional selection. `features/relay/session.ts` still owns
each community's queries, live subscriptions, projections and durable outbox.

## Try it

Configure `BUZZ_DEV_VIEWER` with your existing Buzz public key in `.env.local`
([setup and safety notes](../README.md#relay-channels)), then run
`just web` and open http://localhost:1430, or use `just desktop` instead. The
development broker requires macOS and refuses a Keychain identity that does not
match your explicit public pin.
Click the avatar → **Settings → Profile** to edit and save a local default
directly in the page, then **Switch community → Add a community** and type a **Relay URL**. There
is no destination dropdown. Accepts `wss://` or `https://` origins, for example
`wss://relay.example.com` or `wss://other.example.com`, and other
Buzz-compatible community relays. No community is pre-joined.

Surrounding whitespace, host case, a final DNS dot, default port 443 and a single
root slash normalize to the same HTTPS origin. Non-default ports are preserved.
Credentials, insecure schemes, non-root paths, query and fragment are rejected,
not silently stripped. Continue starts discovery and authenticated profile reads;
typing does not contact a relay. The canonical origin stays visible before policy
acceptance or profile publication. Failed setup keeps the typed input and current
selection. Reopening the same canonical origin does not duplicate its membership.

An existing readable profile is offered unchanged: **Open community** saves the
membership locally without publishing. New setup shows the relay's join policy,
optional invite code, then a profile prefilled from the local default. Invite
admission uses the relay's policy receipt and signed claim endpoints. Profile
publication uses a signed kind:0 event and requires a matching accepted receipt
before the client saves the completed membership. Rejected setup retains input
and does not replace the currently selected community. An admitted invite is a
remote side effect and is not undone if later profile setup fails or is cancelled.

Profile editing preserves existing fields that this editor does not expose.
Changing a community profile does not change the local default. The first
completed community setup seeds the local default only when it is still empty.
Native setup uses the hydrated session outbox for kind-0 intent, requires fresh
remote evidence of its exact event ID, and reuses that outbox after local join. An
accepted receipt alone does not establish the current profile. Unknown retries
keep the saved event; see [native identity contract](identity-security.md).

Picture setup currently accepts HTTPS URLs, not uploads; a protected media URL
from one community is not a portable public avatar for another.

Open **Switch community** at the top left and select a community to switch. Personal space
clears selection without forgetting memberships. Messages shows an intentional
empty state there. Try drafting in A, switching to B, then returning to A.
Selected channels, drafts and reading offsets are partitioned by the canonical
community origin and viewer; channel IDs alone are not sufficient keys.

## Session lifetime

Selecting a saved membership lazily acquires its session. Sessions survive page
navigation and switching; startup opens only the selected one. Opened communities
retain their existing per-session query/cache budgets. Arbitrary destinations mean
there is **no longer a two-session maximum**: retained session count grows with
communities opened until app disposal. This slice does not add background eviction
or change in-flight delivery ownership. A failed session remains retryable without
replacing the shell or its siblings.
App disposal closes all owned contexts and their subscriptions.

The `ctx.relay` compatibility reader follows selection. A component captures a
concrete session for reads and commands. Every broker request, including signing,
publishing, media and live traffic, uses that session's destination path. A send
started in A continues in A even after B becomes selected. Connection generations
still fence obsolete work within a session; they are not persistent storage keys.
Channel-head persistence now includes community origin as well as viewer, rather
than relying solely on the relay signing key. Identity keys never enter browser
JavaScript; local preferences contain the public viewer ID only.

Packaged builds do not include the broker. The native Account adapter now supplies
finite reads, kind-0/9 signing/publication and policy/claim setup through the same
host owners; [native identity](identity-security.md) records its narrower capabilities
and unverified package/platform gates. Explicit legacy copy and saved unlock are
implemented; independent key entry, community creation/removal, agent enrollment,
avatar uploads and background connection eviction are not implemented. Agents should eventually have local
configuration plus separately scoped participation; selecting a community must
not become a deployment or enrollment command.

## Development broker boundary

One parser in `features/communities/destination.ts` serves UI, membership hydration
and broker routing. Optional `BUZZ_COMMUNITY_ALIASES` JSON configuration maps
previously saved short IDs to secure origins; no aliases ship by default. Set the
same alias-to-origin mappings in ignored `.env.local` to reopen memberships that
use short IDs. Unknown but valid aliases are retained in local storage without
being shown or connected; profile edits preserve their saved selection. An explicit
Personal selection or a new join replaces that selection, not the retained membership.
Restore the original configuration and restart to make those memberships available
again. Never remap an existing alias to another community. With no configured alias, new community IDs
are canonical HTTPS origins. Existing origin + viewer storage
keys for drafts, reading state and outbox do not change. Saved aliases and URL
variants deduplicate; malformed saved destinations are ignored independently.

Before contacting a new origin, the client makes a same-origin POST to
`/api/relay/register`. Registration validates and remembers the origin in the
broker process, with **no upstream request, join or signature**. Scoped routes
only resolve registered destinations (configured aliases remain available for
old callers). `BUZZ_RELAY_URL` optionally supplies the unscoped broker destination;
without it unscoped relay operations fail explicitly. `/api/relay/identity` stays
available independently. These settings do not join/select a community or send a
request on startup. Both are public routing values, not credentials; alias mappings
are embedded in the frontend. Restart/rebuild after changing them. Environment
variables override `.env.local`; see `.env.example`. Session acquisition/retry registers again, including startup of a
saved custom community after broker restart. Query/sign/publish, policy/claim,
metadata, protected media and live traffic stay bound to the captured destination.
HTTP authority discovery and other upstream fetches reject redirects.

The broker keeps its loopback Host check, requires exact local Origin on POSTs,
and rejects mismatched Origin or non-same-origin Fetch Metadata on GETs too.
This establishes **trusted-app-origin intent, not a human gesture**; same-origin
plugins and local processes remain trusted, not sandboxed. User-directed HTTPS
networking may reach internal/private destinations. This is not a public-only
network policy or DNS-rebinding defense; TLS verification remains enabled.
The broker adds no CSP widening or private key exposure to JavaScript. Native
identity has a separate purpose-bound adapter, never a broker fallback.

## Verification

`src/features/communities/service.test.ts` covers no-community initialization,
local profiles, scoped view intent, session retention and selective restoration.
`broker.test.ts` runs real localhost HTTP with signed fixture events to verify
multi-community routing, profile publication, invite claims, and a captured send
after opening another community. `destination.test.ts` checks normalization and
rejection; `broker-url.test.ts` exercises the real middleware with isolated signing
keys and upstream fixtures, including registration, cross-origin guards, all route
sinks and captured sends. Service tests cover arbitrary membership persistence,
selected-only restore, retry registration and equivalent-URL selection. Existing relay tests cover connection generations,
late responses, delivery and revocation. Run `just scan` for the full checks.

Open `/tests/fixtures/communities.html` for a browser-only fixture of the actual dialog.
It intercepts all broker requests and uses a separate fixture identity. Save a
local profile, join using any invite code, and customize the prefilled name. The
first profile publication deliberately fails; retrying should add the membership
while keeping the local name unchanged. No remote membership, profile, or policy
acceptance is created by this fixture. Live validation with an authorized identity can restore existing profiles and
read selected communities without posting test messages. The fixture itself is
not evidence of live access; see [manual fixture setup](contributing.md#manual-browser-fixtures).
