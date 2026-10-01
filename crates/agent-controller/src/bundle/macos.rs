use super::{Result, INTEGRITY_ERROR};
use std::path::Path;
use std::process::Command;

// The Block Developer ID used by the shared signing service.
pub(super) const REQUIREMENT: &str = "anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = EYF346PHUG";

pub(super) fn verify(directory: &Path, executable: &Path, requirement: &str) -> Result<()> {
    let executable = executable.canonicalize().map_err(|_| INTEGRITY_ERROR)?;
    let macos = executable.parent().ok_or(INTEGRITY_ERROR)?;
    let contents = macos.parent().ok_or(INTEGRITY_ERROR)?;
    let app = contents.parent().ok_or(INTEGRITY_ERROR)?;
    if macos.file_name() != Some("MacOS".as_ref())
        || contents.file_name() != Some("Contents".as_ref())
        || app.extension() != Some("app".as_ref())
        || directory.canonicalize().map_err(|_| INTEGRITY_ERROR)?
            != contents.join("Resources/agent-runtime")
    {
        return Err(INTEGRITY_ERROR.into());
    }
    // Resources (including the manifest and tools) must match the enclosing seal.
    let output = Command::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict", "-R"])
        .arg(format!("={requirement}"))
        .arg(app)
        .output()
        .map_err(|_| INTEGRITY_ERROR)?;
    if !output.status.success() {
        return Err(INTEGRITY_ERROR.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::{executable_hash, RuntimeBundle, Source};
    use serde_json::json;
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::PathBuf;

    struct Fixture {
        _temp: tempfile::TempDir,
        app: PathBuf,
        executable: PathBuf,
        directory: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let app = temp.path().join("Fixture.app");
            let executable = app.join("Contents/MacOS/Fixture");
            let directory = app.join("Contents/Resources/agent-runtime");
            fs::create_dir_all(executable.parent().unwrap()).unwrap();
            fs::create_dir_all(&directory).unwrap();
            fs::copy("/usr/bin/true", &executable).unwrap();
            fs::write(app.join("Contents/Info.plist"), r#"<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundleIdentifier</key><string>dev.buzz.runtime-fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>"#).unwrap();
            let source: Source =
                serde_json::from_str(include_str!("../../../../runtime/agent-runtime.json"))
                    .unwrap();
            let mut files = BTreeMap::new();
            for name in source.tools {
                let path = directory.join(&name);
                fs::copy("/usr/bin/true", &path).unwrap();
                files.insert(name, executable_hash(&path).unwrap());
                sign(&path);
            }
            fs::write(
                directory.join("manifest.json"),
                serde_json::to_vec(&json!({
                    "version": 2, "revision": source.revision, "goose": source.goose,
                    "target": env!("BUZZ_RUNTIME_TARGET"), "files": files,
                }))
                .unwrap(),
            )
            .unwrap();
            Self {
                _temp: temp,
                app,
                executable,
                directory,
            }
        }
        fn load(&self) -> Result<RuntimeBundle> {
            // Exercise the real resource seal without needing a Developer ID key.
            RuntimeBundle::load(self.directory.clone(), |directory| {
                verify(directory, &self.executable, "true")
            })
        }
    }
    fn sign(path: &Path) {
        let output = Command::new("/usr/bin/codesign")
            .args([
                "--force",
                "--sign",
                "-",
                "--identifier",
                "dev.buzz.runtime-fixture",
            ])
            .arg(path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn signed_resources_replace_pre_sign_hashes_but_detect_later_changes() {
        let fixture = Fixture::new();
        assert!(fixture.load().is_err(), "unsigned app must fail");
        sign(&fixture.app);
        let bundle = fixture.load().unwrap();
        assert!(bundle.executable("buzz-agent").is_ok());
        assert!(
            verify(&fixture.directory, &fixture.executable, REQUIREMENT).is_err(),
            "production must reject ad-hoc signatures"
        );
        fs::write(fixture.directory.join("buzz-agent"), "tampered").unwrap();
        assert!(bundle.executable("buzz-agent").is_err());
        assert!(fixture.load().is_err(), "tampered seal must fail");
    }

    #[test]
    fn signature_cannot_authorize_another_runtime_or_wrong_manifest() {
        let fixture = Fixture::new();
        sign(&fixture.app);
        let other = Fixture::new();
        assert!(verify(&other.directory, &fixture.executable, "true").is_err());
        assert!(verify(&fixture.directory, Path::new("/usr/bin/true"), "true").is_err());
        let manifest_path = fixture.directory.join("manifest.json");
        let original: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        for field in ["revision", "target", "files"] {
            let mut manifest = original.clone();
            manifest[field] = if field == "files" {
                let mut files = original["files"].clone();
                let hash = files.as_object_mut().unwrap().remove("buzz-agent").unwrap();
                files["unexpected"] = hash;
                files
            } else {
                json!("wrong")
            };
            fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
            sign(&fixture.app);
            assert!(verify(&fixture.directory, &fixture.executable, "true").is_ok());
            assert!(fixture.load().is_err(), "signed invalid {field} must fail");
        }
    }
}
