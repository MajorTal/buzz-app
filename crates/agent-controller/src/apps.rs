//! Apps a local agent reaches as MCP tools through the app's `buzz-mcp-hub`.
//!
//! One file per agent identity, `<controller root>/apps/<pubkey>.json`, written by
//! the owner (Agents → Edit) and by the agent itself through the hub's
//! `connect_app` tool. Each run's private temporary directory carries a launch
//! file naming the verified `buzz-dev-mcp` and that apps file; the hub reads
//! nothing else from the controller. Only run402 tenant hosts are accepted: the
//! hub signs every request as the agent, so the set of hosts it signs for stays
//! narrow and explicit.
use crate::Result;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// The hub's executable name, beside the app's own executable.
pub const HUB: &str = "buzz-mcp-hub";
/// Launch file the controller writes into each run's private temporary directory.
pub const LAUNCH_FILE: &str = "buzz-mcp-hub.json";
pub const MAX_APPS: usize = 8;
const MAX_FILE_BYTES: u64 = 64 * 1024;
const TENANT_DOMAINS: [&str; 2] = ["run402.com", "run402.app"];

/// What the hub needs from the controller for one run.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Launch {
    pub dev_mcp: PathBuf,
    pub apps: PathBuf,
    pub pubkey: String,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AddedBy {
    Owner,
    Agent,
}

/// One connected app: a short tool prefix and its MCP endpoint.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct App {
    pub name: String,
    pub url: String,
    pub added_by: AddedBy,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AppsFile {
    version: u32,
    apps: Vec<App>,
}

/// `<root>/apps/<pubkey>.json`, creating the private directory.
pub fn apps_path(root: &Path, pubkey: &str) -> Result<PathBuf> {
    if !crate::config::canonical_key(pubkey) {
        return Err("Invalid agent public key".into());
    }
    if !root.is_absolute() {
        return Err("Agent app storage must be absolute".into());
    }
    let dir = root.join("apps");
    crate::connection::private_directory(&dir)?;
    Ok(dir.join(format!("{pubkey}.json")))
}

/// A tool prefix: lowercase letter, then up to 23 lowercase letters, digits or `-`.
pub fn validate_name(name: &str) -> Result<()> {
    let mut bytes = name.bytes();
    let ok = name.len() <= 24
        && bytes.next().is_some_and(|b| b.is_ascii_lowercase())
        && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if ok {
        Ok(())
    } else {
        Err(
            "App name must start with a letter and use only a-z, 0-9 and -, at most 24 characters"
                .into(),
        )
    }
}

/// Canonical `https://<label>.run402.(com|app)/<path>` or an error naming the rule.
pub fn validate_url(raw: &str) -> Result<String> {
    let invalid = || {
        "App URL must be https://<app>.run402.com/... or https://<app>.run402.app/... with no port, query or credentials".to_string()
    };
    if raw.len() > 512 || raw.trim() != raw || raw.chars().any(char::is_control) {
        return Err(invalid());
    }
    let url = url::Url::parse(raw).map_err(|_| invalid())?;
    let host = url.host_str().ok_or_else(invalid)?;
    let tenant = TENANT_DOMAINS.iter().any(|domain| {
        host.strip_suffix(domain)
            .and_then(|label| label.strip_suffix('.'))
            .is_some_and(|label| !label.is_empty() && !label.contains('.'))
    });
    if url.scheme() != "https"
        || !tenant
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    Ok(url.into())
}

/// The app's host label, made a valid name: `buzz-todo.run402.com` → `buzz-todo`.
pub fn default_name(url: &str) -> String {
    let label = url::Url::parse(url)
        .ok()
        .and_then(|u| {
            u.host_str()
                .map(|h| h.split('.').next().unwrap_or("").to_owned())
        })
        .unwrap_or_default();
    let mut name: String = label
        .chars()
        .map(|c| c.to_ascii_lowercase())
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(24)
        .collect();
    if !name.starts_with(|c: char| c.is_ascii_lowercase()) {
        name = format!("app-{name}").chars().take(24).collect();
    }
    name
}

