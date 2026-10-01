//! Opt-in real listeners + enforcing provider. Disposable relay and synthetic workers.
use super::*;
use crate::security::{Binding, Request};
use std::os::unix::fs::PermissionsExt;
#[path = "protection_relay.rs"]
mod relay;

struct LogsOnFailure(PathBuf);
impl Drop for LogsOnFailure {
    fn drop(&mut self) {
        if std::thread::panicking() {
            for entry in fs::read_dir(self.0.join("logs"))
                .into_iter()
                .flatten()
                .flatten()
            {
                eprintln!("{}", fs::read_to_string(entry.path()).unwrap_or_default());
            }
        }
    }
}
// Real engine bootstrap and ACP's retry backoff are bounded by this integration
// deadline; each step still waits for its explicit completion signal.
fn wait<T>(path: &Path, parse: impl Fn(&str) -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(value) = fs::read_to_string(path).ok().and_then(|text| parse(&text)) {
            return value;
        }
        assert!(Instant::now() < deadline, "fixture did not reach {path:?}");
        std::thread::sleep(Duration::from_millis(10));
    }
}
struct Gate {
    token: PathBuf,
    pid: i32,
}
impl Gate {
    fn accept(work: &Path, previous: Option<&Gate>) -> Self {
        wait(&work.join("ready.json"), |text| {
            let value: serde_json::Value = serde_json::from_str(text).ok()?;
            let token = work.join(value["token"].as_str()?);
            if previous.is_some_and(|p| p.token == token) {
                return None;
            }
            Some(Self {
                token,
                pid: value["pid"].as_i64()? as i32,
            })
        })
    }
    fn check(&self) {
        fs::write(self.token.with_extension("probe"), "").unwrap();
        wait(&self.token.with_extension("checked"), |_| Some(()));
    }
    fn finish(&self) {
        fs::write(self.token.with_extension("reply"), "").unwrap();
    }
}
struct LiveRun {
    process: Supervised,
    control: PathBuf,
    scratch: PathBuf,
    log: PathBuf,
}
impl LiveRun {
    fn completed(&self, count: usize) {
        wait(&self.log, |text| {
            let text = strip_ansi_escapes::strip_str(text);
            (text
                .lines()
                .filter(|line| line.contains("agent_returned") && line.contains("outcome=\"ok\""))
                .count()
                == count)
                .then_some(())
        });
    }
}
fn start(controller: &Controller, agent: &Agent, secret: &Secret, relay: &str) -> LiveRun {
    let config = controller.store.root();
    crate::connection::oauth_root(config).unwrap();
    let runs = config.join("runs");
    crate::connection::private_directory(&runs).unwrap();
    let temporary = tempfile::tempdir_in(&runs).unwrap();
    let scratch = temporary.path().join("tmp");
    fs::create_dir(&scratch).unwrap();
    let mut command = controller
        .bundle
        .as_ref()
        .unwrap()
        .command(agent, secret)
        .unwrap();
    // App records require secure origins. Only this disposable fixture uses a
    // loopback plaintext transport; the real ACP binary/launch path is unchanged.
    command
        .env("RUST_LOG", "buzz_acp=debug")
        .env("BUZZ_RELAY_URL", relay)
        .env("BUZZ_AGENT_CONFIG_DIR", config)
        .env("TMPDIR", &scratch)
        .env("TMP", &scratch)
        .env("TEMP", &scratch);
    let control = controller
        .wrap_protected_worker(agent, &mut command)
        .unwrap()
        .unwrap();
    let log = crate::logs::path(config, &agent.id).unwrap();
    let scratch = temporary.keep();
    let control = control.keep();
    let process = Supervised::spawn(
        &command,
        &controller.ownership_root,
        &agent.id,
        &scratch,
        Some(&control),
        &log,
    )
    .unwrap();
    LiveRun {
        process,
        control,
        scratch,
        log,
    }
}
fn probe(
    work: &Path,
    config: &Path,
    scratch: &Path,
    own: &Path,
    peer: &Path,
    controller: &Controller,
) {
    let mut files = vec![];
    for run in [own, peer] {
        files.extend([run.join("launch-protection.json"), run.join("launcher")]);
    }
    files.extend(
        controller
            .store
            .protected_control_paths()
            .into_iter()
            .filter(|p| !p.is_dir()),
    );
    // Missing store controls must be protected too; existing files exercise chmod/unlink.
    let directories = vec![
        controller.ownership_root.clone(),
        own.to_path_buf(),
        peer.to_path_buf(),
        config.join("run-controls"),
        config.join("control-write"),
    ];
    fs::write(
        work.join("probe.json"),
        serde_json::to_vec(
            &json!({"config":config,"scratch":scratch,"files":files,"directories":directories}),
        )
        .unwrap(),
    )
    .unwrap();
}

