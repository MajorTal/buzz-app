//! App lifetime, not page/plugin lifetime. Native startup uses app-owned resources.
use buzz_agent_controller::{
    Action, AgentEdit, ControlSnapshot, Controller, Credentials, ImportPreview, Imports,
    LegacySource, NewAgent, PlatformCredentials, RuntimeBundle, Store,
};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    #[serde(flatten)]
    data: ControlSnapshot,
    import_available: bool,
    create_available: bool,
    avatar_editing_available: bool,
    default_workspace: String,
    harness_options: Vec<HarnessOption>,
    databricks_defaults: crate::agent_models::Defaults,
    agent_defaults: buzz_agent_controller::BuildDefaults,
}
impl Snapshot {
    fn from(data: ControlSnapshot, import_available: bool, workspace: &std::path::Path) -> Self {
        Self {
            data,
            import_available,
            create_available: import_available,
            avatar_editing_available: true,
            default_workspace: workspace.to_string_lossy().into_owned(),
            harness_options: harness_options(),
            databricks_defaults: crate::agent_models::defaults(),
            agent_defaults: buzz_agent_controller::build_defaults(),
        }
    }
}
// Editing suggestions and executable presence only. Availability does not
// establish provider credentials or an ACP session.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HarnessOption {
    command: String,
    label: &'static str,
    available: bool,
    status: &'static str,
    default_args: &'static [&'static str],
    providers: &'static [ProviderOption],
}
#[derive(Serialize)]
struct ProviderOption {
    value: &'static str,
    label: &'static str,
}
// Common IDs checked against Goose's provider registry (crates/goose/src/providers/init.rs)
// and declarative provider definitions. Custom IDs remain editable.
const GOOSE_PROVIDERS: &[ProviderOption] = &[
    ProviderOption {
        value: "anthropic",
        label: "Anthropic",
    },
    ProviderOption {
        value: "openai",
        label: "OpenAI",
    },
    ProviderOption {
        value: "openrouter",
        label: "OpenRouter",
    },
    ProviderOption {
        value: "google",
        label: "Google Gemini",
    },
    ProviderOption {
        value: "github_copilot",
        label: "GitHub Copilot",
    },
    ProviderOption {
        value: "databricks",
        label: "Databricks",
    },
    ProviderOption {
        value: "databricks_v2",
        label: "Databricks v2",
    },
    ProviderOption {
        value: "ollama",
        label: "Ollama",
    },
    ProviderOption {
        value: "groq",
        label: "Groq",
    },
    ProviderOption {
        value: "mistral",
        label: "Mistral AI",
    },
    ProviderOption {
        value: "together",
        label: "Together AI",
    },
    ProviderOption {
        value: "perplexity",
        label: "Perplexity",
    },
    ProviderOption {
        value: "cerebras",
        label: "Cerebras",
    },
    ProviderOption {
        value: "custom_deepseek",
        label: "DeepSeek",
    },
];

fn pi_status(cli: bool, adapter: bool, node: bool) -> &'static str {
    if !cli || !node {
        "cli-needed"
    } else if !adapter {
        "adapter-needed"
    } else {
        "ready"
    }
}

fn harness_options() -> Vec<HarnessOption> {
    let goose = installed_goose();
    let pi = buzz_agent_controller::installed("buzz-pi-acp");
    let pi_status = pi_status(
        buzz_agent_controller::installed("pi").is_some(),
        pi.is_some(),
        buzz_agent_controller::installed("node").is_some(),
    );
    vec![
        HarnessOption {
            command: "buzz-agent".into(),
            label: "Buzz Agent",
            available: true,
            status: "ready",
            default_args: &[],
            providers: &[ProviderOption {
                value: "databricks_v2",
                label: "Databricks v2",
            }],
        },
        HarnessOption {
            command: goose.as_ref().map_or_else(
                || "goose".into(),
                |path| path.to_string_lossy().into_owned(),
            ),
            label: "Goose",
            available: goose.is_some(),
            status: if goose.is_some() {
                "ready"
            } else {
                "cli-needed"
            },
            default_args: &["acp"],
            providers: GOOSE_PROVIDERS,
        },
        HarnessOption {
            command: pi.map_or_else(
                || "buzz-pi-acp".into(),
                |p| p.to_string_lossy().into_owned(),
            ),
            label: "Pi",
            available: pi_status == "ready",
            status: pi_status,
            default_args: &[],
            providers: &[
                ProviderOption {
                    value: "anthropic",
                    label: "Anthropic",
                },
                ProviderOption {
                    value: "openai",
                    label: "OpenAI",
                },
                ProviderOption {
                    value: "openai-codex",
                    label: "OpenAI Codex",
                },
                ProviderOption {
                    value: "google",
                    label: "Google",
                },
                ProviderOption {
                    value: "openrouter",
                    label: "OpenRouter",
                },
            ],
        },
    ]
}

