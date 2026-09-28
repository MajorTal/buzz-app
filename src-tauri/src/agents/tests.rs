use super::*;
use buzz_agent_controller::Secret;
use serde_json::{json, Value};
use tauri::test::{get_ipc_response, mock_builder, MockRuntime};

const RUNTIME_GATE: &str = "Synthetic runtime unavailable.";
const IMPORT_GATE: &str = "Synthetic credential refusal.";

// Test-only custody. Synthetic fixtures cannot reach PlatformCredentials.
struct RejectingCredentials;
impl Credentials for RejectingCredentials {
    fn delete(&self, _: &str, _: &str) -> Result<(), String> {
        Err(IMPORT_GATE.into())
    }
    fn read_legacy(&self, _: LegacySource, _: &str) -> Result<Secret, String> {
        Err(IMPORT_GATE.into())
    }
    fn read(&self, _: &str, _: &str) -> Result<Option<Secret>, String> {
        Err(IMPORT_GATE.into())
    }
    fn add(&self, _: &str, _: &Secret) -> Result<(), String> {
        Err(IMPORT_GATE.into())
    }
}

impl AgentHost {
    fn open(paths: Result<(PathBuf, PathBuf, PathBuf), String>) -> Self {
        Self(
            Arc::new(Mutex::new(paths.and_then(|(root, legacy, workspace)| {
                Host::open(
                    root,
                    legacy,
                    workspace,
                    Err(RUNTIME_GATE.into()),
                    Arc::new(RejectingCredentials),
                )
            }))),
            Arc::new(AtomicBool::new(false)),
        )
    }
}

pub(crate) fn fixture() -> (
    tempfile::TempDir,
    AgentHost,
    tauri::App<MockRuntime>,
    tauri::WebviewWindow<MockRuntime>,
) {
    fixture_with_models(|dir| crate::agent_models::ModelHost::new(Ok(dir.join("store"))))
}
pub(crate) fn fixture_with_models(
    models: impl FnOnce(&std::path::Path) -> crate::agent_models::ModelHost,
) -> (
    tempfile::TempDir,
    AgentHost,
    tauri::App<MockRuntime>,
    tauri::WebviewWindow<MockRuntime>,
) {
    let dir = tempfile::tempdir().unwrap();
    let model_host = models(dir.path());
    let host = AgentHost::open(Ok((
        dir.path().join("store"),
        dir.path().join("legacy"),
        dir.path().join("workspace"),
    )));
    let app = mock_builder()
        .manage(host.clone())
        .manage(model_host)
        .invoke_handler(crate::commands())
        .build(crate::app_context())
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    (dir, host, app, view)
}
pub(crate) fn invoke(
    view: &tauri::WebviewWindow<MockRuntime>,
    cmd: &str,
    body: Value,
) -> Result<Value, Value> {
    get_ipc_response(
        view,
        tauri::webview::InvokeRequest {
            cmd: cmd.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
    )
    .map(|body| body.deserialize().unwrap())
}
pub(crate) fn seed(dir: &std::path::Path) -> String {
    let id = format!(
        "{}-{}",
        "ab".repeat(32),
        "733db93c5a38b650794422a480fab67f1dd8f6f40112c360f9814dfaec3bfcbb"
    );
    // Public artificial identity and write-only sample environment; no key custody.
    std::fs::write(dir.join("store/agents.json"), serde_json::to_vec(&json!({"version":1,"agents":[{
        "id":id, "pubkey":"ab".repeat(32), "relayUrl":"wss://relay.example", "name":"Sample", "systemPrompt":"Original",
        "workspace":dir.to_str().unwrap(), "harness":{"command":"buzz-agent","args":[],"model":"sample","provider":"sample"},
        "environment":{"SAMPLE_TOKEN":"DO_NOT_PROJECT"},"revision":1,"enabled":true,"credentialId":"missing-fixture-key", "authTag":null, "imported":{}
    }]})).unwrap()).unwrap();
    id
}
#[test]
fn production_acl_allows_delete_to_reach_native_credentials() {
    let (dir, _host, _app, view) = fixture();
    let id = seed(dir.path());
    let error = invoke(
        &view,
        "agent_control_delete",
        json!({"id": id, "expectedRevision": 1}),
    )
    .unwrap_err();
    assert_eq!(error, IMPORT_GATE);
    let stored: Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("store/agents.json")).unwrap())
            .unwrap();
    assert_eq!(stored["agents"][0]["enabled"], false);
}
#[test]
fn harnesses_classify_cli_and_adapter_separately() {
    assert_eq!(pi_status(false, false, false), "cli-needed");
    assert_eq!(pi_status(false, true, true), "cli-needed");
    assert_eq!(pi_status(true, false, false), "cli-needed");
    assert_eq!(pi_status(true, true, false), "cli-needed");
    assert_eq!(pi_status(true, false, true), "adapter-needed");
    assert_eq!(pi_status(true, true, true), "ready");
}

