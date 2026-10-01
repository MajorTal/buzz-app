//! Device-local Harnesses setup. Never run installers in a webview or accept a command from IPC.
use crate::agents::AgentHost;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use crate::agents::{self, InstallRestart};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use buzz_agent_controller::Action;
use buzz_agent_controller::ProcessStatus;
use serde::Serialize;
#[cfg(any(target_os = "macos", target_os = "linux", test))]
use std::fs::{File, OpenOptions};
#[cfg(any(target_os = "macos", target_os = "linux", test))]
use std::future::Future;
use std::path::Path;
#[cfg(any(target_os = "macos", target_os = "linux", test))]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use tauri::Manager as _;

/// App-lifetime install owner: one install at a time, and the running installer's
/// process group so normal Quit can stop it (Tauri exits without dropping futures).
#[cfg(any(target_os = "macos", target_os = "linux", test))]
#[derive(Default)]
pub(crate) struct HarnessSetup(AtomicBool, std::sync::Mutex<InstallProcess>);
#[cfg(any(target_os = "macos", target_os = "linux", test))]
#[derive(Default)]
struct InstallProcess {
    shutting_down: bool,
    group: Option<u32>,
}
#[cfg(not(any(target_os = "macos", target_os = "linux", test)))]
#[derive(Default)]
pub(crate) struct HarnessSetup {}
#[cfg(not(any(target_os = "macos", target_os = "linux", test)))]
impl HarnessSetup {
    pub(crate) fn shutdown(&self) {}
}
#[cfg(any(target_os = "macos", target_os = "linux", test))]
struct InstallGuard<'a>(&'a HarnessSetup);
#[cfg(any(target_os = "macos", target_os = "linux", test))]
impl Drop for InstallGuard<'_> {
    fn drop(&mut self) {
        self.0 .0.store(false, Ordering::Release);
    }
}
#[cfg(any(target_os = "macos", target_os = "linux", test))]
impl HarnessSetup {
    fn claim(&self) -> Result<InstallGuard<'_>, String> {
        self.0
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "A Harness installation is already in progress".to_owned())?;
        let guard = InstallGuard(self);
        if self
            .1
            .lock()
            .map_err(|_| "Harness install state is unavailable")?
            .shutting_down
        {
            return Err("Buzz is quitting".into());
        }
        Ok(guard)
    }
    /// Quit either prevents spawning or observes the registered process group.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(crate) fn spawn(
        &self,
        spawn: impl FnOnce() -> std::io::Result<tokio::process::Child>,
    ) -> Result<InstallerChild<'_>, String> {
        let mut state = self
            .1
            .lock()
            .map_err(|_| "Harness install state is unavailable")?;
        if state.shutting_down {
            return Err("Buzz is quitting".into());
        }
        let child = spawn().map_err(|_| "Could not start the Harness installer".to_owned())?;
        let group = child.id();
        state.group = Some(group.ok_or("Could not start the Harness installer")?);
        Ok(InstallerChild {
            child,
            group,
            setup: self,
            reaped: false,
        })
    }
    fn untrack(&self, group: u32, kill: bool) {
        if let Ok(mut state) = self.1.lock() {
            if state.group == Some(group) {
                // Serialize clearing and signalling with shutdown: it must not
                // signal the same (potentially reused) group a second time.
                if kill {
                    kill_group(group);
                }
                state.group = None;
            }
        }
    }
    /// Normal-Quit cleanup: stop the active installer and fence later spawns.
    pub(crate) fn shutdown(&self) {
        if let Ok(mut state) = self.1.lock() {
            state.shutting_down = true;
            if let Some(group) = state.group.take() {
                kill_group(group);
            }
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux", test))]
fn kill_group(group: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(group as i32), libc::SIGKILL);
    }
    #[cfg(not(unix))]
    let _ = group; // Non-Unix unit tests exercise bookkeeping, not process signalling.
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallReport {
    pub(crate) ready: bool,
    pub(crate) restarted: usize,
    pub(crate) restart_failures: usize,
    pub(crate) log_path: String,
    pub(crate) output: String,
    pub(crate) error: Option<String>,
}

#[cfg(any(target_os = "macos", target_os = "linux", test))]
fn open_log(path: &Path) -> Result<File, String> {
    std::fs::create_dir_all(path.parent().ok_or("Invalid install log location")?)
        .map_err(|_| "Could not create the Harnesses install log directory")?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|_| "Could not open the Harnesses install log".into())
}