/// The saved apps; a missing file is an empty list.
pub fn read(path: &Path) -> Result<Vec<App>> {
    let bytes = match std::fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("Could not read the agent's apps".into()),
        Ok(meta) if !meta.is_file() || meta.len() > MAX_FILE_BYTES => {
            return Err("The agent's apps file is invalid".into())
        }
        Ok(_) => std::fs::read(path).map_err(|_| "Could not read the agent's apps")?,
    };
    let file: AppsFile =
        serde_json::from_slice(&bytes).map_err(|_| "The agent's apps file is invalid")?;
    if file.version != 1 || file.apps.len() > MAX_APPS {
        return Err("The agent's apps file is invalid".into());
    }
    for app in &file.apps {
        validate_name(&app.name)?;
        if validate_url(&app.url)? != app.url {
            return Err("The agent's apps file is invalid".into());
        }
    }
    Ok(file.apps)
}

/// Connect `url` as `name`. Reconnecting the same URL under the same name is a
/// no-op; a name or URL already used by a different entry is refused.
pub fn add(path: &Path, name: &str, url: &str, added_by: AddedBy) -> Result<Vec<App>> {
    validate_name(name)?;
    let url = validate_url(url)?;
    locked(path, || {
        let mut apps = read(path)?;
        if let Some(existing) = apps.iter().find(|a| a.name == name || a.url == url) {
            if existing.name == name && existing.url == url {
                return Ok(apps);
            }
            return Err(if existing.name == name {
                format!(
                    "An app named {name} is already connected to {}",
                    existing.url
                )
            } else {
                format!("{url} is already connected as {}", existing.name)
            });
        }
        if apps.len() >= MAX_APPS {
            return Err(format!("At most {MAX_APPS} apps can be connected"));
        }
        apps.push(App {
            name: name.into(),
            url,
            added_by,
        });
        write(path, &apps)?;
        Ok(apps)
    })
}

/// Disconnect `name`; disconnecting an absent name succeeds for retry.
pub fn remove(path: &Path, name: &str) -> Result<Vec<App>> {
    locked(path, || {
        let mut apps = read(path)?;
        let before = apps.len();
        apps.retain(|a| a.name != name);
        if apps.len() != before {
            write(path, &apps)?;
        }
        Ok(apps)
    })
}

fn write(path: &Path, apps: &[App]) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(&AppsFile {
        version: 1,
        apps: apps.to_vec(),
    })
    .map_err(|_| "Could not encode the agent's apps")?;
    crate::store::atomic_write(path, &bytes)
}

/// Serialize read-modify-write across the app and every running hub session.
/// A lock left by a crashed writer is broken after 30 seconds.
fn locked<T>(path: &Path, f: impl FnOnce() -> Result<T>) -> Result<T> {
    let lock = path.with_extension("lock");
    let mut attempts = 0;
    loop {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock)
        {
            Ok(_) => break,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let stale = std::fs::metadata(&lock)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| SystemTime::now().duration_since(t).ok())
                    .is_some_and(|age| age > Duration::from_secs(30));
                if stale {
                    let _ = std::fs::remove_file(&lock);
                    continue;
                }
                attempts += 1;
                if attempts > 100 {
                    return Err("The agent's apps are being changed elsewhere; try again".into());
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return Err("Could not lock the agent's apps".into()),
        }
    }
    let result = f();
    let _ = std::fs::remove_file(&lock);
    result
}

/// Write the hub's launch file into a run's private temporary directory.
pub fn write_launch(run_dir: &Path, launch: &Launch) -> Result<()> {
    let bytes = serde_json::to_vec(launch).map_err(|_| "Could not encode the hub launch")?;
    crate::store::atomic_write(&run_dir.join(LAUNCH_FILE), &bytes)
}

