# Virtua 0.51.0 macOS WebKit correction boundary

The application imports the React ESM entry (`virtua` → `lib/index.js`) from
`src/features/messages/ChannelTimeline.tsx`. Only that entry's element scroller is
patched; CommonJS, window scrolling, and other-framework exports are untouched.
Keep the dependency pinned to 0.51.0 and review the patch plus version-coupled
installed-bundle tests before upgrading or adding a different import.

## Failure and chosen boundary

In a system WKWebView, native momentum can overwrite an instant programmatic
scroll correction. An isolated reproduction adapted from
[WebKit 262287](https://bugs.webkit.org/show_bug.cgi?id=262287) sustains missing
pixels even after DOM geometry covers the viewport. The same failure reproduces
with the production ChannelTimeline and fixed messages when history is prepended.
This does not attribute every disappearing-content incident to this mechanism.

The previous Mac deferred-store/extent patch is **superseded**. A pause in native
momentum can outlast Virtua's 150ms inferred-idle timer: the deferred correction
then runs before native momentum actually ends, and the timeline stays blank.
One of two paused draft trials failed; this was timing-dependent, not a
universally failing sequence. Increasing an idle timeout is not the remedy.

Instead, at each **nonzero automatic correction** on Mac WebKit:

1. Temporarily set only the corrected overflow axis to `hidden !important`.
2. Apply Virtua's original relative correction or absolute edge target.
3. Restore the prior declaration value and priority in the next task.

This extends the mechanism already used by
[Virtua's iOS driver](https://github.com/inokawa/virtua/blob/0.51.0/src/core/driver.ts#L203-L248),
without changing the iOS branch. Overlapping interventions cancel/restore their
predecessor before capturing the original declaration. Disposal restores
immediately; an observably changed later declaration is not overwritten.

**Tradeoff:** a correction can stop the remaining trackpad coast. Several size
corrections can therefore reduce inertial travel more than one prepend. A fresh
gesture must continue to work; sustained real-history/media acceptance must assess
whether repeated braking is acceptable. No wheel ownership, permanent scrolling
CSS, forced layout, alternate store sizing, or new scroll scheduler is introduced.

The platform predicate requires MacIntel and Apple vendor, excluding Virtua's iOS
detector (including desktop-mode iPad). Chrome/Firefox, non-Mac WebKit and iOS keep
existing correction policy. Store/layout updates, ordinary row observation and
imperative smooth/instant navigation retain upstream timing. Registrations made
inside resize delivery are deferred as described below. Scheduler-driven reveal/restore/bottom navigation is a
separate acceptance path, not implicitly repaired by the automatic-correction fix.
Native reveal controls showed one/two transient blank interior source frames
before immediate recovery, despite valid sampled DOM coverage. This remaining
imperative-path flicker is not the sustained automatic-correction failure; the
patch does not claim to fix it.
The stale source-map directive is removed because the generated map is unpatched.

## Observation during resize delivery

Compact grouped bubbles can cause measured rows to reveal more siblings. When
Virtua synchronously renders and observes those siblings inside ResizeObserver,
WebKit reports skipped notifications at the same DOM depth.

Only registrations made during resize delivery wait until the next animation
frame. Ordinary mounting (including before driver attachment), size delivery,
adaptive estimates, and scroll corrections keep their upstream timing. The row's
owner window schedules the frame. Unobserving removes a pending registration;
disposal cancels the frame and clears pending rows. Hidden rows stay observed so
later visibility changes can be measured. A `finally` resets the delivery flag
if a subscriber throws. This extends only the already-patched React ESM element
scroller; no other adapter or window scroller is changed.

Installed-bundle tests cover reentrant registration, synchronous measurements,
pre-attachment cleanup, hidden/reassigned rows, cancellation, remount and errors.
Strict membership, pagination, cold restoration and opening browser checks cover
the integration without suppressing observer errors or changing timing budgets.

## Automated checks

```sh
bin/pnpm install --frozen-lockfile
bin/pnpm typecheck
bin/pnpm exec vitest run src/features/messages/virtua-compensation.test.mjs \
  src/features/messages/ChannelTimeline.test.tsx
bin/pnpm test:browser history-loading.spec.mjs image-scroll.spec.mjs initial-position.spec.mjs \
  --project chromium --project webkit --no-deps --workers=1
```

The 18 driver/store/observer contracts evaluate the installed React ESM, not a
copied implementation. They cover active and inferred-idle corrections, zero
jumps, positive/negative measurements, absolute edges, horizontal RTL, overlapping
restoration, CSS priority, disposal/remount, later declarations, platform controls,
and unchanged imperative instant/smooth calls. Copied-bundle mutation controls
must fail when the production invocation, overlap/dispose restoration, priority,
or iPad exclusion is removed, or an inferred-scrolling gate is introduced.
These tests use a fake viewport; they cannot establish native painted pixels.

## Native acceptance and limits

Use an isolated system WKWebView, fixed data, no live identity, and phase-bearing
native wheel/momentum input confined to that window. Freeze/hash the source,
installed bundle and runner before each run. Start with a settled production
ChannelTimeline, prepend during momentum, then repeat with a pause longer than
150ms before the final momentum event. Compare stock, the superseded draft, and
the replacement. Capture source video frames separately from DOM/anchor traces.

Require both painted content and the correct identified reading anchor. Repeat
with a fresh reversed gesture, a second prepend at the bottom, a fresh upward
gesture, positive/negative row measurement changes, and explicitly gated local
images. Check restoration and continued movement, not just final scrollTop.
Exercise imperative reveal/restore/bottom controls separately. A pending image
placeholder and bottom rubberband/fractional edge gaps are not missing tiles.

Observed on macOS 26.6.2: stock and a paused old-draft trial sustain blank message
pixels; the replacement preserves content and correction anchors in the matched
native trials. Repeated native gestures and local images continue to paint, with
the braking tradeoff above. Ordinary Chromium/WebKit browser history, image and
initial-position journeys provide additional behavioral coverage, **not equivalent
native momentum/compositor evidence**.

The fixed-data native fixture does not fetch real older history. Three-second
movies are not four seconds of pixel evidence just because DOM traces run longer;
movie and JavaScript clocks are not synchronized. These bounded results are not
signed-package/cross-platform acceptance or verification of the original user's
sustained real-message incident. Keep the change draft until that acceptance is
completed; do not restart a running app without coordination.
