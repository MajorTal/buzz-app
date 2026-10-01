# Native launch protection providers

The controller accepts native launcher registrations and opaque per-agent policy bindings through `security::Request`. Policy schemas and enforcement belong to the provider; the host has no sandbox-engine dependency.

Registration requires an absolute executable path, fingerprints its bytes and returns an opaque lease. Unregistering a lease removes that registration; a late unregister cannot remove a replacement registration. Saving a binding requires an available provider and the current agent revision. A null binding explicitly clears protection.

All controller start and restart paths resolve the saved provider immediately before spawning. Missing or changed providers fail closed. Existing running processes are not changed by policy edits or lease disposal.

The host uses the ACP launch-prefix hook from [block/buzz#7985](https://github.com/block/buzz/pull/7985). ACP keeps the real worker identity, normalizes its arguments, then invokes the provider as `--launch <path> -- <worker> [args...]`. The private version-2 JSON context contains `providerDirectory`, `policy`, `relayUrl`, `workspace` and `protectedPaths`. The launcher must preserve ACP stdin/stdout, apply its policy, and supervise the worker. Resolve bundled provider resources relative to `providerDirectory`, not the staged launcher's location.

Before starting the harness, the host reads and verifies the registered launcher, then stages those same bytes alongside the context in a private per-run directory under the shared `run-controls` namespace. Lazy worker starts and worker replacements use that snapshot. Host restarts verify the original registration again. Providers must deny every protected worker writes to that entire namespace, covering concurrent runs and runs created later. The existing supervisor owns both the snapshot and separate scratch directory, removing them only after confirmed session teardown.

Protected paths include agent-store control files and atomic-write staging, process ownership records, additional control paths supplied by the native caller, bundled runtime, host executable, provider directory and run controls. Some control files do not yet exist on a fresh profile: providers must enforce these future paths too. Native code supplies them rather than the policy editor. The containing store and separate `runs` scratch namespace remain writable for OAuth-cache locks/atomic replacement and temporary files; providers must also prevent renaming or deleting ancestors of protected paths.

An opt-in macOS integration test accepts `BUZZ_TEST_PROTECTION_LAUNCHER` and `BUZZ_TEST_PROTECTION_POLICY` and exercises the prepared bundled ACP runtime with a real enforcing provider. Use a policy allowing ordinary writes beneath the disposable profile; the test verifies that positive control before checking denials. Run:

```sh
cargo test -p buzz-agent-controller real_listeners_protect_future_run_controls_and_recover_worker_crashes -- --ignored --nocapture
```

The test uses two real ACP listeners and the production launch/supervisor functions, with a synthetic relay and ACP worker. It overrides only the resulting command's relay URL to a local plaintext fixture; saved records retain valid secure origins. Explicit gates hold A inside its sandbox before B's controls exist, check both directions of control-file protection, swap the source launcher before B's first task, kill B during a prompt, and verify successful recovery and subsequent work. OAuth/temp writes and paired supervisor cleanup are also checked. The controller start wiring has separate ordinary lifecycle tests. This does not attest real Goose, app UI, human acceptance, or non-macOS behavior.

The native host verifies executable availability and identity, but the provider is responsible for enforcing the supplied policy and every protected path. This contract requires a trusted native caller; plugin exposure is a separate layer.
