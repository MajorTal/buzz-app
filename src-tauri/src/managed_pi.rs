//! Pinned, app-owned Node and npm tools for Pi. No user-global installs.
use crate::harness_setup::HarnessSetup;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

// Old Buzz: desktop/src-tauri/src/commands/agent_discovery/managed_node.rs:8-43,
// :300-323, :362-424. Checksums are pinned to the official Node v24.18.0 tarballs.
const VERSION: &str = "v24.18.0";
const MAX_ARCHIVE: u64 = 90 * 1024 * 1024;
const PI: &str = "@earendil-works/pi-coding-agent";
const ADAPTER: &str = "git+https://github.com/salman1993/buzz-pi-acp.git#86b201e";
const NPM_FAILED: &str = "npm couldn't install Pi; see the install log. If your network blocks the public npm registry, set your mirror in ~/.npmrc or npm_config_registry, then try again, or use the commands below.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Artifact {
    platform: &'static str,
    filename: &'static str,
    sha256: &'static str,
}

fn artifact(os: &str, arch: &str) -> Option<Artifact> {
    let (platform, sha256) = match (os, arch) {
        ("macos", "aarch64") => (
            "darwin-arm64",
            "e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1",
        ),
        ("macos", "x86_64") => (
            "darwin-x64",
            "dfd0dbd3e721503434df7b7205e719f61b3a3a31b2bcf9729b8b91fea240f080",
        ),
        ("linux", "x86_64") => (
            "linux-x64",
            "783130984963db7ba9cbd01089eaf2c2efb055c7c1693c943174b967b3050cb8",
        ),
        ("linux", "aarch64") => (
            "linux-arm64",
            "6b4484c2190274175df9aa8f28e2d758a819cb1c1fe6ab481e2f95b463ab8508",
        ),
        _ => return None,
    };
    Some(Artifact {
        platform,
        filename: match platform {
            "darwin-arm64" => "node-v24.18.0-darwin-arm64.tar.gz",
            "darwin-x64" => "node-v24.18.0-darwin-x64.tar.gz",
            "linux-x64" => "node-v24.18.0-linux-x64.tar.gz",
            _ => "node-v24.18.0-linux-arm64.tar.gz",
        },
        sha256,
    })
}

fn refuse_linked_prefix(prefix: &Path) -> Result<(), String> {
    for path in [
        prefix.to_path_buf(),
        prefix.join("bin"),
        prefix.join("lib"),
        prefix.join("lib/node_modules"),
        prefix.join("lib/node_modules/@earendil-works"),
        prefix.join("lib/node_modules/@earendil-works/pi-coding-agent"),
        prefix.join("lib/node_modules/buzz-pi-acp"),
        prefix.join("cache"),
        prefix.join("etc"),
    ] {
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
                return Err("App-owned npm prefix contains a link or non-directory".into())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Could not inspect app-owned npm prefix".into()),
            _ => {}
        }
    }
    Ok(())
}

fn node_dir(app_data: &Path, spec: Artifact) -> PathBuf {
    app_data
        .join("runtimes/node")
        .join(VERSION)
        .join(spec.platform)
}

fn verified(archive: &[u8], spec: Artifact) -> Result<(), String> {
    if archive.len() as u64 > MAX_ARCHIVE || format!("{:x}", Sha256::digest(archive)) != spec.sha256
    {
        return Err("Managed Node archive checksum or size mismatch".into());
    }
    Ok(())
}

async fn download(spec: Artifact) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not prepare managed Node download")?;
    let url = format!("https://nodejs.org/dist/{VERSION}/{}", spec.filename);
    let mut response =
        client.get(url).send().await.map_err(|_| {
            "Could not download Node.js from nodejs.org; check your network or proxy"
        })?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|size| size > MAX_ARCHIVE)
    {
        return Err("Managed Node download was unavailable or too large".into());
    }
    let mut archive = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Managed Node download interrupted")?
    {
        if archive.len() as u64 + chunk.len() as u64 > MAX_ARCHIVE {
            return Err("Managed Node download exceeded size limit".into());
        }
        archive.extend_from_slice(&chunk);
    }
    verified(&archive, spec)?;
    Ok(archive)
}