#[test]
fn real_ipc_snapshot_save_cas_stop_and_launch_gate() {
    let (dir, _host, _app, view) = fixture();
    let id = seed(dir.path());
    let before = invoke(&view, "agent_control_snapshot", json!({})).unwrap();
    assert_eq!(before["runtimeAvailable"], false);
    assert_eq!(before["importAvailable"], cfg!(target_os = "macos"));
    assert_eq!(
        before["harnessOptions"][0],
        json!({
            "command":"buzz-agent", "label":"Buzz Agent",
            "available":true, "status":"ready", "defaultArgs":[],
            "providers":[{"value":"databricks_v2", "label":"Databricks v2"}]
        })
    );
    assert_eq!(before["harnessOptions"].as_array().unwrap().len(), 3);
    assert_eq!(before["harnessOptions"][2]["label"], "Pi");
    assert_eq!(
        before["harnessOptions"][2]["available"],
        before["harnessOptions"][2]["status"] == "ready"
    );
    assert_eq!(before["harnessOptions"][2]["defaultArgs"], json!([]));
    assert_eq!(
        before["harnessOptions"][2]["status"],
        pi_status(
            buzz_agent_controller::installed("pi").is_some(),
            buzz_agent_controller::installed("buzz-pi-acp").is_some(),
            buzz_agent_controller::installed("node").is_some(),
        )
    );
    assert_eq!(before["harnessOptions"][1]["label"], "Goose");
    assert_eq!(before["harnessOptions"][1]["defaultArgs"], json!(["acp"]));
    assert_eq!(
        before["harnessOptions"][1]["status"],
        if installed_goose().is_some() {
            "ready"
        } else {
            "cli-needed"
        }
    );
    assert_eq!(
        before["harnessOptions"][1]["available"],
        installed_goose().is_some()
    );
    assert_eq!(
        before["harnessOptions"][1]["command"],
        installed_goose().map_or_else(|| json!("goose"), |path| json!(path.to_string_lossy()))
    );
    assert!(
        before["harnessOptions"][1]["providers"]
            .as_array()
            .unwrap()
            .len()
            > 5
    );
    assert!(before["harnessOptions"][1]["providers"]
        .as_array()
        .unwrap()
        .iter()
        .any(|provider| provider["value"] == "databricks"));
    assert_eq!(before["agents"][0]["name"], "Sample");
    assert_eq!(before["agents"][0]["enabled"], true);
    assert_eq!(before["agents"][0]["status"], "stopped");
    assert!(!before.to_string().contains("DO_NOT_PROJECT"));
    for action in ["start", "restart"] {
        let err = invoke(
            &view,
            "agent_control_action",
            json!({"id":id,"action":action}),
        )
        .unwrap_err();
        assert_eq!(err, RUNTIME_GATE);
    }
    let edit = json!({"name":"Edited","systemPrompt":"Saved via IPC","workspace":dir.path().to_str().unwrap(),
        "harness":{"command":"buzz-agent","args":["--literal space"],"model":"chosen","provider":"databricks_v2"},"environment":{}});
    let saved = invoke(
        &view,
        "agent_control_save",
        json!({"id":id,"expectedRevision":1,"edit":edit}),
    )
    .unwrap();
    assert_eq!(saved["harnessOptions"], before["harnessOptions"]);
    assert_eq!(saved["runtimeAvailable"], false);
    assert_eq!(saved["importAvailable"], cfg!(target_os = "macos"));
    assert_eq!(saved["agents"][0]["harness"]["provider"], "databricks_v2");
    assert_eq!(
        saved["agents"][0]["harness"]["args"],
        json!(["--literal space"])
    );
    assert_eq!(saved["agents"][0]["revision"], 2);
    assert_eq!(saved["agents"][0]["systemPrompt"], "Saved via IPC");
    assert!(invoke(
        &view,
        "agent_control_save",
        json!({"id":id,"expectedRevision":1,"edit":edit})
    )
    .is_err());
    let stopped = invoke(
        &view,
        "agent_control_action",
        json!({"id":id,"action":"stop"}),
    )
    .unwrap();
    assert_eq!(stopped["harnessOptions"], before["harnessOptions"]);
    assert_eq!(stopped["agents"][0]["enabled"], false);
    assert_eq!(stopped["agents"][0]["revision"], 2);
    let disk: Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("store/agents.json")).unwrap())
            .unwrap();
    assert_eq!(disk["agents"][0]["systemPrompt"], "Saved via IPC");
    assert_eq!(disk["agents"][0]["harness"]["provider"], "databricks_v2");
    assert_eq!(
        invoke(&view, "agent_control_snapshot", json!({})).unwrap()["agents"][0]["harness"],
        saved["agents"][0]["harness"]
    );
    assert_eq!(disk["agents"][0]["enabled"], false);
    assert_eq!(
        disk["agents"][0]["environment"]["SAMPLE_TOKEN"],
        "DO_NOT_PROJECT"
    );
}
#[test]
fn real_ipc_preview_source_no_import_and_shutdown_fence() {
    let (dir, host, _app, view) = fixture();
    let source = dir.path().join("legacy/xyz.block.buzz.app.dev/agents");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(
        source.join("managed-agents.json"),
        serde_json::to_vec(&json!([{
            "pubkey":"79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
            "name":"Synthetic", "agent_command":"buzz-agent", "agent_args":[]
        }]))
        .unwrap(),
    )
    .unwrap();
    let preview = invoke(
        &view,
        "agent_control_import_preview",
        json!({"source":"development","destination":"wss://chosen.example"}),
    )
    .unwrap();
    assert!(preview["sourcePath"]
        .as_str()
        .unwrap()
        .ends_with("xyz.block.buzz.app.dev/agents/managed-agents.json"));
    assert!(invoke(
        &view,
        "agent_control_import_preview",
        json!({"source":"installed","destination":"wss://chosen.example"})
    )
    .is_err());
    assert_eq!(
        invoke(
            &view,
            "agent_control_import_commit",
            json!({"token":preview["token"],"ids":[preview["candidates"][0]["id"]]})
        )
        .unwrap_err(),
        "Import preview expired; choose the source again"
    );
    let preview = invoke(
        &view,
        "agent_control_import_preview",
        json!({"source":"development","destination":"wss://chosen.example"}),
    )
    .unwrap();
    assert_eq!(
        invoke(
            &view,
            "agent_control_import_commit",
            json!({"token":preview["token"],"ids":[preview["candidates"][0]["id"]]})
        )
        .unwrap_err(),
        IMPORT_GATE
    );
    host.shutdown().unwrap();
    assert_eq!(
        invoke(&view, "agent_control_snapshot", json!({})).unwrap_err(),
        "Agent host is shutting down"
    );
}
#[test]
fn queued_restore_skips_agent_stopped_after_launch() {
    let (dir, host, _app, view) = fixture();
    let id = seed(dir.path());
    let path = dir.path().join("store/agents.json");
    let mut saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    saved["agents"][0]["startOnAppLaunch"] = json!(true);
    std::fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
    // Restore captured this id, then the user stopped it before its turn.
    let queued = host.with(|h| h.controller.launch_ids()).unwrap();
    assert_eq!(queued, vec![id.clone()]);
    let stopped = invoke(
        &view,
        "agent_control_action",
        json!({"id":id,"action":"stop"}),
    )
    .unwrap();
    assert_eq!(stopped["agents"][0]["startOnAppLaunch"], true);
    let restored =
        tauri::async_runtime::block_on(start(host.clone(), id, Action::Start, true, None));
    assert_eq!(
        restored.err().as_deref(),
        Some("Agent disabled before restore")
    );
    let after = invoke(&view, "agent_control_snapshot", json!({})).unwrap();
    assert_eq!(after["agents"][0]["enabled"], false);
    // Fenced before credential/runtime checks: nothing was attempted or recorded.
    assert!(after["agents"][0]["error"].is_null());
}