#[test]
#[ignore = "requires prepared runtime and BUZZ_TEST_PROTECTION_LAUNCHER/POLICY"]
fn real_listeners_protect_future_run_controls_and_recover_worker_crashes() {
    let resources =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../src-tauri/resources/agent-runtime");
    let runtime = RuntimeBundle::new(resources.canonicalize().unwrap()).unwrap();
    let launcher = PathBuf::from(std::env::var_os("BUZZ_TEST_PROTECTION_LAUNCHER").unwrap());
    let policy: serde_json::Value =
        serde_json::from_str(&std::env::var("BUZZ_TEST_PROTECTION_POLICY").unwrap()).unwrap();
    let provider = tempfile::tempdir().unwrap();
    for entry in fs::read_dir(launcher.parent().unwrap()).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_file() {
            fs::copy(entry.path(), provider.path().join(entry.file_name())).unwrap();
        }
    }
    let launcher = provider.path().join(launcher.file_name().unwrap());
    let root = tempfile::tempdir().unwrap();
    let public_b = relay::public_key(3);
    let relay = relay::Relay::new(&[PUB.into(), public_b.clone()]);
    let config = root.path().join("config");
    let _logs = LogsOnFailure(config.clone());
    let mut store = Store::open(config.clone()).unwrap();
    let work_a = root.path().join("a");
    let work_b = root.path().join("b");
    let mut agents = Vec::new();
    for (work, public) in [(&work_a, PUB), (&work_b, &public_b)] {
        fs::create_dir(work).unwrap();
        let worker = work.join("goose");
        fs::write(&worker, include_str!("protection_worker.py")).unwrap();
        fs::set_permissions(&worker, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(work.join("probe.json"), json!({}).to_string()).unwrap();
        let mut saved = agent(work);
        saved.pubkey = public.into();
        saved.relay_url = relay.url.replacen("ws://", "wss://", 1);
        saved.id = agent_id(public, &saved.relay_url);
        saved.auth_tag = Some(crate::secret::test_attestation(public));
        saved.harness.command = worker.to_str().unwrap().into();
        saved.harness.args.clear();
        saved.harness.model.clear();
        saved.harness.provider.clear();
        saved.imported = json!({"record":{"respond_to":"owner-only","parallelism":1}});
        saved.extra.insert(
            "launchProtection".into(),
            serde_json::to_value(Binding {
                provider: "test.enforcing".into(),
                policy: policy.clone(),
            })
            .unwrap(),
        );
        agents.push(saved);
    }
    store.insert(agents.clone()).unwrap();
    let mut controller = Controller::new(
        store,
        Arc::new(Memory),
        Ok(runtime),
        root.path().join("ownership"),
    );
    controller
        .security(Request::Register {
            provider: "test.enforcing".into(),
            executable: launcher.clone(),
        })
        .unwrap();
    let mut run_a = start(
        &controller,
        &agents[0],
        &Secret::parse(KEY, PUB).unwrap(),
        &relay.url,
    );
    relay.online(PUB);
    assert!(!work_a.join("initialized").exists());
    relay.mention(PUB, "first probe");
    let a = Gate::accept(&work_a, None); // A's enforcing policy is active BEFORE B exists.
    let control_a = run_a.control.clone();
    assert_eq!(
        fs::read_dir(config.join("run-controls")).unwrap().count(),
        1
    );
    let secret_b = Secret::parse(&format!("{:064x}", 3), &public_b).unwrap();
    let mut run_b = start(&controller, &agents[1], &secret_b, &relay.url);
    relay.online(&public_b);
    assert!(!work_b.join("initialized").exists());
    let control_b = run_b.control.clone();
    let scratch_a = run_a.scratch.clone();
    let scratch_b = run_b.scratch.clone();
    let snapshots: Vec<_> = [&control_a, &control_b]
        .into_iter()
        .flat_map(|dir| [dir.join("launcher"), dir.join("launch-protection.json")])
        .map(|path| {
            let bytes = fs::read(&path).unwrap();
            (path, bytes)
        })
        .collect();
    // Both listeners are alive. B has not launched a worker. The mutable source
    // now fails, so first startup and crash replacement must use staged bytes.
    fs::write(&launcher, "#!/bin/sh\nexit 99\n").unwrap();
    probe(
        &work_a,
        &config,
        &scratch_a.join("tmp"),
        &control_a,
        &control_b,
        &controller,
    );
    probe(
        &work_b,
        &config,
        &scratch_b.join("tmp"),
        &control_b,
        &control_a,
        &controller,
    );
    a.check();
    a.finish();
    wait(&work_a.join("completed"), |s| (!s.is_empty()).then_some(()));
    run_a.completed(1);
    relay.mention(&public_b, "crash probe");
    let b = Gate::accept(&work_b, None);
    b.check();
    // Kill the real worker during an outstanding prompt, keeping its listener.
    assert_eq!(unsafe { libc::kill(b.pid, libc::SIGKILL) }, 0);
    let recovered = Gate::accept(&work_b, Some(&b));
    assert_ne!(recovered.pid, b.pid);
    recovered.check();
    recovered.finish();
    wait(&work_b.join("completed"), |s| {
        (s.lines().count() == 1).then_some(())
    });
    run_b.completed(1);
    relay.mention(&public_b, "post recovery probe");
    let later = Gate::accept(&work_b, Some(&recovered));
    later.check();
    later.finish();
    wait(&work_b.join("completed"), |s| {
        (s.lines().count() == 2).then_some(())
    });
    run_b.completed(2);
    for (path, bytes) in snapshots {
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
    controller
        .store
        .enabled(&agents[0].id, agents[0].enabled)
        .unwrap();
    run_a.process.stop().unwrap();
    assert!(!control_a.exists() && !scratch_a.exists());
    assert!(control_b.exists() && scratch_b.exists());
    run_b.process.stop().unwrap();
    assert!(!control_b.exists() && !scratch_b.exists());
    for work in [work_a, work_b] {
        assert!(config
            .join("buzz-agent/oauth/databricks")
            .join(work.file_name().unwrap())
            .with_extension("json")
            .exists());
    }
}