fn scrub(
    command: &mut tokio::process::Command,
    home: &Path,
    node_bin: &Path,
    app_data: &Path,
) -> Result<(), String> {
    let path = std::env::join_paths([
        node_bin,
        Path::new("/usr/bin"),
        Path::new("/bin"),
        Path::new("/usr/sbin"),
        Path::new("/sbin"),
    ])
    .map_err(|_| "Invalid managed Node PATH")?;
    command.env_clear();
    // npm reads registry, auth, CA and proxy settings from ~/.npmrc (real HOME)
    // and from npm_config_* variables. Keep those so a mirror still works, but
    // never let them move the app-owned prefix, cache or global config.
    for (name, value) in std::env::vars_os() {
        let Some(key) = name.to_str().map(str::to_ascii_lowercase) else {
            continue;
        };
        if key.starts_with("npm_config_")
            && !matches!(
                key.as_str(),
                "npm_config_prefix" | "npm_config_cache" | "npm_config_globalconfig"
            )
        {
            command.env(name, value);
        }
    }
    for name in [
        "TMPDIR",
        "USER",
        "LOGNAME",
        "LANG",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "NODE_EXTRA_CA_CERTS",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "http_proxy",
        "https_proxy",
        "NO_PROXY",
        "no_proxy",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command
        .env("HOME", home)
        .env("PATH", path)
        .env("npm_config_cache", app_data.join("node-tools/cache"))
        .env("npm_config_prefix", app_data.join("node-tools"))
        .env(
            "npm_config_globalconfig",
            app_data.join("node-tools/etc/npmrc"),
        )
        .current_dir(home)
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .process_group(0);
    Ok(())
}

async fn run_step(
    setup: &HarnessSetup,
    command: &mut tokio::process::Command,
    log: &File,
    failure: &str,
) -> Result<(), String> {
    command
        .stdout(Stdio::from(
            log.try_clone().map_err(|_| "Could not copy install log")?,
        ))
        .stderr(Stdio::from(
            log.try_clone().map_err(|_| "Could not copy install log")?,
        ));
    let mut child = setup.spawn(|| command.spawn())?;
    let status = tokio::time::timeout(Duration::from_secs(300), child.child.wait())
        .await
        .map_err(|_| "Pi install step timed out")?
        .map_err(|_| "Pi install step could not finish")?;
    child.reaped = true;
    drop(child);
    if !status.success() {
        return Err(failure.into());
    }
    Ok(())
}

async fn install_node(
    setup: &HarnessSetup,
    app_data: &Path,
    home: &Path,
    log: &File,
    spec: Artifact,
) -> Result<PathBuf, String> {
    let node_dir = node_dir(app_data, spec);
    let node = node_dir.join("bin/node");
    let npm = node_dir.join("lib/node_modules/npm/bin/npm-cli.js");
    if node.is_file() && npm.is_file() {
        return Ok(node);
    }
    let archive = download(spec).await?;
    let root = app_data.join("runtimes/node");
    std::fs::create_dir_all(&root).map_err(|_| "Could not create managed Node directory")?;
    let stage = root.join(format!("{}.{}.tmp", VERSION, spec.platform));
    if stage.exists() {
        std::fs::remove_dir_all(&stage)
            .map_err(|_| "Could not remove stale Node staging directory")?;
    }
    std::fs::create_dir_all(&stage).map_err(|_| "Could not stage managed Node")?;
    let archive_path = stage.join("node.tar.gz");
    let result = async {
        std::fs::write(&archive_path, archive).map_err(|_| "Could not stage Node archive")?;
        let mut tar = tokio::process::Command::new("/usr/bin/tar");
        scrub(&mut tar, home, Path::new("/usr/bin"), app_data)?;
        tar.arg("-xzf")
            .arg(&archive_path)
            .arg("-C")
            .arg(&stage)
            .arg("--strip-components=1");
        run_step(
            setup,
            &mut tar,
            log,
            "Could not unpack managed Node; see the install log",
        )
        .await?;
        std::fs::remove_file(&archive_path).map_err(|_| "Could not remove Node archive")?;
        if !stage.join("bin/node").is_file()
            || !stage.join("lib/node_modules/npm/bin/npm-cli.js").is_file()
        {
            return Err("Managed Node archive was incomplete".into());
        }
        std::fs::create_dir_all(node_dir.parent().ok_or("Invalid Node path")?)
            .map_err(|_| "Could not create Node version directory")?;
        if node_dir.exists() {
            std::fs::remove_dir_all(&node_dir)
                .map_err(|_| "Could not replace incomplete Node runtime")?;
        }
        std::fs::rename(&stage, &node_dir).map_err(|_| "Could not activate managed Node")?;
        Ok(node)
    }
    .await;
    if result.is_err() {
        let _ = std::fs::remove_dir_all(stage);
    }
    result
}

fn npm_command(
    node: &Path,
    app_data: &Path,
    home: &Path,
    package: &str,
    install_links: bool,
) -> Result<tokio::process::Command, String> {
    let bin = node.parent().ok_or("Invalid managed Node path")?;
    let npm = bin
        .parent()
        .ok_or("Invalid managed Node path")?
        .join("lib/node_modules/npm/bin/npm-cli.js");
    let prefix = app_data.join("node-tools");
    let mut command = tokio::process::Command::new(node);
    scrub(&mut command, home, bin, app_data)?;
    command
        .arg(npm)
        .args(["install", "--global", "--prefix"])
        .arg(prefix);
    if install_links {
        command.arg("--install-links=true");
    }
    command.arg(package);
    Ok(command)
}

pub(crate) async fn install(
    setup: &HarnessSetup,
    app_data: &Path,
    log: File,
) -> Result<bool, String> {
    let home = PathBuf::from(std::env::var_os("HOME").ok_or("Pi install requires HOME")?);
    let spec = artifact(std::env::consts::OS, std::env::consts::ARCH)
        .ok_or("Managed Node is unavailable on this platform")?;
    let node = install_node(setup, app_data, &home, &log, spec).await?;
    let prefix = app_data.join("node-tools");
    refuse_linked_prefix(&prefix)?;
    std::fs::create_dir_all(&prefix).map_err(|_| "Could not create app-owned npm prefix")?;
    for (package, install_links) in [(PI, false), (ADAPTER, true)] {
        refuse_linked_prefix(&prefix)?;
        let mut command = npm_command(&node, app_data, &home, package, install_links)?;
        run_step(setup, &mut command, &log, NPM_FAILED).await?;
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pinned_artifacts_are_platform_specific_and_reject_unsupported_os() {
        for (os, arch, platform) in [
            ("macos", "aarch64", "darwin-arm64"),
            ("macos", "x86_64", "darwin-x64"),
            ("linux", "x86_64", "linux-x64"),
            ("linux", "aarch64", "linux-arm64"),
        ] {
            let spec = artifact(os, arch).unwrap();
            assert_eq!(spec.platform, platform);
            assert_eq!(spec.sha256.len(), 64);
            assert!(spec.filename.ends_with(&format!("{platform}.tar.gz")));
        }
        assert!(artifact("windows", "x86_64").is_none());
        assert!(artifact("linux", "riscv64").is_none());
    }
    #[test]
    fn mismatch_rejects_download_before_extraction() {
        assert!(verified(b"untrusted bytes", artifact("macos", "aarch64").unwrap()).is_err());
    }
    #[test]
    fn scrubbed_npm_environment_has_only_managed_node_and_system_tools() {
        let mut cmd = tokio::process::Command::new("/usr/bin/env");
        scrub(
            &mut cmd,
            Path::new("/temporary/home"),
            Path::new("/managed/node/bin"),
            Path::new("/app/data"),
        )
        .unwrap();
        let env: Vec<_> = cmd.as_std().get_envs().collect();
        let get = |name: &str| {
            env.iter()
                .find(|(key, _)| *key == name)
                .and_then(|(_, value)| *value)
        };
        assert_eq!(
            get("PATH"),
            Some(std::ffi::OsStr::new(
                "/managed/node/bin:/usr/bin:/bin:/usr/sbin:/sbin"
            ))
        );
        assert_eq!(get("HOME"), Some(std::ffi::OsStr::new("/temporary/home")));
        assert_eq!(
            get("npm_config_prefix"),
            Some(std::ffi::OsStr::new("/app/data/node-tools"))
        );
        if let Some(ca) = std::env::var_os("NODE_EXTRA_CA_CERTS") {
            assert_eq!(get("NODE_EXTRA_CA_CERTS"), Some(ca.as_os_str()));
        }
        assert!(env.iter().all(|(name, _)| *name != "BUZZ_PRIVATE_KEY"));
        assert_eq!(
            get("npm_config_globalconfig"),
            Some(std::ffi::OsStr::new("/app/data/node-tools/etc/npmrc"))
        );
    }
    #[test]
    fn npm_mirror_settings_pass_through_but_cannot_move_the_prefix() {
        // Process env is shared; use names no other test reads.
        unsafe {
            std::env::set_var("NPM_CONFIG_REGISTRY", "https://mirror.example/");
            std::env::set_var("npm_config_userconfig", "/home/me/.npmrc");
            std::env::set_var("NPM_CONFIG_PREFIX", "/usr/local");
            std::env::set_var("NPM_CONFIG_GLOBALCONFIG", "/etc/npmrc");
        }
        let mut cmd = tokio::process::Command::new("/usr/bin/env");
        scrub(
            &mut cmd,
            Path::new("/home/me"),
            Path::new("/managed/node/bin"),
            Path::new("/app/data"),
        )
        .unwrap();
        let env: std::collections::BTreeMap<_, _> = cmd
            .as_std()
            .get_envs()
            .filter_map(|(k, v)| Some((k.to_str()?.to_owned(), v?.to_str()?.to_owned())))
            .collect();
        assert_eq!(env["NPM_CONFIG_REGISTRY"], "https://mirror.example/");
        assert_eq!(env["npm_config_userconfig"], "/home/me/.npmrc");
        assert_eq!(env["HOME"], "/home/me");
        assert!(!env.contains_key("NPM_CONFIG_PREFIX"));
        assert!(!env.contains_key("NPM_CONFIG_GLOBALCONFIG"));
        assert_eq!(env["npm_config_prefix"], "/app/data/node-tools");
    }
    #[cfg(unix)]
    #[test]
    fn linked_npm_prefix_cannot_redirect_install_to_user_global_files() {
        let dir = tempfile::tempdir().unwrap();
        let prefix = dir.path().join("node-tools");
        let other = dir.path().join("other");
        std::fs::create_dir_all(&other).unwrap();
        std::os::unix::fs::symlink(&other, &prefix).unwrap();
        assert!(refuse_linked_prefix(&prefix).is_err());
        std::fs::remove_file(&prefix).unwrap();
        std::fs::create_dir_all(&prefix).unwrap();
        for destination in [
            "lib",
            "lib/node_modules",
            "lib/node_modules/@earendil-works",
            "lib/node_modules/@earendil-works/pi-coding-agent",
            "lib/node_modules/buzz-pi-acp",
            "etc",
        ] {
            let path = prefix.join(destination);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::os::unix::fs::symlink(&other, &path).unwrap();
            assert!(refuse_linked_prefix(&prefix).is_err(), "{destination}");
            std::fs::remove_file(path).unwrap();
        }
        assert!(refuse_linked_prefix(&prefix).is_ok());
    }
    #[test]
    fn npm_installs_only_the_two_approved_packages_into_the_app_owned_prefix() {
        let node = Path::new("/app/data/runtimes/node/v24.18.0/darwin-arm64/bin/node");
        let pi = npm_command(
            node,
            Path::new("/app/data"),
            Path::new("/temporary/home"),
            PI,
            false,
        )
        .unwrap();
        let adapter = npm_command(
            node,
            Path::new("/app/data"),
            Path::new("/temporary/home"),
            ADAPTER,
            true,
        )
        .unwrap();
        let args = |cmd: &tokio::process::Command| {
            cmd.as_std()
                .get_args()
                .map(|a| a.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            args(&pi),
            [
                "/app/data/runtimes/node/v24.18.0/darwin-arm64/lib/node_modules/npm/bin/npm-cli.js",
                "install",
                "--global",
                "--prefix",
                "/app/data/node-tools",
                PI
            ]
        );
        assert_eq!(
            args(&adapter),
            [
                "/app/data/runtimes/node/v24.18.0/darwin-arm64/lib/node_modules/npm/bin/npm-cli.js",
                "install",
                "--global",
                "--prefix",
                "/app/data/node-tools",
                "--install-links=true",
                ADAPTER
            ]
        );
    }
}
