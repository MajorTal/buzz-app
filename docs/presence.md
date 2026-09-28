# Periodically refreshed community presence

Profiles show Active, Away, or Offline with text, while avatar badges use
solid status fills. Pending, failed, stale, or unavailable evidence renders no
status; it is not relabeled Offline. Message and thread bylines display badges
and demand presence when mounted, as do one-to-one DM avatars in the sidebar.
This describes recent Buzz session status in this community, not proof that a
person is available or an
immediate live-status stream. The relay stores one status per community/pubkey:
multiple devices are last-writer-wins, so an idle device can report Away even
while another is active. A crashed connection's lease can remain for up to 180
seconds; refreshing the snapshot does not prove that the session is still alive.

## Your status

The avatar dot shows your locally chosen/derived status, not an authoritative
relay readback. Its account dropdown keeps Settings and offers **Online**,
**Away**, and **Offline**, using the shared keyboard-accessible radio group.
The checked choice reflects the current status. Automatic activity detection is
internal: new/default and previously saved `auto` preferences return to Online
on input/foreground return and Away after ten idle minutes. Selecting a
status, including reselecting the checked status, saves a manual override;
explicit Online, Away, and Offline choices persist
through idle and input. Automatic is not a menu choice.

Online label text and avatar centers use Green 10. Away avatar centers and label backgrounds
use Amber 10; the avatar badges have Green 11 / Amber 11 outlines against surrounding surfaces.
Away label text uses the mode-aware Amber 12 `text-warning` role.
Label backgrounds mix their status color at 12%, 18% on hover, and 24% while
pressed/open. Online and neutral Offline mix over `surface-inset` for a darker
fill; Away keeps its translucent fill over the menu. Against the actual white
light menu and #333333 dark menu, label contrast is:

| Label | Light resting / hover / open | Dark resting / hover / open |
| --- | --- | --- |
| Online | 2.87 / 2.69 / 2.51 | 5.90 / 5.32 / 4.74 |
| Away | 10.63 / 10.28 / 9.94 | 7.76 / 6.65 / 5.70 |
| Offline | 6.00 / 5.47 / 4.96 | 8.96 / 7.70 / 6.53 |

These are WCAG contrast ratios. Away and Offline pass AA's 4.5:1 small-text
target in both modes. Online passes in dark mode but still fails in light mode,
where darkening its fill reduces contrast with Green 10 text. The avatar
outlines meet the 3:1 non-text boundary target against supported surfaces.

The design guide also requires APCA Lc60 for text. Online misses that target in
both themes: approximately Lc40–48 in light mode and Lc44–47 in dark mode across
the same states. Its dark-mode WCAG pass does not establish APCA compliance.

The Online label is a deliberate design exception, approved to preserve the Green 10
palette and Medium (500) availability capsule shown in the
[review snapshots](https://github.com/block/buzz-app/pull/323). Its composited fills
are outside the static token-pair guard, so its measured text exception is recorded
here. Passing the guard does not mean the Online label meets contrast targets.
Presence still has accessible status text, and the dropdown uses standard text
colors; that does not remedy the visual shortfall.

The one app activity owner stores `auto | online | away | offline` per viewer in
`buzz-presence.v1:<pubkey>`. Same-origin windows observe storage changes; all
retained communities use that viewer's intent. Startup restores it before opening
a session. Existing `auto` values remain valid without migration; missing or
unrecognized values fall back to `auto`. Storage failure applies only to the
current window and displays a warning. This is device-local, not cross-device
arbitration: another device or CLI can overwrite the relay's last-writer-wins status.

The existing authenticated publisher sends bare kind:20001 status. An accepted
Offline clears presence once without renewal; locally unsent/refused/unconfirmed
clears retry on the existing cadence, and reconnect or lock handoff publishes
current intent again. A failed publication does not roll back the saved choice
or imply confirmed delivery. There is no durable invisible policy on the relay.

## Ownership and bounds

- One app input source derives Away after ten minutes without Buzz input. Focus
  loss and changing communities alone do not mean Away. Foreground return counts
  as activity; capture-phase input also observes editors that stop bubbling,
  including input without a keydown. Same-origin windows share
  recent input through BroadcastChannel; no machine-idle or cross-device claim.
- Each retained connected session owns one volatile presence directory. Mounted
  profiles, message bylines, and one-to-one DM sidebar rows demand authors. At
  most 256 unique authors are selected; profiles take priority, then existing
  selections and stable acquisition order. Overflow has no visible status.
- Initial/new demand coalesces for 100ms, waiting at least five seconds after the
  previous read settles so transit cannot race the broker’s start gate. Successful
  views refresh after 60–65 seconds. Evidence expires 75 seconds after request start.
  Empty demand makes no request; removed authors lose their evidence. Hidden views,
  disconnect, access/cache invalidation and disposal invalidate observations.
- One bounded complete snapshot is validated before any status changes. The
  configured relay must sign each unique requested subject; only a successful
  complete response can make omitted subjects Offline. This is read-time evidence,
  not the relay's remaining lease. Invalid or failed responses mean Unknown for
  the whole snapshot. Valid relay-signed unsupported statuses mean Unknown only
  for that subject; canonical peers and complete-response omissions remain usable.
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
Unavailable evidence can persist during relay cooldowns or unavailability. These limits bound
client work; they do not
promise zero CPU/network/backend cost, instant transitions, or a delivery SLA.
There are no presence REQs, added sockets, relay changes, or direct-adapter parity.

## Validation

Owner tests live with `features/presence`, relay transport/admission and the broker.
`tests/browser/presence.spec.mjs` exercises the built app and production broker with
modeled upstream and ephemeral keys: held profile snapshots versus chat,
byline presence/demand, avatar choices and reload, and real same-origin preference
synchronization/Web Lock handoff while Offline. `settings.spec.mjs` retains the
account disclosure, keyboard traversal and Settings journey in both engines. `channel-opening.spec.mjs` includes matched-thread
measurement support. See [browser measurement limits](browser-testing.md).

These fixtures do not certify deployed relay capacity, native-window behavior,
attended account use, or cross-device availability. Full production-broker browser
idle/publication integration remains unverified; controlled DOM owner tests cover
captured input, idle, foreground return, disposal, overrides, storage failure,
viewer isolation, Offline retry/no-renewal/reconnect and derived publication.
The isolated source preview also exercises idle/input through the avatar indicator.
