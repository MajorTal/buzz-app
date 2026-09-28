//! Pi's supported CLI boundary, shared by discovery and ACP launch.
use crate::{
    runtime::{executable, installed},
    HarnessEdit, Result,
};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

/// Native only: contains local environment values, never serialized over IPC.
pub struct PiContext {
    pub command: PathBuf,
    pub workspace: PathBuf,
    pub args: Vec<String>,
    pub environment: BTreeMap<String, String>,
    pub path: std::ffi::OsString,
}
impl PiContext {
    pub(crate) fn new(
        harness: &HarnessEdit,
        workspace: &str,
        environment: &BTreeMap<String, String>,
    ) -> Result<Self> {
        let adapter = Path::new(&harness.command);
        if !adapter.is_absolute()
            || adapter.file_name().and_then(|n| n.to_str()) != Some("buzz-pi-acp")
        {
            return Err("Pi requires an absolute buzz-pi-acp executable path".into());
        }
        executable(adapter)?;
        if !Path::new(workspace).is_absolute() || !Path::new(workspace).is_dir() {
            return Err("Choose an existing absolute workspace before browsing Pi models".into());
        }
        crate::config::validate_environment(environment)?;
        // The adapter owns its supported runtime flags. Discovery applies its
        // narrower, prompt-free contract separately.
        let args = &harness.args;
        if !args.is_empty() && args.first().map(String::as_str) != Some("--") {
            return Err("Pi arguments must follow --".into());
        }
        if args.len() > 128
            || args
                .iter()
                .any(|a| a.is_empty() || a.len() > 8192 || a.contains([',', '\0']))
        {
            return Err("Invalid Pi arguments".into());
        }
        let resolve = |name| {
            let sibling = adapter.parent().unwrap().join(name);
            if executable(&sibling).is_ok() {
                Some(sibling)
            } else {
                installed(name)
            }
        };
        let managed_data = adapter
            .parent()
            .filter(|bin| bin.file_name().is_some_and(|name| name == "bin"))
            .and_then(Path::parent)
            .filter(|prefix| prefix.file_name().is_some_and(|name| name == "node-tools"))
            .and_then(Path::parent);
        let command = resolve("pi").ok_or("Install Pi and reopen the desktop app")?;
        // A managed adapter always uses the pinned Node beside its app-owned
        // prefix. A user-global adapter keeps its existing user-global resolution.
        let node = if let Some(app_data) = managed_data {
            crate::runtime::managed_tool(app_data, "node")
        } else {
            resolve("node")
        }
        .ok_or("Install Node.js for the Pi ACP adapter")?;
        let path = std::env::join_paths([
            node.parent().unwrap(),
            command.parent().unwrap(),
            Path::new("/usr/bin"),
            Path::new("/bin"),
            Path::new("/usr/sbin"),
            Path::new("/sbin"),
        ])
        .map_err(|_| "Invalid Pi tools path")?;
        let mut environment = environment.clone();
        environment.insert(
            "PI_ACP_PI_COMMAND".into(),
            command.to_string_lossy().into_owned(),
        );
        Ok(Self {
            command,
            workspace: workspace.into(),
            args: args.iter().skip(1).cloned().collect(),
            environment,
            path,
        })
    }

    pub fn catalog_args(&self) -> Result<Vec<String>> {
        let mut result = Vec::new();
        let mut args = self.args.iter();
        while let Some(arg) = args.next() {
            // Match Pi's separate-token CLI syntax exactly. Do not normalize
            // options differently from runtime or rebind --api-key to a default
            // provider after removing selection for this catalog-only process.
            let flag = arg.as_str();
            let selection = matches!(flag, "--provider" | "--model");
            let takes_value = selection
                || matches!(
                    flag,
                    "--extension"
                        | "-e"
                        | "--skill"
                        | "--prompt-template"
                        | "--theme"
                        | "--thinking"
                        | "--tools"
                        | "-t"
                        | "--exclude-tools"
                        | "-xt"
                        | "--models"
                );
            if takes_value {
                let value = args
                    .next()
                    .map(String::as_str)
                    .filter(|v| !v.is_empty() && !v.starts_with('-'))
                    .ok_or("Pi option is missing a value; check Advanced arguments")?;
                if !selection {
                    result.extend([flag.to_owned(), value.to_owned()]);
                }
            } else if matches!(
                flag,
                "--no-extensions"
                    | "-ne"
                    | "--no-skills"
                    | "-ns"
                    | "--no-prompt-templates"
                    | "-np"
                    | "--no-themes"
                    | "--no-tools"
                    | "-nt"
                    | "--no-builtin-tools"
                    | "-nbt"
                    | "--no-context-files"
                    | "-nc"
                    | "--offline"
                    | "--approve"
                    | "-a"
                    | "--no-approve"
                    | "-na"
            ) {
                result.push(arg.clone());
            } else {
                return Err("Pi model browsing does not support these Advanced arguments. Runtime arguments are preserved; use a custom model ID or adjust the arguments to browse".into());
            }
        }
        Ok(result)
    }

    pub(crate) fn adapter_args(&self, harness: &HarnessEdit) -> Result<Vec<String>> {
        validate_selection(&harness.provider, &harness.model)?;
        let mut args = vec!["--".into()];
        args.extend(self.args.clone());
        if !harness.provider.is_empty() {
            args.extend(["--provider".into(), harness.provider.clone()]);
        }
        if !harness.model.is_empty() {
            args.extend(["--model".into(), harness.model.clone()]);
        }
        Ok(args)
    }
}

/// Selection constraints shared by catalog discovery and ACP launch.
/// Empty selectors retain Pi defaults; model IDs may contain namespace slashes.
pub fn validate_selection(provider: &str, model: &str) -> Result<()> {
    if !provider.is_empty() && model.is_empty() {
        return Err(
            "Choose a Pi model for the selected provider, or clear both fields to use Pi defaults"
                .into(),
        );
    }
    if provider.contains('/') {
        return Err("Invalid Pi provider or model ID".into());
    }
    for (value, limit) in [(provider, 128), (model, 512)] {
        if value.len() > limit
            || value.starts_with('-')
            || value.contains(',')
            || value.chars().any(char::is_control)
        {
            return Err("Invalid Pi provider or model ID".into());
        }
    }
    Ok(())
}