fn installed_goose() -> Option<PathBuf> {
    buzz_agent_controller::installed("goose")
}

struct LogChallenge {
    id: String,
    pubkey: String,
    relay_url: String,
    nonce: String,
    issued: std::time::Instant,
}

struct Host {
    controller: Controller,
    imports: Imports,
    legacy_parent: PathBuf,
    workspace: PathBuf,
    closed: bool,
    credentials: Arc<dyn Credentials>,
    starts: BTreeMap<String, (u64, Option<String>)>,
    next_start: u64,
    /// Agents with an explicit Start/Stop since open; queued restore skips them.
    acted: BTreeSet<String>,
    profiles: BTreeMap<String, Arc<tokio::sync::Mutex<()>>>,
    log_challenges: BTreeMap<String, LogChallenge>,
    creating: Option<(String, Arc<NewAgent>)>,
    legacy_check: fn() -> Result<(), String>,
}
impl Host {
    fn open(
        root: PathBuf,
        legacy_parent: PathBuf,
        workspace: PathBuf,
        bundle: Result<RuntimeBundle, String>,
        credentials: Arc<dyn Credentials>,
    ) -> Result<Self, String> {
        let store = Store::open(root)?;
        let controller = Controller::new(
            store,
            credentials.clone(),
            bundle,
            legacy_parent.join("dev.local.buzz.agent-ownership"),
        );
        Ok(Self {
            controller,
            imports: Imports::default(),
            legacy_parent,
            workspace,
            closed: false,
            credentials,
            starts: BTreeMap::new(),
            next_start: 0,
            acted: BTreeSet::new(),
            profiles: BTreeMap::new(),
            log_challenges: BTreeMap::new(),
            creating: None,
            legacy_check: refuse_legacy,
        })
    }
    fn snapshot(&mut self) -> Result<Snapshot, String> {
        self.controller
            .snapshot()
            .map(|data| Snapshot::from(data, cfg!(target_os = "macos"), &self.workspace))
    }
    fn action(&mut self, id: &str, action: Action) -> Result<Snapshot, String> {
        self.starts.remove(id);
        self.acted.insert(id.to_owned());
        self.controller.action(id, action)?;
        self.snapshot()
    }
    fn refuse_legacy(&self, id: &str) -> Result<(), String> {
        if self.controller.requires_legacy_handover(id)? {
            (self.legacy_check)()
        } else {
            Ok(())
        }
    }
    fn shutdown(&mut self) -> Result<(), String> {
        self.closed = true; // Fence queued commands before shutdown starts.
        self.controller.shutdown()
    }
    fn log_challenge(
        &mut self,
        id: String,
        pubkey: String,
        relay_url: String,
    ) -> Result<String, String> {
        self.controller.log_target(&id, &pubkey, &relay_url)?;
        let nonce = uuid::Uuid::new_v4().to_string();
        self.log_challenges
            .retain(|_, pending| pending.issued.elapsed() <= std::time::Duration::from_secs(20));
        if self.log_challenges.len() >= 4 {
            return Err("Too many pending log authorizations".into());
        }
        self.log_challenges.insert(
            nonce.clone(),
            LogChallenge {
                id,
                pubkey,
                relay_url,
                nonce: nonce.clone(),
                issued: std::time::Instant::now(),
            },
        );
        Ok(nonce)
    }
    fn read_log(
        &mut self,
        id: &str,
        pubkey: &str,
        relay_url: &str,
        nonce: &str,
        signature: &str,
    ) -> Result<String, String> {
        // Consume before comparison or I/O; even a failed proof cannot be replayed.
        let challenge = self
            .log_challenges
            .remove(nonce)
            .ok_or("Log authorization expired")?;
        if challenge.issued.elapsed() > std::time::Duration::from_secs(20)
            || challenge.id != id
            || challenge.pubkey != pubkey
            || challenge.relay_url != relay_url
            || challenge.nonce != nonce
        {
            return Err("Log authorization expired".into());
        }
        self.controller
            .read_log(id, pubkey, relay_url, nonce, signature)
    }
}

