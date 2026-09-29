# Desktop test releases

The **Desktop previews** workflow builds and signs Apple Silicon test builds from
`main`. It publishes a DMG and `SHA256SUMS` as a GitHub prerelease, tagged
`v<app-version>-preview.<run-number>.<attempt>` at the built commit.

Runs are scheduled at **00:17, 06:17, 12:17, and 18:17 UTC**. To start one manually:

```sh
gh workflow run release.yml --repo block/buzz-app --ref main
```

These builds use `macos-latest` and the repository's pinned toolchain. They do not
generate Tauri updater artifacts or upload to the legacy `block/buzz` updater.

## Prerequisites

Deploy [the signing infrastructure](https://github.com/squareup/tf-mobuild-workers/pull/1398)
and set these repository Actions secrets:

- `OSX_CODESIGN_ROLE`: ARN of `block-buzz-app-codesign-role`.
- `CODESIGN_S3_BUCKET`: `block-buzz-app-artifacts-bucket-<environment>`.

The manifest records hashes before signing. Packaged macOS apps accept changed
hashes only after verifying their enclosing app's resource seal and Block Developer
ID signature. The app retains the signed files' hashes in memory and checks them
before each launch. Development builds and other platforms still require the
manifest hashes to match. The release workflow verifies the signed seal,
notarization, and manifest identity before publishing.

## Windows and Linux installer candidates

The same **Desktop previews** workflow has a manual `candidates` switch. It builds
unsigned Windows x64 NSIS `.exe` and Ubuntu 24.04 x64 `.deb`/AppImage artifacts,
without running macOS signing or the release publisher:

```sh
gh workflow run release.yml --repo block/buzz-app \
  --ref <candidate-branch> -f candidates=true
```

Scheduled runs and dispatches without this switch retain the existing macOS
publication path. Candidates use the same preview version, source commit, pinned
runtime revision and five-tool manifest; they never use legacy Buzz's sidecars,
updater feed, application identifier, or signing secrets. The workflow records
`SOURCE_COMMIT` and checksums over final installer bytes. Download the
`windows-x64-candidate` and `linux-x64-candidates` artifacts from that Actions run
within seven days. These are **ready to try only after their build and payload
checks pass**, not accepted releases.

Windows uses the repository's Rust, Node and pnpm pins on the hosted MSVC runner
because Hermit does not run there. NSIS retains Tauri's current-user install and
WebView2 download-bootstrapper defaults (network needed if WebView2 is absent).
The job silently installs into a disposable runner directory and verifies the
installed runtime manifest and each tool's hash, without launching the app.

Linux reuses old Buzz's Ubuntu 24.04 recipe and guarded Wayland/GStreamer AppImage
repair from `block/buzz` tag `desktop-v0.5.25`. Repacking tools and the type2 runtime
are checksum-pinned. Resource binaries must retain their manifest hashes; the
repair restores the verified original tools after linuxdeploy rewrites ELF RPATHs,
then the workflow verifies both extracted package payloads after repacking.
Compatibility guards fail rather than silently omitting a fix.
AppImage still relies on host desktop/media libraries; this is not a promise of
universal distro compatibility. Neither candidate job writes shared build caches.

### Acceptance still required

Use disposable Windows 11 and Ubuntu 24.04 GNOME accounts with throwaway keys.
Do not replace an everyday machine's `buzz://` handler without agreement.

1. Install and launch without a developer toolchain; respect Windows security
   policy for unsigned apps. Linux needs a working Secret Service desktop session.
2. Create/import identity, quit and relaunch with the same key. Check unavailable
   storage fails safely. Join the intended community, send/receive and reconnect.
3. Check cold/warm `buzz://` links, install a newer preview over the previous one,
   verify identity/settings survive, and record uninstall/retained-data behavior.
4. Have a human repeat install → messaging → restart before accepting the build.

Two Windows native failures were last observed at `a68b39d6` (legacy-import path
separator assertion and model-auth recovery). Re-run the existing manual Windows
CI lane on the candidate and diagnose any surviving failures separately from
installer success. The packaging jobs do not waive them or enable local-agent
hosting. Builderlab/NIP-FI admission remains a separate product limitation.
There is no Windows/Linux publication or auto-update in this first candidate
slice; accepted artifact publication follows native acceptance.
