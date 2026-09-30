# Sign in with Buzz inside the run402 panel

A run402 site framed by the run402 panel can ask the host to sign the same
kind-24243 identity binding old Buzz Desktop signs for a `buzz://nostr-bind`
link, without leaving the panel or typing a verification code.

## Messages

Site to host, posted to `window.parent` (the request carries no secret):

```js
{ type: "buzz.nostr-bind.request", version: 1, deepLink: "buzz://nostr-bind?..." }
```

Host to site, posted only to the framed origin:

```js
{ type: "buzz.nostr-bind.result", version: 1, challengeId, event }
{ type: "buzz.nostr-bind.result", version: 1, challengeId,
  error: "declined" | "expired" | "unavailable" | "invalid" }
```

The site should accept a result only when `event.source === window.parent` and
`challengeId` matches its pending challenge, then submit `event` to its own
verifier. With no answer after a few seconds, or any `error`, it falls back to
its ordinary code flow.

## Host rules

- The host listens only to messages whose `source` is the panel's own frame
  window and whose `origin` is the framed site's origin. This works with or
  without a channel context.
- The link is validated as old Buzz Desktop validates it (UUID challenge,
  43-character base64url nonce, 6-digit code, fixed audience/action/protocol/
  version, RFC 3339 expiry, `clipboard` or `browser_fragment_v1` return mode,
  same-origin https `callback_url`). In addition the signed `origin` must equal
  the framed origin exactly; that host-verified origin replaces the typed code.
  The site's code is still copied unchanged into the signed tags.
- One request is pending at a time; a second is answered `unavailable`. A
  challenge id is answered at most once; repeats are ignored.
- The host shows "*framed origin* wants to sign you in as *viewer*" above the
  frame. The origin text comes from the host, never the site. Nothing is signed
  until the user presses **Sign in**; **Not now** answers `declined`. There is
  no remembered consent. Reloading the frame retires a pending request.

## Signer

Only the development broker signs, through its dedicated
`POST /api/relay/nostr-bind-sign` route. It accepts nothing but
`{ kind: 24243, content: "", tags }` with the exact nine tags, re-validates them
(including an https bare origin and an expiry in the future, at most ten
minutes out), sets `created_at`, and signs with the viewer's key. The general
`/api/relay/sign` route does not sign this kind. With native identity there is
no signer yet, so the host answers `unavailable`.
