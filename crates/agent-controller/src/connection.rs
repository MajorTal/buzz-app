//! App-owned persistent settings and the existing engine's OAuth cache layout.
//! This is not an OAuth implementation; the pinned engine owns acquisition/refresh.
use crate::Result;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatabricksSettings {
    pub host: String,
    pub filter: String,
}
impl DatabricksSettings {
    pub(crate) fn validate(&self) -> Result<()> {
        if self.host.len() > 4096 || self.filter.len() > 4096 || self.filter.contains('\0') {
            return Err("Connection settings are too long or invalid".into());
        }
        // An empty draft can be saved offline; Start requires a workspace.
        if !self.host.is_empty() {
            origin(&self.host)?;
        }
        Ok(())
    }
}
/// The pinned engine keeps non-Unix OAuth tokens in memory only, so neither a
/// later request nor a worker could reuse a sign-in. Deferred on Windows.
pub const DATABRICKS_WINDOWS: &str =
    "Databricks sign-in is not supported on Windows yet. Choose OpenAI for this agent";
pub fn origin(raw: &str) -> Result<String> {
    if raw.is_empty() {
        return Err("Databricks workspace is not configured. Edit the agent, open Advanced → Model, and set Databricks workspace (HTTPS origin).".into());
    }
    let invalid = || {
        "Enter a Databricks HTTPS workspace origin without credentials, path, query or fragment"
            .to_owned()
    };
    let authority = raw.strip_prefix("https://").ok_or_else(invalid)?;
    let authority = authority.strip_suffix('/').unwrap_or(authority);
    let url = url::Url::parse(raw).map_err(|_| invalid())?;
    if raw.trim() != raw
        || raw.chars().any(char::is_control)
        || raw.contains('\\')
        || authority.contains(['/', '@'])
        || url.host_str().is_none()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(invalid());
    }
    Ok(url.as_str().trim_end_matches('/').into())
}
pub fn private_directory(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {}
        Ok(_) => return Err("App storage must be a private directory, not a link".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir(path).map_err(|_| "Could not create private app storage")?;
        }
        Err(_) => return Err("Could not inspect private app storage".into()),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "Could not protect app storage")?;
    }
    Ok(())
}
/// C is the native profile, P is exactly C/buzz-agent/oauth for both consumers.
pub fn oauth_root(config: &Path) -> Result<PathBuf> {
    if !config.is_absolute() {
        return Err("App connection storage must be absolute".into());
    }
    private_directory(config)?;
    let agent = config.join("buzz-agent");
    private_directory(&agent)?;
    let root = agent.join("oauth");
    private_directory(&root)?;
    private_directory(&root.join("databricks"))?;
    Ok(root)
}
/// Keep the engine's lock inode. Only a serialized native controller with no
/// running users of this workspace may call this. Other workspace caches survive.
pub fn disconnect(cache: &Path, workspace: &str) -> Result<()> {
    let workspace = origin(workspace)?;
    let namespace = cache.join("databricks");
    private_directory(&namespace)?;
    let key = format!("{workspace}/oidc/.well-known/oauth-authorization-server|databricks-cli|all-apis,offline_access");
    let hash = format!("{:x}", Sha256::digest(key.as_bytes()));
    for suffix in ["json", "json.cooldown", "json.attempt"] {
        let path = namespace.join(format!("{hash}.{suffix}"));
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Could not remove this app's connection credentials".into()),
        }
    }
    Ok(())
}
