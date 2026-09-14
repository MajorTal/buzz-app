//! Installation and settings never execute plugin code. Both desktop and CLI use this crate.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub mod imports;

pub type Result<T> = std::result::Result<T, String>;
const LIMIT: u64 = 8 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub api_version: u32,
}
impl Manifest {
    pub fn validate(&self) -> Result<()> {
        valid_id(&self.id)?;
        if self.name.trim().is_empty() || self.name.len() > 80 {
            return Err("Name must contain 1–80 bytes of text".into());
        }
        if self.api_version != 1 {
            return Err("Only page plugin API version 1 is supported".into());
        }
        Ok(())
    }
}
pub fn valid_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 80
        || !id.as_bytes()[0].is_ascii_lowercase()
        || !id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'.' || c == b'-')
        || id.split(['.', '-']).any(str::is_empty)
    {
        return Err("Invalid identifier (use lowercase letters, digits, dots or hyphens)".into());
    }
    Ok(())
}
pub fn bundled_manifests() -> Vec<Manifest> {
    vec![
        serde_json::from_str(include_str!(
            "../../../src/bundled/agent-activity/manifest.json"
        ))
        .expect("agent activity manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/terminal/manifest.json"))
            .expect("terminal manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/profiles/manifest.json"))
            .expect("valid bundled Profiles manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/mentions/manifest.json"))
            .expect("mentions manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/emoji/manifest.json"))
            .expect("emoji manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/channels/manifest.json"))
            .expect("channels manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/github/manifest.json"))
            .expect("github manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/bestie/manifest.json"))
            .expect("bestie manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/projects/manifest.json"))
            .expect("projects manifest"),
        serde_json::from_str(include_str!("../../../src/bundled/agents/manifest.json"))
            .expect("agents manifest"),
    ]
}
fn is_bundled(id: &str) -> bool {
    bundled_manifests().iter().any(|manifest| manifest.id == id)
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Installed {
    manifest: Manifest,
    current: String,
    previous: Option<String>,
    enabled: bool,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Registry {
    version: u32,
    bundled_enabled: bool,
    #[serde(default)]
    bundled_overrides: BTreeMap<String, bool>,
    installed: BTreeMap<String, Installed>,
}
impl Default for Registry {
    fn default() -> Self {
        Self {
            version: 1,
            bundled_enabled: true,
            bundled_overrides: BTreeMap::new(),
            installed: BTreeMap::new(),
        }
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Artifact {
    manifest: Manifest,
    code: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub manifest: Manifest,
    pub source: &'static str,
    pub enabled: bool,
    pub revision: String,
    pub previous: Option<String>,
    pub error: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub profile: String,
    pub location: String,
    pub plugins: Vec<PluginInfo>,
}
#[derive(serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum InstallationResult {
    Ready {
        catalog: Catalog,
        #[serde(rename = "externalPluginsPaused")]
        external_plugins_paused: bool,
    },
    Recovery {
        reason: String,
        #[serde(rename = "canReset")]
        can_reset: bool,
    },
}
#[derive(Clone)]
pub struct Manager {
    root: PathBuf,
    profile: String,
    safe_mode: bool,
}
impl Manager {
    pub fn open(home: Option<PathBuf>, profile: &str, safe_mode: bool) -> Result<Self> {
        valid_id(profile)?;
        let home = home
            .or_else(|| std::env::var_os("BUZZODZ_HOME").map(PathBuf::from))
            .or_else(|| dirs::data_dir().map(|p| p.join("dev.local.buzz.foundation")))
            .ok_or("Cannot determine application data directory; set BUZZODZ_HOME")?;
        if !home.is_absolute() {
            return Err("Plugin home must be an absolute path".into());
        }
        Ok(Self {
            root: home.join("profiles").join(profile),
            profile: profile.into(),
            safe_mode,
        })
    }
    pub fn from_env() -> Result<Self> {
        Self::open(
            None,
            &std::env::var("BUZZODZ_PROFILE").unwrap_or_else(|_| "default".into()),
            std::env::var("BUZZODZ_SAFE_MODE").as_deref() == Ok("1"),
        )
    }
    fn lock(&self) -> Result<File> {
        fs::create_dir_all(&self.root).map_err(err)?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.root.join("registry.lock"))
            .map_err(err)?;
        file.lock().map_err(err)?;
        Ok(file)
    }
    fn read(&self) -> Result<Registry> {
        let path = self.root.join("registry.json");
        let file = match File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Registry::default())
            }
            Err(error) => return Err(err(error)),
        };
        let text = read_file_limited(file)?;
        let r: Registry = serde_json::from_str(&text).map_err(err)?;
        if r.version != 1 {
            return Err(
                "Unsupported settings version; use a compatible Buzz or recover settings".into(),
            );
        }
        for (id, p) in &r.installed {
            p.manifest.validate()?;
            if *id != p.manifest.id || is_bundled(id) {
                return Err("Invalid installed plugin identity".into());
            }
            valid_hash(&p.current)?;
            if let Some(h) = &p.previous {
                valid_hash(h)?;
            }
        }
        Ok(r)
    }
    fn save(&self, r: &Registry) -> Result<()> {
        atomic_write(
            &self.root.join("registry.json"),
            &serde_json::to_vec_pretty(r).map_err(err)?,
        )
    }
    fn artifact_path(&self, id: &str, revision: &str) -> PathBuf {
        self.root
            .join("artifacts")
            .join(id)
            .join(format!("{revision}.json"))
    }
    fn artifact(&self, id: &str, revision: &str) -> Result<Artifact> {
        valid_id(id)?;
        valid_hash(revision)?;
        let text = read_limited(&self.artifact_path(id, revision))?;
        if hash(text.as_bytes()) != revision {
            return Err(
                "Installed artifact failed its integrity check; reinstall or roll back".into(),
            );
        }
        let a: Artifact = serde_json::from_str(&text).map_err(err)?;
        a.manifest.validate()?;
        if a.manifest.id != id {
            return Err("Artifact identity mismatch".into());
        }
        Ok(a)
    }
    pub fn external_plugins_paused(&self) -> bool {
        self.safe_mode
    }
    pub fn catalog(&self) -> Result<Catalog> {
        let registry = self.lock().and_then(|_lock| self.read())?;
        let mut plugins: Vec<PluginInfo> = bundled_manifests()
            .into_iter()
            .map(|manifest| {
                let enabled = registry
                    .bundled_overrides
                    .get(&manifest.id)
                    .copied()
                    .unwrap_or(true);
                PluginInfo {
                    manifest,
                    source: "bundled",
                    enabled,
                    revision: "bundled".into(),
                    previous: None,
                    error: None,
                }
            })
            .collect();
        for (id, p) in registry.installed {
            // Catalog polling stays cheap; verify content hashes before enabling/loading.
            let error = fs::metadata(self.artifact_path(&id, &p.current))
                .map_err(err)
                .err();
            plugins.push(PluginInfo {
                manifest: p.manifest,
                source: "external",
                enabled: p.enabled,
                revision: p.current,
                previous: p.previous,
                error,
            });
        }
        Ok(Catalog {
            profile: self.profile.clone(),
            location: self.root.display().to_string(),
            plugins,
        })
    }
    pub fn install(&self, directory: &Path) -> Result<Catalog> {
        self.install_artifact(&prepare_artifact(directory)?)
    }
    fn install_artifact(&self, bytes: &[u8]) -> Result<Catalog> {
        let Artifact { manifest, .. } = serde_json::from_slice(bytes).map_err(err)?;
        let revision = hash(bytes);
        {
            let _lock = self.lock()?;
            let mut registry = self.read()?;
            let old = registry.installed.get(&manifest.id);
            let previous = old.and_then(|p| {
                if p.current == revision {
                    p.previous.clone()
                } else {
                    Some(p.current.clone())
                }
            });
            let enabled = old.is_some_and(|p| p.enabled);
            atomic_write(&self.artifact_path(&manifest.id, &revision), bytes)?;
            registry.installed.insert(
                manifest.id.clone(),
                Installed {
                    manifest,
                    current: revision,
                    previous,
                    enabled,
                },
            );
            self.save(&registry)?;
        }
        self.catalog()
    }
    pub fn change(&self, action: &str, id: &str) -> Result<Catalog> {
        valid_id(id)?;
        {
            let _lock = self.lock()?;
            let mut registry = self.read()?;
            if is_bundled(id) {
                match action {
                    "enable" => {
                        registry.bundled_overrides.insert(id.into(), true);
                    }
                    "disable" => {
                        registry.bundled_overrides.insert(id.into(), false);
                    }
                    _ => return Err("Bundled pages can only be enabled or disabled".into()),
                }
            } else {
                let p = registry
                    .installed
                    .get_mut(id)
                    .ok_or("Plugin is not installed")?;
                match action {
                    "enable" => {
                        self.artifact(id, &p.current)?;
                        p.enabled = true;
                    }
                    "disable" => p.enabled = false,
                    "remove" => {
                        registry.installed.remove(id);
                    }
                    "rollback" => {
                        let previous = p.previous.clone().ok_or("No previous revision")?;
                        let a = self.artifact(id, &previous)?;
                        p.previous = Some(p.current.clone());
                        p.current = previous;
                        p.manifest = a.manifest;
                    }
                    _ => return Err("Unknown management action".into()),
                }
            }
            self.save(&registry)?;
            if action == "remove" {
                // Commit removal first. A cleanup failure cannot re-enable the plugin.
                let path = self.root.join("artifacts").join(id);
                if path.exists() {
                    fs::remove_dir_all(path)
                        .map_err(|e| format!("Plugin removed, but artifact cleanup failed: {e}"))?;
                }
            }
        }
        self.catalog()
    }
    pub fn module(&self, id: &str, revision: &str) -> Result<String> {
        if self.safe_mode {
            return Err("External plugins are disabled in safe mode".into());
        }
        let _lock = self.lock()?;
        let r = self.read()?;
        let p = r.installed.get(id).ok_or("Plugin is not installed")?;
        if !p.enabled || p.current != revision {
            return Err("Plugin was disabled or updated; refresh the catalog".into());
        }
        Ok(self.artifact(id, revision)?.code)
    }
    pub fn recover(&self) -> Result<Catalog> {
        {
            let _lock = self.lock()?;
            let path = self.root.join("registry.json");
            if path.exists() {
                let mut backup = tempfile::Builder::new()
                    .prefix("registry-backup-")
                    .suffix(".json")
                    .tempfile_in(&self.root)
                    .map_err(err)?;
                std::io::copy(&mut File::open(&path).map_err(err)?, &mut backup).map_err(err)?;
                backup.as_file().sync_all().map_err(err)?;
                backup.keep().map_err(err)?;
            }
            self.save(&Registry::default())?;
        }
        self.catalog()
    }
}
fn prepare_artifact(directory: &Path) -> Result<Vec<u8>> {
    artifact_from_text(
        &read_limited(&directory.join("manifest.json"))?,
        read_limited(&directory.join("plugin.js"))?,
    )
}
fn artifact_from_text(manifest: &str, code: String) -> Result<Vec<u8>> {
    let manifest: Manifest = serde_json::from_str(manifest).map_err(err)?;
    manifest.validate()?;
    if is_bundled(&manifest.id) {
        return Err("Cannot replace a bundled plugin".into());
    }
    if code.trim().is_empty() {
        return Err("Plugin module is empty".into());
    }
    let bytes = serde_json::to_vec(&Artifact { manifest, code }).map_err(err)?;
    if bytes.len() as u64 > LIMIT {
        return Err("Plugin artifact exceeds 8 MiB".into());
    }
    Ok(bytes)
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn valid_hash(s: &str) -> Result<()> {
    if s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        Ok(())
    } else {
        Err("Invalid artifact revision".into())
    }
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn read_limited(path: &Path) -> Result<String> {
    if !fs::symlink_metadata(path)
        .map_err(err)?
        .file_type()
        .is_file()
    {
        return Err("Plugin files must be regular files, not symbolic links".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(err)?;
    if !file.metadata().map_err(err)?.is_file() {
        return Err("Plugin files must be regular files".into());
    }
    read_file_limited(file)
}
fn read_file_limited(file: File) -> Result<String> {
    let mut text = String::new();
    file.take(LIMIT + 1)
        .read_to_string(&mut text)
        .map_err(err)?;
    if text.len() as u64 > LIMIT {
        return Err("File exceeds 8 MiB".into());
    }
    Ok(text)
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or("Missing parent directory")?;
    fs::create_dir_all(parent).map_err(err)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(err)?;
    temp.write_all(bytes).map_err(err)?;
    temp.as_file().sync_all().map_err(err)?;
    temp.persist(path).map_err(err)?;
    #[cfg(unix)]
    File::open(parent).map_err(err)?.sync_all().map_err(err)?;
    Ok(())
}
