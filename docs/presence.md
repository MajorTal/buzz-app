# Periodically refreshed community presence

Message and thread bylines and profiles show Online, Away, Offline or Unknown
with text and distinct symbols, not color alone. This is snapshot presence, not
an immediate live-status stream.

## Ownership and bounds

- One app input source derives Away after ten minutes without Buzz input. Focus
  loss and changing communities alone do not mean Away. Same-origin windows share
  recent input through BroadcastChannel; no machine-idle or cross-device claim.
- Each retained connected session owns one volatile presence directory. Mounted
  rows (including timeline overscan and offscreen thread replies) demand authors.
  At most 256 unique authors are selected; profiles take priority, then existing
  selections and stable acquisition order. Overflow stays Unknown with a tooltip.
- Initial/new demand coalesces for 100ms behind a five-second start gate. Successful
  views refresh after 60–65 seconds. Evidence expires 75 seconds after request start.
  Empty demand makes no request; removed authors lose their evidence. Hidden views,
  disconnect, access/cache invalidation and disposal invalidate observations.
- One bounded complete snapshot is validated before any status changes. The
  configured relay must sign each unique requested subject; only a successful
  complete response can make omitted subjects Offline. This is read-time evidence,
  not the relay's remaining lease. Invalid or failed responses mean Unknown.
- The development broker permits one optional HTTP flight, a principal-wide
  five-second start gate, 256 subjects, a 20 KiB request and 1 MiB response, and
  a ten-second request lifetime. Optional work never uses ordinary read slots or
  dispatch credit. Local busy skips retry after 5–6 seconds; network failures wait
  60–65 seconds, honoring longer server cooldowns.
- Renewal uses the existing authenticated socket, with a Web Lock per scope/viewer
  serializing same-origin windows. Publication is lossy and bounded; it never
  enters the durable outbox, replays missed ticks, or publishes Offline on close.
  Hidden observation does not stop connected-community renewal. Actual shared
  relay cooldowns still take priority. A locally unsent publication
  retries current status after 5–6 seconds through the same renewal timer; refused
  or unconfirmed publications retain the 60–65 second interval.

Bounded presence reads and publications can run during ordinary HTTP work and
channel subscription setup; neither waits for the entire host to become idle.
Unknown can persist during relay cooldowns or unavailability. These limits bound
client work; they do not
promise zero CPU/network/backend cost, instant transitions, or a delivery SLA.
There are no presence REQs, added sockets, relay changes, or direct-adapter parity.

## Validation

Owner tests live with `features/presence`, relay transport/admission and the broker.
`tests/browser/presence.spec.mjs` exercises the built app and production broker with
modeled upstream and ephemeral keys: held snapshots versus chat, shared row demand,
300 distinct thread authors, Unknown during held replacement reads, and real
same-origin Web Lock handoff. `channel-opening.spec.mjs` includes matched-thread
measurement support. See [browser measurement limits](browser-testing.md).

These fixtures do not certify deployed relay capacity, native-window behavior,
attended account use, or cross-device availability. Full browser activity/idle
transition integration and the complete changed-call-site mutation audit remain
separate validation work; activity derivation has controlled owner tests.