// Unix-only: the synthetic bundle relies on executable-mode scripts.
#[cfg(unix)]
mod overlap {
    use super::*;

    const REFUSAL: &str = "Synthetic credential refusal";

    // Verified manifest over inert scripts. Credential refusal precedes any spawn.
    fn synthetic_bundle(directory: &std::path::Path) -> RuntimeBundle {
        use sha2::{Digest, Sha256};
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(directory).unwrap();
        let source: Value =
            serde_json::from_str(include_str!("../../../runtime/agent-runtime.json")).unwrap();
        let mut files = BTreeMap::new();
        for tool in source["tools"].as_array().unwrap() {
            let name = tool.as_str().unwrap();
            let path = directory.join(name);
            std::fs::write(&path, "#!/bin/sh\nexit 1\n").unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
            let digest = Sha256::digest(std::fs::read(&path).unwrap());
            files.insert(name.to_owned(), format!("{digest:x}"));
        }
        let manifest = json!({"version":1, "revision":source["revision"],
            "target":env!("TAURI_ENV_TARGET_TRIPLE"), "files":files});
        std::fs::write(
            directory.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        RuntimeBundle::new(directory.into()).unwrap()
    }

    // Each credential read reports entry, then blocks until the test releases that
    // exact credential id; an unplanned read fails fast instead of hanging.
    struct Gated {
        entered: std::sync::mpsc::Sender<String>,
        release: Mutex<BTreeMap<String, std::sync::mpsc::Receiver<()>>>,
    }
    impl Credentials for Gated {
        fn delete(&self, _: &str, _: &str) -> Result<(), String> {
            panic!("not a deletion")
        }
        fn read_legacy(&self, _: LegacySource, _: &str) -> Result<Secret, String> {
            panic!("not an import")
        }
        fn add(&self, _: &str, _: &Secret) -> Result<(), String> {
            panic!("not a write")
        }
        fn read(&self, id: &str, _: &str) -> Result<Option<Secret>, String> {
            self.entered.send(id.to_owned()).unwrap();
            let gate = self.release.lock().unwrap().remove(id);
            gate.ok_or("Unplanned credential read")?.recv().unwrap();
            Err(REFUSAL.into())
        }
    }
    struct Gate {
        entered: Arc<Mutex<std::sync::mpsc::Receiver<String>>>,
        release: BTreeMap<String, std::sync::mpsc::Sender<()>>,
    }
    impl Gate {
        fn install(host: &AgentHost, dir: &std::path::Path, ids: &[&str]) -> Self {
            let (entered, receive) = std::sync::mpsc::channel();
            let (mut release, mut wait) = (BTreeMap::new(), BTreeMap::new());
            for id in ids {
                let (send, receive) = std::sync::mpsc::channel();
                release.insert((*id).to_owned(), send);
                wait.insert((*id).to_owned(), receive);
            }
            let credentials: Arc<dyn Credentials> = Arc::new(Gated {
                entered,
                release: Mutex::new(wait),
            });
            host.with(|h| {
                // Drop the fixture's store lock before reopening the same store.
                h.controller = Controller::new(
                    Store::open(dir.join("replacement"))?,
                    credentials.clone(),
                    Err("placeholder".into()),
                    dir.join("ownership"),
                );
                h.controller = Controller::new(
                    Store::open(dir.join("store"))?,
                    credentials.clone(),
                    Ok(synthetic_bundle(&dir.join("tools"))),
                    dir.join("ownership"),
                );
                h.credentials = credentials;
                h.legacy_check = || Ok(());
                Ok(())
            })
            .unwrap();
            Self {
                entered: Arc::new(Mutex::new(receive)),
                release,
            }
        }
        async fn entered(&self) -> String {
            let entered = self.entered.clone();
            tokio::task::spawn_blocking(move || {
                entered
                    .lock()
                    .unwrap()
                    .recv_timeout(std::time::Duration::from_secs(5))
            })
            .await
            .unwrap()
            .expect("credential read did not start")
        }
        fn idle(&self) -> bool {
            self.entered.lock().unwrap().try_recv().is_err()
        }
    }
    // Two launch-enabled agents with distinct credential ids.
    fn seed_pair(dir: &std::path::Path) -> Vec<String> {
        let suffix = "733db93c5a38b650794422a480fab67f1dd8f6f40112c360f9814dfaec3bfcbb";
        let agents: Vec<Value> = ["ab", "cd"]
            .iter()
            .map(|byte| {
                let pubkey = byte.repeat(32);
                json!({"id":format!("{pubkey}-{suffix}"), "pubkey":pubkey, "relayUrl":"wss://relay.example",
                    "name":format!("Sample {byte}"), "systemPrompt":"Original", "workspace":dir.to_str().unwrap(),
                    "harness":{"command":"buzz-agent","args":[],"model":"sample","provider":"sample"},
                    "environment":{}, "revision":1, "enabled":true, "startOnAppLaunch":true,
                    "credentialId":format!("cred-{byte}"), "authTag":null, "imported":{}})
            })
            .collect();
        let ids = agents
            .iter()
            .map(|a| a["id"].as_str().unwrap().to_owned())
            .collect();
        std::fs::write(
            dir.join("store/agents.json"),
            serde_json::to_vec(&json!({"version":1,"agents":agents})).unwrap(),
        )
        .unwrap();
        ids
    }
    fn credential(id: &str) -> String {
        format!("cred-{}", &id[..2])
    }
    fn agent<'a>(snapshot: &'a Value, id: &str) -> &'a Value {
        snapshot["agents"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["id"] == id)
            .unwrap()
    }
    async fn within<T>(task: tokio::task::JoinHandle<T>) -> T {
        tokio::time::timeout(std::time::Duration::from_secs(5), task)
            .await
            .expect("task did not finish")
            .unwrap()
    }

    #[tokio::test]
    async fn overlapping_restore_honors_intervening_stop_and_start_then_fresh_host_resets() {
        let (dir, host, _app, view) = fixture();
        let ids = seed_pair(dir.path());
        let creds: Vec<String> = ids.iter().map(|id| credential(id)).collect();
        let gate = Gate::install(&host, dir.path(), &[&creds[0], &creds[1]]);
        let queued = host.with(|h| h.controller.launch_ids()).unwrap();
        let (first, second) = (queued[0].clone(), queued[1].clone());
        let owner = host.clone();
        let restore = tokio::spawn(async move { owner.restore().await });
        // Restore waits on the first agent's credential while the user acts.
        assert_eq!(gate.entered().await, credential(&first));
        let stopped = invoke(
            &view,
            "agent_control_action",
            json!({"id":first,"action":"stop"}),
        )
        .unwrap();
        assert_eq!(agent(&stopped, &first)["enabled"], false);
        let explicit = tokio::task::spawn_blocking({
            let (view, second) = (view.clone(), second.clone());
            move || {
                invoke(
                    &view,
                    "agent_control_action",
                    json!({"id":second,"action":"start"}),
                )
            }
        });
        assert_eq!(gate.entered().await, credential(&second));
        // Late completion of the stopped restore; restore then reaches the agent
        // the user started and must neither read again nor cancel that Start.
        gate.release[&credential(&first)].send(()).unwrap();
        within(restore).await;
        assert!(
            gate.idle(),
            "restore read a credential after an explicit action"
        );
        assert!(host.with(|h| Ok(h.starts.contains_key(&second))).unwrap());
        let middle = invoke(&view, "agent_control_snapshot", json!({})).unwrap();
        assert!(agent(&middle, &first)["error"].is_null());
        assert_eq!(agent(&middle, &first)["enabled"], false);
        gate.release[&credential(&second)].send(()).unwrap();
        let started = within(explicit).await.unwrap();
        assert_eq!(agent(&started, &second)["error"], REFUSAL);
        assert!(agent(&started, &first)["error"].is_null());

        // A fresh host has no action history: both launch preferences restore.
        *host.0.lock().unwrap() = Err("retired".into());
        let fresh = AgentHost::open(Ok((
            dir.path().join("store"),
            dir.path().join("legacy"),
            dir.path().join("workspace"),
        )));
        let gate = Gate::install(&fresh, dir.path(), &[&creds[0], &creds[1]]);
        let owner = fresh.clone();
        let restore = tokio::spawn(async move { owner.restore().await });
        for id in [&first, &second] {
            assert_eq!(gate.entered().await, credential(id));
            gate.release[&credential(id)].send(()).unwrap();
        }
        within(restore).await;
        let after = fresh.with(|h| h.snapshot()).unwrap();
        let after = serde_json::to_value(after).unwrap();
        for id in [&first, &second] {
            assert_eq!(agent(&after, id)["error"], REFUSAL);
            assert_eq!(agent(&after, id)["startOnAppLaunch"], true);
        }
        fresh.shutdown().unwrap();
    }
}

