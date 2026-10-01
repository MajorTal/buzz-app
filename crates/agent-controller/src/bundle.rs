use crate::Result;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
struct Source {
    revision: String,
    tools: Vec<String>,
    goose: GooseSource,
}
#[derive(Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct GooseSource {
    repository: String,
    revision: String,
    profile: String,
    features: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    version: u32,
    revision: String,
    target: String,
    files: BTreeMap<String, String>,
    goose: GooseSource,
}
/// App resource provenance/integrity check, not a defense against a same-user
/// attacker able to replace the application itself. No PATH/old-app fallback.
pub struct RuntimeBundle {
    pub(crate) directory: PathBuf,
    files: BTreeMap<String, String>,
}
impl RuntimeBundle {
    pub fn new(directory: PathBuf) -> Result<Self> {
        Self::load(directory, verify_signed_resources)
    }

    fn load(
        directory: PathBuf,
        verify_signature: impl FnOnce(&Path) -> Result<()>,
    ) -> Result<Self> {
        if !directory.is_absolute() {
            return Err("Runtime bundle path must be absolute".into());
        }
        regular_directory(&directory)?;
        let path = directory.join("manifest.json");
        let meta = std::fs::symlink_metadata(&path)
            .map_err(|_| "Agent runtime is not packaged; build its resources first")?;
        if !meta.is_file() || meta.len() > 16384 {
            return Err("Runtime manifest is invalid".into());
        }
        let manifest: Manifest = serde_json::from_slice(
            &std::fs::read(path).map_err(|_| "Could not read runtime manifest")?,
        )
        .map_err(|_| "Runtime manifest is invalid")?;
        let source: Source =
            serde_json::from_str(include_str!("../../../runtime/agent-runtime.json"))
                .map_err(|_| "Runtime source specification is invalid")?;
        if manifest.version != 2
            || manifest.revision != source.revision
            || manifest.goose != source.goose
            || manifest.target != env!("BUZZ_RUNTIME_TARGET")
            || manifest.files.len() != source.tools.len()
        {
            return Err("Runtime target/revision does not match this app".into());
        }
        let mut bundle = Self {
            directory,
            files: manifest.files,
        };
        let mut observed = BTreeMap::new();
        for name in source.tools {
            let filename = filename(&name);
            if !bundle.files.contains_key(&filename) {
                return Err("Required runtime tool is absent from the manifest".into());
            }
            observed.insert(
                filename.clone(),
                executable_hash(&bundle.directory.join(filename))?,
            );
        }
        if observed != bundle.files {
            verify_signature(&bundle.directory)?;
        }
        // Keep final bytes in memory so every launch still detects later changes.
        bundle.files = observed;
        Ok(bundle)
    }
    /// Configured path for display only. Does not inspect files or authorize launch.
    pub(crate) fn display_path(&self, name: &str) -> Option<PathBuf> {
        let filename = filename(name);
        self.files
            .contains_key(&filename)
            .then(|| self.directory.join(filename))
    }
    pub(crate) fn executable(&self, name: &str) -> Result<PathBuf> {
        let filename = filename(name);
        let expected = self
            .files
            .get(&filename)
            .ok_or("Required runtime tool is absent from the manifest")?;
        let path = self.directory.join(filename);
        if executable_hash(&path)? != *expected {
            return Err(INTEGRITY_ERROR.into());
        }
        Ok(path)
    }
}
const INTEGRITY_ERROR: &str =
    "Runtime executable failed its integrity check; rebuild the app resources";

fn filename(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.into()
    }
}

fn executable_hash(path: &Path) -> Result<String> {
    let meta =
        std::fs::symlink_metadata(path).map_err(|_| "Required runtime executable is missing")?;
    if !meta.is_file() {
        return Err("Runtime executable must be a regular file, not a link".into());
    }
    crate::runtime::executable(path)?;
    let mut file = std::fs::File::open(path).map_err(|_| "Could not read runtime executable")?;
    let mut digest = Sha256::new();
    let mut bytes = [0u8; 65536];
    loop {
        let n = file
            .read(&mut bytes)
            .map_err(|_| "Could not verify runtime executable")?;
        if n == 0 {
            break;
        }
        digest.update(&bytes[..n]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
fn verify_signed_resources(directory: &Path) -> Result<()> {
    let executable = std::env::current_exe().map_err(|_| INTEGRITY_ERROR)?;
    macos::verify(directory, &executable, macos::REQUIREMENT)
}

fn regular_directory(path: &Path) -> Result<()> {
    let meta = std::fs::symlink_metadata(path)
        .map_err(|_| "Agent runtime resource directory is missing")?;
    if meta.is_dir() && !meta.file_type().is_symlink() {
        Ok(())
    } else {
        Err("Agent runtime resources cannot be a link".into())
    }
}

#[cfg(not(target_os = "macos"))]
fn verify_signed_resources(_: &Path) -> Result<()> {
    Err(INTEGRITY_ERROR.into())
}