#[cfg(any(target_os = "macos", target_os = "linux", test))]
async fn run_install<F, Fut>(path: &Path, installer: F) -> Result<InstallReport, String>
where
    F: FnOnce(File) -> Fut,
    Fut: Future<Output = Result<bool, String>>,
{
    let log = open_log(path)?;
    let status = installer(log).await;
    if let Err(message) = &status {
        use std::io::Write;
        let mut file = OpenOptions::new()
            .append(true)
            .open(path)
            .map_err(|_| "Could not write to the Harnesses install log")?;
        writeln!(file, "\n{message}")
            .map_err(|_| "Could not write to the Harnesses install log")?;
    }
    use std::io::{Read, Seek, SeekFrom};
    let mut file = File::open(path).map_err(|_| "Could not read the Harnesses install log")?;
    let length = file
        .metadata()
        .map_err(|_| "Could not read the Harnesses install log")?
        .len();
    file.seek(SeekFrom::Start(length.saturating_sub(8192)))
        .map_err(|_| "Could not read the Harnesses install log")?;
    let mut tail = Vec::new();
    file.take(8192)
        .read_to_end(&mut tail)
        .map_err(|_| "Could not read the Harnesses install log")?;
    let error = match status {
        Ok(true) => None,
        Ok(false) => Some("Harness installer failed. See the install log.".to_owned()),
        Err(message) => Some(message),
    };
    Ok(InstallReport {
        ready: error.is_none(),
        restarted: 0,
        restart_failures: 0,
        log_path: path.to_string_lossy().into_owned(),
        output: String::from_utf8_lossy(&tail).into_owned(),
        error,
    })
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) struct InstallerChild<'a> {
    pub(crate) child: tokio::process::Child,
    group: Option<u32>,
    setup: &'a HarnessSetup,
    pub(crate) reaped: bool,
}
#[cfg(any(target_os = "macos", target_os = "linux"))]
impl Drop for InstallerChild<'_> {
    fn drop(&mut self) {
        if let Some(group) = self.group {
            // A reaped leader's pgid may already have been reused. Bash waits
            // for its curl|bash pipeline; only pending/cancelled work needs kill.
            self.setup.untrack(group, !self.reaped);
        }
        if !self.reaped {
            let _ = self.child.start_kill();
        }
    }
}

pub(crate) fn waiting_for_pi(agent: &buzz_agent_controller::AgentView) -> bool {
    waiting(
        agent.enabled,
        agent.status,
        &agent.harness.command,
        "buzz-pi-acp",
        agent.error.as_deref(),
    )
}

fn waiting(
    enabled: bool,
    status: ProcessStatus,
    command: &str,
    name: &str,
    error: Option<&str>,
) -> bool {
    if !enabled || status != ProcessStatus::Failed {
        return false;
    }
    if Path::new(command)
        .file_name()
        .and_then(|name| name.to_str())
        != Some(name)
    {
        return false;
    }
    // Only a start that failed on the missing CLI was waiting. Stopped agents are
    // indistinguishable from ones the person chose not to run this session, and a
    // relative command still fails after install.
    error == Some("Required runtime executable is missing")
}

#[tauri::command]
pub(crate) async fn pi_install<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, HarnessSetup>,
    agents: tauri::State<'_, AgentHost>,
) -> Result<InstallReport, String> {
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (app, state, agents);
        Err("Pi installation is supported only on macOS and Linux".into())
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let _guard = state.claim()?;
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|_| "Could not resolve Pi install storage")?;
        if ["pi", "buzz-pi-acp", "node"]
            .iter()
            .all(|name| buzz_agent_controller::installed(name).is_some())
        {
            return Err(
                "Pi is installed user-globally; update it with npm, then click Check again".into(),
            );
        }
        let waiting = agents.waiting_for_pi().await?;
        let path = app_data.join("agent-controller/pi-install.log");
        let mut report = run_install(&path, |log| {
            crate::managed_pi::install(state.inner(), &app_data, log)
        })
        .await?;
        if !report.ready {
            return Ok(report);
        }
        if buzz_agent_controller::managed_tool(&app_data, "pi").is_none()
            || buzz_agent_controller::managed_tool(&app_data, "buzz-pi-acp").is_none()
            || buzz_agent_controller::managed_tool(&app_data, "node").is_none()
        {
            report.ready = false;
            report.error =
                Some("Pi install finished but its tools were not found. See the log.".into());
            return Ok(report);
        }
        for id in waiting {
            match agents::start(
                agents.inner().clone(),
                id.clone(),
                Action::Restart,
                false,
                None,
                Some(InstallRestart::Pi),
            )
            .await
            {
                Err(error) if error == agents::NOT_WAITING_FOR_PI => continue,
                Ok(snapshot)
                    if snapshot
                        .data
                        .agents
                        .iter()
                        .any(|agent| agent.id == id && agent.status == ProcessStatus::Running) =>
                {
                    report.restarted += 1
                }
                _ => report.restart_failures += 1,
            }
        }
        Ok(report)
    }
}

#[cfg(test)]
#[path = "harness_setup/tests.rs"]
mod tests;