#[cfg(unix)]
#[test]
fn real_ipc_start_on_app_launch_persists_reopens_and_recovers_from_write_failure() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, host, _app, view) = fixture();
    let id = seed(dir.path());
    let store = dir.path().join("store");
    let disk = || -> Value {
        serde_json::from_slice(&std::fs::read(store.join("agents.json")).unwrap()).unwrap()
    };
    let set = |enabled: bool| {
        invoke(
            &view,
            "agent_control_start_on_app_launch",
            json!({"id":id,"enabled":enabled}),
        )
    };
    // Legacy record: no explicit preference follows `enabled`.
    let before = invoke(&view, "agent_control_snapshot", json!({})).unwrap();
    assert_eq!(before["agents"][0]["startOnAppLaunch"], true);
    let off = set(false).unwrap();
    assert_eq!(off["agents"][0]["startOnAppLaunch"], false);
    assert_eq!(off["agents"][0]["enabled"], true);
    assert_eq!(off["agents"][0]["revision"], 1);
    assert_eq!(disk()["agents"][0]["startOnAppLaunch"], false);
    assert_eq!(disk()["agents"][0]["revision"], 1);
    assert!(host.with(|h| h.controller.launch_ids()).unwrap().is_empty());
    // A failed write reports an error and leaves the confirmed value.
    std::fs::set_permissions(&store, std::fs::Permissions::from_mode(0o500)).unwrap();
    let failed = set(true);
    std::fs::set_permissions(&store, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(
        failed.unwrap_err(),
        "Could not prepare agent settings write"
    );
    let current = invoke(&view, "agent_control_snapshot", json!({})).unwrap();
    assert_eq!(current["agents"][0]["startOnAppLaunch"], false);
    assert_eq!(disk()["agents"][0]["startOnAppLaunch"], false);
    assert_eq!(
        invoke(
            &view,
            "agent_control_start_on_app_launch",
            json!({"id":"missing","enabled":true})
        )
        .unwrap_err(),
        "Agent no longer exists"
    );
    let retried = set(true).unwrap();
    assert_eq!(retried["agents"][0]["startOnAppLaunch"], true);
    // A fresh host reads the persisted preference and restores from it.
    *host.0.lock().unwrap() = Err("retired".into());
    let fresh = AgentHost::open(Ok((
        store.clone(),
        dir.path().join("legacy"),
        dir.path().join("workspace"),
    )));
    let reopened = serde_json::to_value(fresh.with(|h| h.snapshot()).unwrap()).unwrap();
    assert_eq!(reopened["agents"][0]["startOnAppLaunch"], true);
    assert_eq!(reopened["agents"][0]["revision"], 1);
    assert_eq!(fresh.with(|h| h.controller.launch_ids()).unwrap(), vec![id]);
    fresh.shutdown().unwrap();
}