/// Read the launch file from the hub's temporary directory.
pub fn read_launch(run_dir: &Path) -> Result<Launch> {
    let path = run_dir.join(LAUNCH_FILE);
    let meta = std::fs::symlink_metadata(&path).map_err(|_| "Hub launch file is missing")?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return Err("Hub launch file is invalid".into());
    }
    let launch: Launch = serde_json::from_slice(
        &std::fs::read(&path).map_err(|_| "Could not read the hub launch file")?,
    )
    .map_err(|_| "Hub launch file is invalid")?;
    if !launch.dev_mcp.is_absolute()
        || !launch.apps.is_absolute()
        || !crate::config::canonical_key(&launch.pubkey)
    {
        return Err("Hub launch file is invalid".into());
    }
    Ok(launch)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";

    #[test]
    fn urls_are_limited_to_run402_tenant_hosts() {
        assert_eq!(
            validate_url("https://buzz-todo.run402.com/api/mcp").unwrap(),
            "https://buzz-todo.run402.com/api/mcp"
        );
        assert!(validate_url("https://todo.run402.app/_run402/mcp").is_ok());
        for bad in [
            "http://buzz-todo.run402.com/api/mcp",
            "https://run402.com/api/mcp",
            "https://a.b.run402.com/api/mcp",
            "https://evilrun402.com/api/mcp",
            "https://run402.com.evil.example/api/mcp",
            "https://buzz-todo.run402.com:8443/api/mcp",
            "https://user@buzz-todo.run402.com/api/mcp",
            "https://buzz-todo.run402.com/api/mcp?x=1",
            "https://buzz-todo.run402.com/api/mcp#x",
            " https://buzz-todo.run402.com/api/mcp",
        ] {
            assert!(validate_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn names_are_tool_prefixes() {
        assert!(validate_name("todo").is_ok());
        assert!(validate_name("buzz-todo2").is_ok());
        for bad in ["", "Todo", "2do", "to_do", "to.do", &"a".repeat(25)] {
            assert!(validate_name(bad).is_err(), "{bad}");
        }
        assert_eq!(
            default_name("https://buzz-todo.run402.com/api/mcp"),
            "buzz-todo"
        );
        assert_eq!(default_name("https://9lives.run402.app/mcp"), "app-9lives");
        assert!(validate_name(&default_name("https://9lives.run402.app/mcp")).is_ok());
    }

    #[test]
    fn add_and_remove_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = apps_path(dir.path(), KEY).unwrap();
        assert_eq!(read(&path).unwrap(), vec![]);
        let url = "https://buzz-todo.run402.com/api/mcp";
        let apps = add(&path, "todo", url, AddedBy::Agent).unwrap();
        assert_eq!(apps.len(), 1);
        // Idempotent for the same pair; conflicting reuse is refused.
        assert_eq!(add(&path, "todo", url, AddedBy::Owner).unwrap(), apps);
        assert!(add(
            &path,
            "todo",
            "https://other.run402.com/mcp",
            AddedBy::Owner
        )
        .unwrap_err()
        .contains("already connected"));
        assert!(add(&path, "list", url, AddedBy::Owner)
            .unwrap_err()
            .contains("already connected as todo"));
        assert_eq!(read(&path).unwrap(), apps);
        assert_eq!(remove(&path, "todo").unwrap(), vec![]);
        assert_eq!(remove(&path, "todo").unwrap(), vec![]);
        assert!(!path.with_extension("lock").exists());
    }

    #[test]
    fn caps_and_rejects_tampered_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = apps_path(dir.path(), KEY).unwrap();
        for i in 0..MAX_APPS {
            add(
                &path,
                &format!("app{i}"),
                &format!("https://app{i}.run402.com/mcp"),
                AddedBy::Owner,
            )
            .unwrap();
        }
        assert!(add(&path, "more", "https://more.run402.com/mcp", AddedBy::Owner).is_err());
        std::fs::write(
            &path,
            r#"{"version":1,"apps":[{"name":"x","url":"https://evil.example/mcp","added_by":"agent"}]}"#,
        )
        .unwrap();
        assert!(read(&path).is_err());
        assert!(apps_path(dir.path(), "not-a-key").is_err());
    }

    #[test]
    fn a_stale_lock_is_broken() {
        let dir = tempfile::tempdir().unwrap();
        let path = apps_path(dir.path(), KEY).unwrap();
        let lock = path.with_extension("lock");
        std::fs::write(&lock, b"").unwrap();
        let old = SystemTime::now() - Duration::from_secs(60);
        std::fs::File::options()
            .write(true)
            .open(&lock)
            .unwrap()
            .set_modified(old)
            .unwrap();
        add(&path, "todo", "https://todo.run402.com/mcp", AddedBy::Owner).unwrap();
    }

    #[test]
    fn launch_round_trips_and_requires_absolute_paths() {
        let dir = tempfile::tempdir().unwrap();
        let launch = Launch {
            dev_mcp: dir.path().join("buzz-dev-mcp"),
            apps: dir.path().join("apps.json"),
            pubkey: KEY.into(),
        };
        write_launch(dir.path(), &launch).unwrap();
        assert_eq!(read_launch(dir.path()).unwrap(), launch);
        write_launch(
            dir.path(),
            &Launch {
                dev_mcp: "relative".into(),
                ..launch
            },
        )
        .unwrap();
        assert!(read_launch(dir.path()).is_err());
    }
}
