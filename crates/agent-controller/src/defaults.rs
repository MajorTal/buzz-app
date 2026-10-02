use crate::{connection::DatabricksSettings, HarnessEdit};
use serde::Serialize;
use std::{collections::BTreeMap, path::Path};

/// Public, nonsecret build configuration. Saved values are never projected here.
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDefaults {
    pub host: String,
    pub filter: String,
    pub model: String,
    pub provider: String,
    pub owner_only: bool,
}
include!(concat!(env!("OUT_DIR"), "/agent_defaults.rs"));

impl BuildDefaults {
    // Resolve a temporary copy, never mutate the stored agent or its revision.
    pub(crate) fn resolve(
        &self,
        saved: &HarnessEdit,
        env: &BTreeMap<String, String>,
    ) -> HarnessEdit {
        let mut harness = saved.clone();
        if Path::new(&harness.command)
            .file_name()
            .and_then(|s| s.to_str())
            != Some("buzz-agent")
        {
            return harness;
        }
        if harness.provider.is_empty() {
            harness.provider.clone_from(&self.provider);
        }
        if let Some(provider) = env.get("BUZZ_AGENT_PROVIDER") {
            harness.provider.clone_from(provider);
        }
        if databricks(&harness.provider) {
            if harness.model.is_empty() {
                harness.model = env.get("DATABRICKS_MODEL").unwrap_or(&self.model).clone();
            }
            if harness.databricks.is_none() && (!self.host.is_empty() || !self.filter.is_empty()) {
                harness.databricks = Some(DatabricksSettings {
                    host: self.host.clone(),
                    filter: self.filter.clone(),
                });
            }
        }
        if let Some(model) = env.get("BUZZ_AGENT_MODEL") {
            harness.model.clone_from(model);
        }
        harness
    }

    /// Next-start selectors safe to project. Environment values stay native:
    /// a selector an environment override decides is named by its key only.
    pub(crate) fn launch_view(
        &self,
        saved: &HarnessEdit,
        env: &BTreeMap<String, String>,
    ) -> LaunchView {
        let none = BTreeMap::new();
        let public = self.resolve(saved, &none);
        let selected = selectors(&public, &none);
        let set = |key: &'static str| env.contains_key(key).then_some(key);
        let (model_key, provider_key) = selected.keys.unzip();
        let provider_env = provider_key.and_then(set);
        let acp_model = matches!(
            crate::agent_defaults::harness_kind(&saved.command),
            Some("pi" | "goose")
        )
        .then_some("BUZZ_ACP_MODEL")
        .and_then(set);
        let model_env = acp_model.or_else(|| model_key.and_then(set)).or_else(|| {
            // A blank buzz-agent model follows the provider, which may be hidden.
            if model_key != Some("BUZZ_AGENT_MODEL") || !saved.model.is_empty() {
                None
            } else if provider_env.is_some() {
                provider_env
            } else if databricks(&public.provider) {
                set("DATABRICKS_MODEL")
            } else {
                None
            }
        });
        LaunchView {
            model: selected
                .model
                .filter(|_| model_env.is_none())
                .map(str::to_owned),
            // Unmapped workers (Pi) take the saved provider directly.
            provider: selected
                .provider
                .or_else(|| (!public.provider.is_empty()).then_some(public.provider.as_str()))
                .filter(|_| provider_env.is_none())
                .map(str::to_owned),
            model_env,
            provider_env,
        }
    }
}

fn databricks(provider: &str) -> bool {
    matches!(provider, "databricks_v2" | "databricks-v2" | "databricks")
}

pub(crate) struct LaunchView {
    pub model: Option<String>,
    pub provider: Option<String>,
    pub model_env: Option<&'static str>,
    pub provider_env: Option<&'static str>,
}

/// Worker selector variables and the model/provider values a start passes to
/// them. Explicit per-agent environment overrides the resolved selectors, and a
/// blank selector never erases it. `None` keys: the worker has no mapping.
pub(crate) struct Selectors<'a> {
    pub keys: Option<(&'static str, &'static str)>,
    pub model: Option<&'a str>,
    pub provider: Option<&'a str>,
}
pub(crate) fn selectors<'a>(
    resolved: &'a HarnessEdit,
    env: &'a BTreeMap<String, String>,
) -> Selectors<'a> {
    let keys = match Path::new(&resolved.command)
        .file_name()
        .and_then(|s| s.to_str())
    {
        Some("buzz-agent") => Some(("BUZZ_AGENT_MODEL", "BUZZ_AGENT_PROVIDER")),
        Some("goose" | "goose.exe" | "goose-acp" | "goose-acp.exe") => {
            Some(("GOOSE_MODEL", "GOOSE_PROVIDER"))
        }
        _ => None,
    };
    let saved = |value: &'a String| (!value.is_empty()).then_some(value.as_str());
    let mut model = saved(&resolved.model);
    let mut provider = None;
    if let Some((model_key, provider_key)) = keys {
        model = env.get(model_key).map(String::as_str).or(model);
        provider = env
            .get(provider_key)
            .map(String::as_str)
            .or_else(|| saved(&resolved.provider));
    }
    Selectors {
        keys,
        model,
        provider,
    }
}