#[test]
fn malformed_store_does_not_prevent_native_host_construction() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("agents.json"), "RAW_SECRET_INVALID").unwrap();
    let host = AgentHost::open(Ok((
        dir.path().into(),
        dir.path().into(),
        dir.path().into(),
    )));
    let error = host.with(|h| h.snapshot()).err().unwrap();
    assert!(!error.contains("RAW_SECRET"));
    assert!(error.contains("malformed"));
    host.shutdown().unwrap();
}

#[test]
fn native_contention_fails_fast_and_quit_preserves_enabled_intent() {
    let (dir, host, _app, view) = fixture();
    seed(dir.path());
    let lock = host.0.lock().unwrap();
    assert_eq!(
        invoke(&view, "agent_control_snapshot", json!({})).unwrap_err(),
        "Another native agent operation is in progress"
    );
    drop(lock);
    assert!(invoke(&view, "agent_control_snapshot", json!({})).is_ok());
    host.shutdown().unwrap();
    let disk: Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("store/agents.json")).unwrap())
            .unwrap();
    assert_eq!(disk["agents"][0]["enabled"], true);
    for (command, body) in [
        (
            "agent_control_action",
            json!({"id":"sample","action":"stop"}),
        ),
        (
            "agent_control_import_preview",
            json!({"source":"installed","destination":"wss://chosen.example"}),
        ),
    ] {
        assert_eq!(
            invoke(&view, command, body).unwrap_err(),
            "Agent host is shutting down"
        );
    }
}

