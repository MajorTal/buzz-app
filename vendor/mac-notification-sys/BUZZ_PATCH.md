# Local macOS notification polling patch

Source: mac-notification-sys **0.6.15** from crates.io, upstream commit
`deb559683962d314a7693478476bf8d052efa84e`.
Crate SHA-256: `fd604973958ddcc11b561193c0fb96ba146506ef2f231ef2e7c35fd2cbc9beca`.
Upstream: <https://github.com/h4llow3En/mac-notification-sys>.
The two license files are from that exact upstream commit (omitted by its crate
packaging); existing source attribution is preserved.

Only `objc/notify.m` changes production behavior. One main-run-loop timer queries
`deliveredNotifications` once per tick for all waiting notifications, instead of
one synchronous IPC query per notification every 0.5 seconds. Registration and
removal are serialized on the main queue. Empty batches stop the timer. Delivered
cards do not expire; clicks, explicit dismissal and disappearance retain the
existing terminal-result handling. Fire-and-forget delivery is unchanged.

The snapshot includes the upstream manifest, build script and tests unchanged.
Repository pre-commit rustfmt reorders imports and wraps one assertion in
`src/bridge.rs`, `src/lib.rs` and `src/pending_guard.rs`; their behavior is unchanged. `src-tauri/tests/notification_polling.m` compiles the actual
production poll with fake OS/response boundaries; it sends no notifications. Its
Rust runner includes it in the app's ordinary macOS native test suite. Current CI
has no macOS runner, so this check requires local macOS validation. Standalone
upstream package tests: `bin/cargo test --manifest-path
vendor/mac-notification-sys/Cargo.toml`.

Keep this patch until an upstream release eliminates per-card polling while
preserving Notification Center click handling. Do not replace it with a timeout
that abandons otherwise actionable notifications. Test native banners and clicks
under both development and packaged identities before claiming release acceptance.

No upstream fix PR/release was identified when this patch was added; no upstream
submission is claimed. The remove condition is a released fix with the same
constant-query and retained-click contract, not simply a newer version number.