type ProfilePublication = (
    tokio::sync::OwnedMutexGuard<()>,
    buzz_agent_controller::CreationProfile,
    Arc<dyn Credentials>,
);

#[derive(Clone)]
pub(crate) struct AgentHost(Arc<Mutex<Result<Host, String>>>, Arc<AtomicBool>);
impl AgentHost {
    pub(crate) fn initialize(
        paths: Result<(PathBuf, PathBuf, PathBuf), String>,
        resources: Result<PathBuf, String>,
    ) -> Self {
        let state = Arc::new(Mutex::new(Err(
            "Agent runtime is initializing; retry shortly".into(),
        )));
        let closed = Arc::new(AtomicBool::new(false));
        let owner = Self(state.clone(), closed.clone());
        tauri::async_runtime::spawn(async move {
            let opened = tauri::async_runtime::spawn_blocking(move || {
                let bundle = resources.and_then(RuntimeBundle::new);
                paths.and_then(|(root, legacy, workspace)| {
                    Host::open(
                        root,
                        legacy,
                        workspace,
                        bundle,
                        Arc::new(PlatformCredentials::default()),
                    )
                })
            })
            .await
            .unwrap_or_else(|_| Err("Agent runtime initialization failed".into()));
            if closed.load(Ordering::SeqCst) {
                return;
            }
            if let Ok(mut state) = state.lock() {
                *state = opened;
            }
            Self(state, closed).restore().await;
        });
        owner
    }
    fn with<T>(&self, operation: impl FnOnce(&mut Host) -> Result<T, String>) -> Result<T, String> {
        if self.1.load(Ordering::SeqCst) {
            return Err("Agent host is shutting down".into());
        }
        let mut state = self
            .0
            .try_lock()
            .map_err(|_| "Another native agent operation is in progress")?;
        let host = state.as_mut().map_err(|message| message.clone())?;
        if host.closed {
            return Err("Agent host is shutting down".into());
        }
        operation(host)
    }
    fn begin_profile(&self, id: &str) -> Result<ProfilePublication, String> {
        self.with(|host| {
            let profile = host.controller.creation_profile(id)?;
            let guard = host
                .profiles
                .entry(id.to_owned())
                .or_default()
                .clone()
                .try_lock_owned()
                .map_err(|_| {
                    "Profile publication is already in progress; refresh status before retrying"
                })?;
            Ok((guard, profile, host.credentials.clone()))
        })
    }
    pub(crate) async fn restore(&self) {
        let ids = self
            .with(|host| host.controller.launch_ids())
            .unwrap_or_default();
        for id in ids {
            let _ = start(self.clone(), id, Action::Start, true, None).await;
        }
    }
    pub(crate) fn ensure_open(&self) -> Result<(), String> {
        self.with(|_| Ok(()))
    }
    pub(crate) fn disconnect(&self, workspace: &str) -> Result<(), String> {
        let workspace = buzz_agent_controller::connection::origin(workspace)?;
        self.with(|host| {
            host.controller.disconnect(&workspace)?;
            // A successful Disconnect also retires pre-existing credential waits.
            // Otherwise their late completion could start against the removed cache.
            host.starts
                .retain(|_, (_, pending)| pending.as_deref() != Some(&workspace));
            Ok(())
        })
    }
    pub(crate) fn model_context(
        &self,
        id: Option<&str>,
        revision: Option<u64>,
        edit: AgentEdit,
    ) -> Result<buzz_agent_controller::ModelContext, String> {
        self.with(|host| match (id, revision) {
            (Some(id), Some(revision)) => host.controller.model_context(id, revision, edit),
            (None, None) => Controller::draft_model_context(edit),
            _ => Err("Invalid agent model context".into()),
        })
    }
    pub(crate) fn goose_model_context(
        &self,
        id: Option<&str>,
        revision: Option<u64>,
        edit: AgentEdit,
    ) -> Result<buzz_agent_controller::GooseModelContext, String> {
        self.with(|host| match (id, revision) {
            (Some(id), Some(revision)) => host.controller.goose_model_context(id, revision, edit),
            (None, None) => Controller::draft_goose_model_context(edit),
            _ => Err("Invalid agent model context".into()),
        })
    }
    pub(crate) fn pi_model_context(
        &self,
        id: Option<&str>,
        revision: Option<u64>,
        edit: AgentEdit,
    ) -> Result<buzz_agent_controller::pi::PiContext, String> {
        self.with(|host| match (id, revision) {
            (Some(id), Some(revision)) => host.controller.pi_model_context(id, revision, edit),
            (None, None) => Controller::draft_pi_model_context(edit),
            _ => Err("Invalid agent model context".into()),
        })
    }
    pub(crate) fn shutdown(&self) -> Result<(), String> {
        self.1.store(true, Ordering::SeqCst);
        let mut state = self
            .0
            .lock()
            .map_err(|_| "Agent host shutdown could not be confirmed")?;
        if let Ok(host) = state.as_mut() {
            host.shutdown()?;
        }
        Ok(())
    }
}
async fn run<T: Send + 'static>(
    state: AgentHost,
    operation: impl FnOnce(&mut Host) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || state.with(operation))
        .await
        .map_err(|_| "Native agent operation failed; refresh status before retrying")?
}
#[tauri::command]
pub(crate) async fn agent_control_log_challenge(
    state: tauri::State<'_, AgentHost>,
    id: String,
    pubkey: String,
    relay_url: String,
) -> Result<String, String> {
    run(state.inner().clone(), move |host| {
        host.log_challenge(id, pubkey, relay_url)
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_control_read_log(
    state: tauri::State<'_, AgentHost>,
    id: String,
    pubkey: String,
    relay_url: String,
    nonce: String,
    signature: String,
) -> Result<String, String> {
    run(state.inner().clone(), move |host| {
        host.read_log(&id, &pubkey, &relay_url, &nonce, &signature)
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_control_snapshot(
    state: tauri::State<'_, AgentHost>,
) -> Result<Snapshot, String> {
    run(state.inner().clone(), |host| host.snapshot()).await
}
#[tauri::command]
pub(crate) async fn agent_control_save(
    state: tauri::State<'_, AgentHost>,
    id: String,
    expected_revision: u64,
    edit: AgentEdit,
) -> Result<Snapshot, String> {
    run(state.inner().clone(), move |host| {
        host.controller.save(&id, expected_revision, edit)?;
        host.snapshot()
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_control_start_on_app_launch(
    state: tauri::State<'_, AgentHost>,
    id: String,
    enabled: bool,
) -> Result<Snapshot, String> {
    run(state.inner().clone(), move |host| {
        host.controller.set_start_on_app_launch(&id, enabled)?;
        host.snapshot()
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_control_delete(
    state: tauri::State<'_, AgentHost>,
    id: String,
    expected_revision: u64,
) -> Result<Snapshot, String> {
    run(state.inner().clone(), move |host| {
        host.starts.remove(&id);
        host.controller.delete(&id, expected_revision)?;
        host.snapshot()
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_control_action(
    state: tauri::State<'_, AgentHost>,
    id: String,
    action: Action,
    replay_floor: Option<u64>,
) -> Result<Snapshot, String> {
    let owner = state.inner().clone();
    if matches!(action, Action::Stop) {
        return run(owner, move |host| host.action(&id, action)).await;
    }
    start(owner, id, action, false, replay_floor).await
}
async fn start(
    owner: AgentHost,
    id: String,
    action: Action,
    restore: bool,
    replay_floor: Option<u64>,
) -> Result<Snapshot, String> {
    let prepared = owner.with(|host| {
        if restore && (host.acted.contains(&id) || !host.controller.launch_ids()?.contains(&id)) {
            return Err("Agent disabled before restore".into());
        }
        host.starts.remove(&id);
        if !restore {
            host.acted.insert(id.clone());
        }
        let request = match host.controller.credential_request(&id) {
            Ok(request) => request,
            Err(error) => {
                host.controller.record_error(&id, error.clone());
                return Err(error);
            }
        };
        if let Err(error) = host.refuse_legacy(&id) {
            host.controller.record_error(&id, error.clone());
            return Err(error);
        }
        host.next_start = host
            .next_start
            .checked_add(1)
            .ok_or("Start sequence exhausted")?;
        let ticket = host.next_start;
        host.starts.insert(id.clone(), (ticket, request.3.clone()));
        Ok((request, ticket, host.credentials.clone()))
    })?;
    let ((credential, pubkey, revision, _workspace), ticket, credentials) = prepared;
    // OS permission prompts never hold the controller. Stop/quit invalidate the
    // ticket while the OS owns its dialog; a late key cannot start a listener.
    let acquired =
        tauri::async_runtime::spawn_blocking(move || credentials.read(&credential, &pubkey))
            .await
            .map_err(|_| "Native credential operation failed".to_owned())
            .and_then(|v| v)
            .and_then(|v| v.ok_or("Saved agent key is unavailable; nothing was started".into()));
    run(owner, move |host| {
        if host.starts.get(&id).map(|(ticket, _)| *ticket) != Some(ticket) {
            return Err("Start cancelled by a newer action".into());
        }
        host.starts.remove(&id);
        let key = match acquired {
            Ok(key) => key,
            Err(error) => {
                host.controller.record_error(&id, error);
                return host.snapshot();
            }
        };
        if let Err(error) = host.refuse_legacy(&id) {
            host.controller.record_error(&id, error);
            return host.snapshot();
        }
        host.controller
            .action_with_key(&id, action, revision, &key, replay_floor)?;
        host.snapshot()
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_control_import_preview(
    state: tauri::State<'_, AgentHost>,
    source: LegacySource,
    destination: String,
) -> Result<ImportPreview, String> {
    run(state.inner().clone(), move |host| {
        host.imports.preview(
            source,
            host.legacy_parent.clone(),
            host.workspace.clone(),
            &destination,
        )
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_control_import_commit(
    state: tauri::State<'_, AgentHost>,
    token: String,
    ids: Vec<String>,
) -> Result<Snapshot, String> {
    let owner = state.inner().clone();
    let (prepared, credentials) = owner.with(|host| {
        let prepared = host
            .controller
            .prepare_import(&mut host.imports, &token, &ids)?;
        // Consume the preview so concurrent IPC cannot import it twice.
        host.imports.discard();
        Ok((prepared, host.credentials.clone()))
    })?;
    let imported =
        tauri::async_runtime::spawn_blocking(move || prepared.acquire(credentials.as_ref()))
            .await
            .map_err(|_| "Native import credential operation failed")??;
    owner.with(|host| {
        host.controller.commit_import(imported)?;
        host.snapshot()
    })
}

#[tauri::command]
pub(crate) async fn agent_control_create_prepare(
    state: tauri::State<'_, AgentHost>,
    request_id: String,
    destination: String,
    owner: String,
) -> Result<serde_json::Value, String> {
    run(state.inner().clone(), move |host| {
        if uuid::Uuid::parse_str(&request_id).is_err() {
            return Err("Invalid create request".into());
        }
        if host.creating.as_ref().map(|(id, _)| id) != Some(&request_id) {
            host.creating = Some((
                request_id,
                Arc::new(NewAgent::prepare(&destination, &owner)?),
            ));
        }
        let agent = &host.creating.as_ref().ok_or("Create request expired")?.1;
        if !agent.matches(&destination, &owner)? {
            return Err("Create destination or owner changed".into());
        }
        Ok(serde_json::json!({"id": agent.id, "pubkey": agent.key.pubkey()}))
    })
    .await
}
#[tauri::command]
pub(crate) async fn agent_control_create_commit(
    state: tauri::State<'_, AgentHost>,
    request_id: String,
    edit: AgentEdit,
    auth: String,
) -> Result<Snapshot, String> {
    let owner = state.inner().clone();
    let (prepared, credentials) = owner.with(|host| {
        let (_, prepared) = host
            .creating
            .as_ref()
            .filter(|(id, _)| id == &request_id)
            .ok_or("Create request expired; reopen Add agent")?;
        prepared.validate(edit.clone(), &auth)?;
        Ok((prepared.clone(), host.credentials.clone()))
    })?;
    let saved = prepared.clone();
    tauri::async_runtime::spawn_blocking(move || saved.save_key(credentials.as_ref()))
        .await
        .map_err(|_| "Native credential operation failed")??;
    owner.with(|host| {
        if host.creating.as_ref().map(|(id, _)| id) != Some(&request_id) {
            return Err("Create request was replaced".into());
        }
        host.controller.create(&prepared, edit, &auth)?;
        host.snapshot()
    })
}
#[tauri::command]
pub(crate) async fn agent_control_creation_profile(
    state: tauri::State<'_, AgentHost>,
    id: String,
) -> Result<Snapshot, String> {
    publish_profile(state.inner().clone(), id).await
}

async fn publish_profile(owner: AgentHost, id: String) -> Result<Snapshot, String> {
    // Native ownership survives renderer reloads. Refuse overlapping publication,
    // while allowing settings Save to advance the revision and retain pending.
    let (publication, profile, credentials) = owner.begin_profile(&id)?;
    let (profile, key) = tauri::async_runtime::spawn_blocking(move || {
        credentials
            .read(&profile.credential_id, &profile.pubkey)
            .map(|key| (profile, key))
    })
    .await
    .map_err(|_| "Native credential operation failed")??;
    let key = key.ok_or("Agent key unavailable")?;
    owner.ensure_open()?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|_| "Profile client unavailable")?;
    publish_acquired(&owner, &id, &profile, &key, &client, publication).await
}

async fn publish_acquired(
    owner: &AgentHost,
    id: &str,
    profile: &buzz_agent_controller::CreationProfile,
    key: &buzz_agent_controller::Secret,
    client: &reqwest::Client,
    _publication: tokio::sync::OwnedMutexGuard<()>,
) -> Result<Snapshot, String> {
    profile_http::publish(client, profile, key, || {
        owner.with(|host| {
            let current = host.controller.creation_profile(id)?;
            if current.revision != profile.revision {
                return Err("Saved profile changed; retry publication".into());
            }
            Ok(())
        })
    })
    .await?;
    owner.with(|host| {
        host.controller.profile_published(id, profile.revision)?;
        host.snapshot()
    })
}

mod profile_http;

#[cfg(test)]
pub(crate) mod tests;

// Advisory handover guard only: unmodified old Buzz does not share our lock and
// can be launched afterward. Never inspect process environments or terminate it.
fn refuse_legacy_listing(listing: &str) -> Result<(), String> {
    for line in listing.lines() {
        let executable = line
            .trim()
            .split_once(char::is_whitespace)
            .map(|(_, exe)| exe.trim())
            .unwrap_or("");
        let name = std::path::Path::new(executable)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");
        if name == "buzz-desktop"
            || executable.contains("/Buzz.app/Contents/MacOS/")
            || executable.contains("/Buzz Dev.app/Contents/MacOS/")
        {
            return Err(
                "Stop old Buzz before starting agents here; simultaneous ownership is unsupported"
                    .into(),
            );
        }
    }
    Ok(())
}
fn refuse_legacy() -> Result<(), String> {
    let output = std::process::Command::new("/bin/ps")
        .args(["-axo", "pid=,comm="])
        .env_clear()
        .output()
        .map_err(|_| "Could not check old Buzz processes; Start refused")?;
    if !output.status.success() || output.stdout.len() > 4 * 1024 * 1024 {
        return Err("Could not check old Buzz processes; Start refused".into());
    }
    refuse_legacy_listing(&String::from_utf8_lossy(&output.stdout))
}