#[test]
fn legacy_guard_is_process_path_evidence_not_name_substring_or_coexistence_claim() {
    for listing in [
        " 100 /Applications/Buzz.app/Contents/MacOS/buzz-desktop",
        " 200 /checkout/target/debug/buzz-desktop",
    ] {
        assert!(refuse_legacy_listing(listing).is_err());
    }
    assert!(refuse_legacy_listing(
        "123 /tmp/buzz-agent\n456 /tmp/buzz-foundation\n789 /tmp/buzz-desktop-notes"
    )
    .is_ok());
}

#[tokio::test]
#[ignore = "requires staged immutable runtime resources; run explicitly after build-agent-runtime"]
async fn native_start_restore_disconnect_stop_and_quit_fence_late_credentials() {
    struct Delayed {
        entered: std::sync::mpsc::Sender<()>,
        release: Mutex<std::sync::mpsc::Receiver<()>>,
    }
    impl Credentials for Delayed {
        fn delete(&self, _: &str, _: &str) -> Result<(), String> {
            panic!("not a delete")
        }
        fn read_legacy(&self, _: LegacySource, _: &str) -> Result<Secret, String> {
            panic!("not an import")
        }
        fn add(&self, _: &str, _: &Secret) -> Result<(), String> {
            panic!("not a write")
        }
        fn read(&self, _: &str, _: &str) -> Result<Option<Secret>, String> {
            self.entered.send(()).unwrap();
            self.release.lock().unwrap().recv().unwrap();
            Err("Synthetic credential refusal".into())
        }
    }
    let (dir, host, _app, view) = fixture();
    let id = seed(dir.path());
    // Use the actual resource manifest when staged; no child is spawned and no
    // PlatformCredentials method is ever called by this fixture.
    let tools = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/agent-runtime");
    assert!(
        tools.join("manifest.json").is_file(),
        "Build immutable runtime resources first"
    );
    let (entered, receive) = std::sync::mpsc::channel();
    let receive = Arc::new(Mutex::new(receive));
    let (release, wait) = std::sync::mpsc::channel();
    let credentials: Arc<dyn Credentials> = Arc::new(Delayed {
        entered,
        release: Mutex::new(wait),
    });
    host.with(|h| {
        let replacement = Store::open(dir.path().join("replacement"))?;
        // Reopen the same durable fixture only after replacing/dropping its owner.
        h.controller = Controller::new(
            replacement,
            credentials.clone(),
            Err("placeholder".into()),
            dir.path().join("ownership"),
        );
        h.controller = Controller::new(
            Store::open(dir.path().join("store"))?,
            credentials.clone(),
            RuntimeBundle::new(tools),
            dir.path().join("ownership"),
        );
        h.credentials = credentials;
        h.legacy_check = || Ok(());
        Ok(())
    })
    .unwrap();
    let path = dir.path().join("store/agents.json");
    let mut saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    saved["agents"][0]["harness"]["provider"] = json!("databricks_v2");
    saved["agents"][0]["harness"]["databricks"] =
        json!({"host":"https://workspace.example", "filter":""});
    std::fs::write(path, serde_json::to_vec(&saved).unwrap()).unwrap();
    for action in ["disconnect", "stop", "quit"] {
        if action == "quit" {
            let path = dir.path().join("store/agents.json");
            let mut saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            saved["agents"][0]["enabled"] = json!(true);
            std::fs::write(path, serde_json::to_vec(&saved).unwrap()).unwrap();
            // A fresh launch has no explicit actions yet.
            host.with(|h| {
                h.acted.clear();
                Ok(())
            })
            .unwrap();
        }
        let owner = host.clone();
        let agent_id = id.clone();
        let running = tokio::spawn(async move {
            if action == "quit" {
                owner.restore().await;
                Err("restore completed".into())
            } else {
                start(owner, agent_id, Action::Start, false, None).await
            }
        });
        tokio::task::spawn_blocking({
            let receive = receive.clone();
            move || {
                receive
                    .lock()
                    .unwrap()
                    .recv_timeout(std::time::Duration::from_secs(5))
            }
        })
        .await
        .unwrap()
        .unwrap();
        if action == "quit" {
            host.shutdown().unwrap();
        } else if action == "disconnect" {
            host.disconnect("https://workspace.example").unwrap();
        } else {
            invoke(
                &view,
                "agent_control_action",
                json!({"id":id,"action":"stop"}),
            )
            .unwrap();
        }
        release.send(()).unwrap();
        assert!(running.await.unwrap().is_err());
        if action == "quit" {
            let mut state = host.0.lock().unwrap();
            let h = state.as_mut().unwrap_or_else(|_| panic!("fixture host"));
            let snapshot = h.controller.snapshot().unwrap();
            assert!(snapshot.agents[0].error.is_none());
            assert!(snapshot.agents[0].enabled);
        }
    }
}

