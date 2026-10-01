//! Native lifecycle: the listener tree lives in the guardian's job, and the
//! guardian keeps ownership and temp storage until that job is empty.
use super::*;
use std::fs;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::time::Instant;
use windows_sys::Win32::Foundation::{INVALID_HANDLE_VALUE, WAIT_OBJECT_0};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, OpenThread, ResumeThread, SuspendThread, TerminateProcess,
    WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    THREAD_SUSPEND_RESUME,
};

const ID: &str = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798-79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

/// cmd root -> PowerShell listener -> ping worker. The root first runs short
/// cmd children whose handles it closes as they exit, so Stop must have opened
/// them as they joined. The listener logs a line, records both IDs, and exits
/// only once `exit` appears; the worker outlives it.
fn listener(root: &Path) -> Command {
    fs::write(
        root.join("listener.ps1"),
        r#"[Console]::Out.WriteLine('listener-ready'); [Console]::Out.Flush()
$worker = Start-Process -PassThru -NoNewWindow "$env:SystemRoot\System32\PING.EXE" '-n 600 127.0.0.1'
Set-Content -LiteralPath "$PSScriptRoot\worker.tmp" -Value "$PID $($worker.Id)"
Rename-Item -LiteralPath "$PSScriptRoot\worker.tmp" -NewName worker
while (-not (Test-Path -LiteralPath "$PSScriptRoot\exit")) { Start-Sleep -Milliseconds 20 }
"#,
    )
    .unwrap();
    fs::write(
        root.join("listener.cmd"),
        "@for /l %%i in (1,1,5) do @\"%SystemRoot%\\System32\\cmd.exe\" /d /c exit\r\n@\"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"%~dp0listener.ps1\"\r\n",
    )
    .unwrap();
    let mut command = Command::new(root.join("listener.cmd"));
    command.current_dir(root).envs(std::env::vars_os());
    command
}

/// A process handle; dropping it terminates the process so failures never leak.
struct Proc(OwnedHandle);
impl Proc {
    fn open(pid: u32) -> Self {
        let access = PROCESS_SYNCHRONIZE | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION;
        let handle = unsafe { OpenProcess(access, 0, pid) };
        assert!(!handle.is_null(), "process {pid} is not running");
        Self(unsafe { OwnedHandle::from_raw_handle(handle) })
    }
    fn exited(&self) -> bool {
        unsafe { WaitForSingleObject(self.0.as_raw_handle(), 0) == WAIT_OBJECT_0 }
    }
    fn exit_code(&self) -> u32 {
        let waited = unsafe { WaitForSingleObject(self.0.as_raw_handle(), 30_000) };
        assert_eq!(waited, WAIT_OBJECT_0, "process did not exit");
        let mut code = 0;
        assert_ne!(
            unsafe { GetExitCodeProcess(self.0.as_raw_handle(), &mut code) },
            0
        );
        code
    }
}
impl Drop for Proc {
    fn drop(&mut self) {
        unsafe { TerminateProcess(self.0.as_raw_handle(), 1) };
    }
}

fn read(path: &Path) -> String {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Ok(text) = fs::read_to_string(path) {
            return text;
        }
        assert!(Instant::now() < deadline, "fixture did not reach {path:?}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn tree(root: &Path) -> (Proc, Proc) {
    let text = read(&root.join("worker"));
    let (listener, worker) = text.trim().split_once(' ').unwrap();
    (
        Proc::open(listener.parse().unwrap()),
        Proc::open(worker.parse().unwrap()),
    )
}

/// Suspend every guardian thread so fast cleanup cannot pass the order check by luck.
fn freeze(pid: u32) -> Vec<OwnedHandle> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    assert_ne!(snapshot, INVALID_HANDLE_VALUE);
    let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
    let mut entry = THREADENTRY32 {
        dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    let mut threads = Vec::new();
    let mut more = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) } != 0;
    while more {
        if entry.th32OwnerProcessID == pid {
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            assert!(!thread.is_null());
            let thread = unsafe { OwnedHandle::from_raw_handle(thread) };
            assert_ne!(unsafe { SuspendThread(thread.as_raw_handle()) }, u32::MAX);
            threads.push(thread);
        }
        more = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) } != 0;
    }
    assert!(!threads.is_empty());
    threads
}

#[test]
fn parent_entrypoint() {
    let Some(dir) = std::env::var_os("BUZZ_SUPERVISOR_PARENT_TEST") else {
        return;
    };
    let dir = Path::new(&dir);
    let run = Supervised::spawn(
        &listener(dir),
        &dir.join("locks"),
        ID,
        &dir.join("temp"),
        None,
        &dir.join("harness.log"),
    )
    .unwrap();
    fs::write(dir.join("ready.tmp"), run.child.id().to_string()).unwrap();
    fs::rename(dir.join("ready.tmp"), dir.join("ready")).unwrap();
    loop {
        std::thread::park();
    }
}

#[test]
fn app_death_keeps_lock_through_listener_tree_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::create_dir(root.join("temp")).unwrap();
    let mut parent = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "supervisor::windows_tests::parent_entrypoint",
            "--nocapture",
        ])
        .env("BUZZ_SUPERVISOR_PARENT_TEST", root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let app = Proc::open(parent.id());
    let guardian_pid: u32 = read(&root.join("ready")).parse().unwrap();
    let guardian = Proc::open(guardian_pid);
    let (listener, worker) = tree(root);
    let frozen = freeze(guardian_pid);
    drop(app); // TerminateProcess: the app dies without Stop.
    parent.wait().unwrap();
    assert!(Ownership::acquire(&root.join("locks"), ID).is_err());
    assert!(
        !guardian.exited(),
        "guardian died with the tested launch context"
    );
    assert!(
        !worker.exited(),
        "listener tree did not belong to the guardian"
    );
    for thread in frozen {
        assert_ne!(unsafe { ResumeThread(thread.as_raw_handle()) }, u32::MAX);
    }
    // Exit 0 means serve() confirmed an empty job and removed temp storage.
    assert_eq!(guardian.exit_code(), 0, "guardian did not complete cleanup");
    assert!(listener.exited() && worker.exited());
    assert!(!root.join("temp").exists());
    let _lock = Ownership::acquire(&root.join("locks"), ID).unwrap();
}

#[test]
fn stop_and_root_exit_end_the_listener_tree_before_release() {
    for stop in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let temp = root.join("temp");
        fs::create_dir(&temp).unwrap();
        let mut run = Supervised::spawn(
            &listener(root),
            &root.join("locks"),
            ID,
            &temp,
            None,
            &root.join("harness.log"),
        )
        .unwrap();
        let (listener, worker) = tree(root);
        if stop {
            run.stop().unwrap();
        } else {
            fs::write(root.join("exit"), b"").unwrap();
            let deadline = Instant::now() + Duration::from_secs(30);
            while run.alive().unwrap() {
                assert!(Instant::now() < deadline, "exited listener was not reaped");
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        assert!(listener.exited() && worker.exited(), "descendant survived");
        assert!(!temp.exists());
        let log = fs::read_to_string(root.join("harness.log")).unwrap();
        assert!(
            log.contains("listener-ready"),
            "listener output was not captured"
        );
        let _lock = Ownership::acquire(&root.join("locks"), ID).unwrap();
    }
}