#[test]
fn real_ipc_import_uses_selected_memory_custody_and_stays_disabled() {
    const KEY: &str = "0000000000000000000000000000000000000000000000000000000000000001";
    const PUB: &str = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    #[derive(Default)]
    struct Memory(Mutex<BTreeMap<String, String>>, Mutex<Vec<LegacySource>>);
    impl Credentials for Memory {
        fn delete(&self, id: &str, _: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(id);
            Ok(())
        }
        fn read_legacy(&self, source: LegacySource, pubkey: &str) -> Result<Secret, String> {
            assert!(matches!(source, LegacySource::Development));
            self.1.lock().unwrap().push(source);
            Secret::parse(KEY, pubkey)
        }
        fn read(&self, id: &str, pubkey: &str) -> Result<Option<Secret>, String> {
            self.0
                .lock()
                .unwrap()
                .get(id)
                .map(|v| Secret::parse(v, pubkey))
                .transpose()
        }
        fn add(&self, id: &str, key: &Secret) -> Result<(), String> {
            assert!(self
                .0
                .lock()
                .unwrap()
                .insert(id.into(), key.hex().to_string())
                .is_none());
            Ok(())
        }
    }
    let (dir, host, _app, view) = fixture();
    let source = dir.path().join("legacy/xyz.block.buzz.app.dev/agents");
    std::fs::create_dir_all(&source).unwrap();
    let bytes = serde_json::to_vec(&json!([
        {"pubkey":PUB, "relay_url":"", "name":"Selected", "agent_command":"buzz-agent", "agent_args":[], "start_on_app_launch":true},
        {"pubkey":"ab".repeat(32), "relay_url":"wss://stale.example", "name":"Not selected"},
        {"pubkey":"cd".repeat(32), "relay_url":"wss://user:secret@raw.example/path", "name":"Unsupported old pin"}
    ])).unwrap();
    std::fs::write(source.join("managed-agents.json"), &bytes).unwrap();
    let memory = Arc::new(Memory::default());
    host.with(|h| {
        h.credentials = memory.clone();
        Ok(())
    })
    .unwrap();
    // Required IPC destination: a missing argument must not use a legacy pin.
    assert!(invoke(
        &view,
        "agent_control_import_preview",
        json!({"source":"development"})
    )
    .is_err());
    let invalid = invoke(
        &view,
        "agent_control_import_preview",
        json!({"source":"development","destination":"wss://user:private@raw.example/path"}),
    )
    .unwrap_err();
    assert_eq!(
        invalid,
        "Choose a secure community origin without credentials, path or query"
    );
    let prior = invoke(
        &view,
        "agent_control_import_preview",
        json!({"source":"development","destination":"wss://prior.example"}),
    )
    .unwrap();
    let preview = invoke(
        &view,
        "agent_control_import_preview",
        json!({"source":"development","destination":"https://CHOSEN.example/"}),
    )
    .unwrap();
    assert!(invoke(
        &view,
        "agent_control_import_commit",
        json!({"token":prior["token"],"ids":[prior["candidates"][0]["id"]]})
    )
    .is_err());
    assert!(memory.1.lock().unwrap().is_empty());
    assert!(memory.0.lock().unwrap().is_empty());
    assert_eq!(preview["candidates"].as_array().unwrap().len(), 3);
    for candidate in preview["candidates"].as_array().unwrap() {
        assert_eq!(candidate["relayUrl"], "wss://chosen.example");
    }
    for hidden in ["raw.example", "stale.example", "user:secret", KEY] {
        assert!(!preview.to_string().contains(hidden));
    }
    let selected = preview["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["pubkey"] == PUB)
        .unwrap();
    let imported = invoke(
        &view,
        "agent_control_import_commit",
        json!({"token":preview["token"],"ids":[selected["id"]]}),
    )
    .unwrap();
    assert_eq!(imported["agents"].as_array().unwrap().len(), 1);
    assert_eq!(imported["agents"][0]["pubkey"], PUB);
    assert_eq!(imported["agents"][0]["relayUrl"], "wss://chosen.example");
    assert_eq!(imported["agents"][0]["id"], selected["id"]);
    assert!(memory
        .0
        .lock()
        .unwrap()
        .contains_key(selected["id"].as_str().unwrap()));
    assert_eq!(imported["agents"][0]["enabled"], false);
    assert_eq!(imported["agents"][0]["status"], "stopped");
    assert!(!imported.to_string().contains(KEY));
    assert_eq!(memory.1.lock().unwrap().len(), 1);
    assert_eq!(
        std::fs::read(source.join("managed-agents.json")).unwrap(),
        bytes
    );
    assert!(invoke(
        &view,
        "agent_control_import_commit",
        json!({"token":preview["token"],"ids":[selected["id"]]})
    )
    .is_err());
    host.shutdown().unwrap();
}

// The log path must pass the generated desktop ACL, not the permissive mock context.
fn log_acl_fixture() -> (
    tempfile::TempDir,
    AgentHost,
    tauri::App<MockRuntime>,
    tauri::WebviewWindow<MockRuntime>,
) {
    let dir = tempfile::tempdir().unwrap();
    let host = AgentHost::open(Ok((
        dir.path().join("store"),
        dir.path().join("legacy"),
        dir.path().join("workspace"),
    )));
    let app = mock_builder()
        .manage(host.clone())
        .manage(crate::agent_models::ModelHost::new(Ok(dir
            .path()
            .join("store"))))
        .invoke_handler(crate::commands())
        .build(crate::app_context())
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    (dir, host, app, view)
}

#[test]
fn log_ipc_requires_fresh_exact_owner_proof_and_consumes_challenge() {
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use sha2::{Digest, Sha256};
    let (dir, host, _app, view) = log_acl_fixture();
    let key = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    let relay = "wss://relay.example";
    let id = format!("{key}-{:x}", Sha256::digest(relay.as_bytes()));
    let secp = Secp256k1::new();
    let mut owner_bytes = [0; 32];
    owner_bytes[31] = 2;
    let owner = Keypair::from_secret_key(&secp, &SecretKey::from_byte_array(owner_bytes).unwrap());
    let tag_digest = Sha256::digest(format!("nostr:agent-auth:{key}:"));
    let tag = serde_json::to_string(&[
        "auth",
        &owner.x_only_public_key().0.to_string(),
        "",
        &secp
            .sign_schnorr_no_aux_rand(&tag_digest, &owner)
            .to_string(),
    ])
    .unwrap();
    let row = |auth: Option<&str>| json!({"id":id,"pubkey":key,"relayUrl":relay,"name":"Fixture","systemPrompt":"","workspace":dir.path().to_str().unwrap(),"harness":{"command":"buzz-agent","args":[],"model":"","provider":""},"environment":{},"revision":1,"enabled":false,"credentialId":"fixture","authTag":auth,"imported":{}});
    let store = dir.path().join("store/agents.json");
    std::fs::write(
        &store,
        serde_json::to_vec(&json!({"version":1,"agents":[row(None)]})).unwrap(),
    )
    .unwrap();
    let target = json!({"id":id,"pubkey":key,"relayUrl":relay});
    assert!(invoke(&view, "agent_control_log_challenge", target.clone()).is_err());
    std::fs::write(
        &store,
        serde_json::to_vec(&json!({"version":1,"agents":[row(Some(&tag))]})).unwrap(),
    )
    .unwrap();
    for bad in [
        json!({"id":format!("{}-{}", "a".repeat(64), "b".repeat(64)),"pubkey":key,"relayUrl":relay}),
        json!({"id":id,"pubkey":key,"relayUrl":"wss://elsewhere.example"}),
    ] {
        assert!(invoke(&view, "agent_control_log_challenge", bad).is_err());
    }
    let challenge = || {
        invoke(&view, "agent_control_log_challenge", target.clone())
            .unwrap()
            .as_str()
            .unwrap()
            .to_string()
    };
    let proof = |nonce: &str, id: &str, relay: &str, pair: &Keypair| {
        let digest = Sha256::digest(format!(
            "buzz-app:harness-log:v1:{id}:{key}:{relay}:{nonce}"
        ));
        secp.sign_schnorr_no_aux_rand(&digest, pair).to_string()
    };
    let read = |nonce: &str, sig: &str, id: &str, relay: &str| {
        invoke(
            &view,
            "agent_control_read_log",
            json!({"id":id,"pubkey":key,"relayUrl":relay,"nonce":nonce,"signature":sig}),
        )
    };
    let nonce = challenge();
    let signature = proof(&nonce, &id, relay, &owner);
    assert_eq!(read(&nonce, &signature, &id, relay).unwrap(), "");
    assert!(read(&nonce, &signature, &id, relay).is_err());
    let nonce = challenge();
    assert!(read(
        &nonce,
        &proof(&nonce, &id, relay, &owner),
        &id,
        "wss://elsewhere.example"
    )
    .is_err());
    assert!(read(&nonce, &proof(&nonce, &id, relay, &owner), &id, relay).is_err());
    let nonce = challenge();
    assert!(read(
        &nonce,
        &proof(&nonce, &id, relay, &owner),
        "wrong-id",
        relay
    )
    .is_err());
    let nonce = challenge();
    let mut wrong_bytes = [0; 32];
    wrong_bytes[31] = 1;
    let wrong_owner =
        Keypair::from_secret_key(&secp, &SecretKey::from_byte_array(wrong_bytes).unwrap());
    assert!(read(&nonce, &proof(&nonce, &id, relay, &wrong_owner), &id, relay).is_err());
    assert!(read(&nonce, &proof(&nonce, &id, relay, &owner), &id, relay).is_err());
    let nonce = challenge();
    host.with(|h| {
        h.log_challenges.get_mut(&nonce).unwrap().issued -= std::time::Duration::from_secs(21);
        Ok(())
    })
    .unwrap();
    assert!(read(&nonce, &proof(&nonce, &id, relay, &owner), &id, relay).is_err());
    assert!(read(&nonce, &proof(&nonce, &id, relay, &owner), &id, relay).is_err());
    let nonce = challenge();
    let second = challenge();
    assert_ne!(nonce, second);
    assert_eq!(
        read(&second, &proof(&second, &id, relay, &owner), &id, relay).unwrap(),
        ""
    );
    assert_eq!(
        read(&nonce, &proof(&nonce, &id, relay, &owner), &id, relay).unwrap(),
        ""
    );
    assert!(read(&second, &proof(&second, &id, relay, &owner), &id, relay).is_err());
    assert!(read(&nonce, &proof(&nonce, &id, relay, &owner), &id, relay).is_err());
    let pending: Vec<_> = (0..4).map(|_| challenge()).collect();
    assert!(invoke(&view, "agent_control_log_challenge", target).is_err());
    assert_eq!(
        read(
            &pending[0],
            &proof(&pending[0], &id, relay, &owner),
            &id,
            relay
        )
        .unwrap(),
        ""
    );
}
