//! One private, execed process owns the identity lock and entire listener session
//! through confirmed cleanup, including after the GUI exits abruptly.
use crate::ownership::Ownership;
use crate::process::Process;
use crate::Result;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::Duration;
#[cfg(windows)]
mod pipe;
#[cfg(windows)]
use pipe::{channel, inherited, log_channel, peek, Channel};
#[cfg(unix)]
use unix::{channel, inherited, log_channel, peek, Channel};

pub const MODE: &str = "--buzz-agent-session-supervisor";

/// Dispatch before Tauri is constructed. Credentials are never passed on argv.
pub fn dispatch() -> bool {
    let mut args = std::env::args_os();
    args.next();
    if args.next().as_deref() != Some(std::ffi::OsStr::new(MODE)) {
        return false;
    }
    let (Some(root), Some(id), Some(temp), Some(runtime), Some(log), None) = (
        args.next(),
        args.next(),
        args.next(),
        args.next(),
        args.next(),
        args.next(),
    ) else {
        std::process::exit(1);
    };
    // The connected channel occupies stdin; stdout/stderr stay closed.
    let Ok(socket) = inherited() else {
        let _ = std::fs::remove_dir_all(&temp);
        std::process::exit(1);
    };
    let result = serve(
        socket,
        Path::new(&root),
        &id.to_string_lossy(),
        Path::new(&temp),
        Path::new(&runtime),
        Path::new(&log),
    );
    std::process::exit(if result.is_ok() { 0 } else { 1 });
}

pub(crate) fn serve(
    mut socket: Channel,
    root: &Path,
    id: &str,
    temp: &Path,
    runtime: &Path,
    log: &Path,
) -> Result<()> {
    let _ownership = match Ownership::acquire(root, id) {
        Ok(lock) => lock,
        Err(error) => {
            let _ = std::fs::remove_dir_all(temp);
            let _ = socket.write_all(if error.starts_with("Another buzz-app profile") {
                b"O"
            } else {
                b"E"
            });
            return Err(error);
        }
    };
    if socket
        .set_read_timeout(Some(Duration::from_millis(100)))
        .is_err()
    {
        let _ = std::fs::remove_dir_all(temp);
        let _ = socket.write_all(b"E");
        return Err("Could not watch app lifetime".into());
    }
    let mut spawned = false;
    let result = (|| {
        let mut writer = crate::logs::Writer::new(log)?;
        let (mut reader, stdout, stderr) =
            log_channel().map_err(|_| "Could not capture harness log")?;
        let mut command = Command::new(runtime);
        command.stdin(Stdio::null()).stdout(stdout).stderr(stderr);
        // Windows cannot run the sh listener fixture; its stand-in is a copy of
        // the test binary running only runtime::tests::windows_listener.
        #[cfg(all(test, windows))]
        command.args(["--exact", "runtime::tests::windows_listener", "--nocapture"]);
        let mut process = match Process::spawn(&mut command) {
            Ok(process) => process,
            Err(error) => {
                let _ = std::fs::remove_dir_all(temp);
                return Err(error);
            }
        };
        drop(command);
        spawned = true;
        // Arming boundary: lock and listener exist before Start is acknowledged.
        let _ = socket.write_all(b"R");
        let mut input = [0u8; 1];
        loop {
            // A logging failure must not strand the owned listener. Teardown
            // still runs on the same path as Stop and app death.
            if drain_log(&mut reader, &mut writer, true).is_err() {
                break;
            }
            match socket.read(&mut input) {
                Ok(0 | 1) => break, // explicit Stop or kernel EOF on app death
                Ok(_) => unreachable!(),
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::TimedOut
                            | std::io::ErrorKind::WouldBlock
                            | std::io::ErrorKind::Interrupted
                    ) =>
                {
                    match process.alive() {
                        Ok(true) => {}
                        Ok(false) => break,
                        Err(_) => {
                            if process.stop().is_err() {
                                let _ = socket.write_all(b"F");
                                loop {
                                    std::thread::park();
                                }
                            }
                            break;
                        }
                    }
                }
                Err(_) => break,
            }
        }
        if process.stop().is_err() {
            // Neither lock nor signing directory may be released on failed cleanup.
            let _ = socket.write_all(b"F");
            loop {
                std::thread::park();
            }
        }
        // The listener session is confirmed stopped. Empty the finite kernel
        // buffer, not just one live-loop budget, before acknowledging Stop.
        let _ = drain_log(&mut reader, &mut writer, false);
        // A confirmed failure to delete the private dir can be reported and
        // retried manually without claiming the old execution is still running.
        std::fs::remove_dir_all(temp).map_err(|_| "Could not remove agent runtime directory")?;
        Ok(())
    })();
    if !spawned {
        let _ = std::fs::remove_dir_all(temp);
    }
    // Cleanup failures after confirmed exit retain the private directory but
    // allow another execution. Keep the lock through the completion handshake.
    let _ = socket.write_all(if result.is_ok() {
        b"S"
    } else if spawned {
        b"E"
    } else {
        b"X"
    });
    result
}

// A noisy child cannot starve Stop or app-death detection.
fn drain_log(reader: &mut Channel, writer: &mut crate::logs::Writer, live: bool) -> Result<()> {
    let mut bytes = [0u8; 8192];
    let mut chunks = 0;
    loop {
        if live && chunks == 32 {
            break;
        }
        match reader.read(&mut bytes) {
            Ok(0) => break,
            Ok(n) => {
                writer.append(&bytes[..n])?;
                chunks += 1;
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err("Could not capture harness log".into()),
        }
    }
    Ok(())
}

// A failed Start cannot wait indefinitely for an unconfirmed guardian. Keep
// Child owned until its guardian finishes the same cleanup used after app death.
fn reap_failed_start(mut child: Child) {
    std::thread::spawn(move || {
        let _ = child.wait();
    });
}

fn confirm_start(mut socket: Channel, child: Child) -> Result<(Channel, Child)> {
    let mut state = [0u8];
    let read = socket.read_exact(&mut state);
    if read.is_err() || state != *b"R" {
        // Confirmed pre-listener replies exit immediately. An unconfirmed
        // read may still own a listener; close the channel so its guardian
        // cleans up, and reap it without blocking Start indefinitely.
        drop(socket);
        if read.is_ok() && matches!(state, [b'O' | b'X' | b'E']) {
            let mut child = child;
            let _ = child.wait();
        } else {
            reap_failed_start(child);
        }
        return Err(if state == *b"O" {
            "Another buzz-app profile is already running this exact agent/community"
        } else {
            "Could not start agent listener or acquire ownership"
        }
        .into());
    }
    Ok((socket, child))
}

pub(crate) struct Supervised {
    socket: Channel,
    child: Child,
    stopped: bool,
    cleanup_failed: bool,
    shutdown_unconfirmed: bool,
}
impl Supervised {
    pub(crate) fn spawn(
        command: &Command,
        root: &Path,
        id: &str,
        temp: &Path,
        log: &Path,
    ) -> Result<Self> {
        let preflight = (|| {
            let pair = channel().map_err(|_| "Could not create agent supervision channel")?;
            let program =
                std::env::current_exe().map_err(|_| "Could not locate agent supervisor")?;
            let cwd = command.get_current_dir().ok_or("Missing agent workspace")?;
            Ok::<_, &str>((pair, program, cwd))
        })();
        let ((socket, other), program, cwd) = preflight.inspect_err(|_| {
            let _ = std::fs::remove_dir_all(temp); // no guardian was spawned
        })?;
        let mut guardian = Command::new(program);
        #[cfg(not(test))]
        guardian.args([
            MODE.into(),
            root.as_os_str().to_owned(),
            id.into(),
            temp.as_os_str().to_owned(),
            command.get_program().to_owned(),
            log.as_os_str().to_owned(),
        ]);
        #[cfg(test)]
        guardian.args(["--exact", "supervisor::tests::entrypoint", "--nocapture"]);
        guardian.env_clear().envs(
            command
                .get_envs()
                .filter_map(|(key, value)| value.map(|value| (key.to_owned(), value.to_owned()))),
        );
        #[cfg(test)]
        guardian.env(
            "BUZZ_SUPERVISOR_TEST_ARGS",
            serde_json::to_string(&[
                root.display().to_string(),
                id.to_owned(),
                temp.display().to_string(),
                command.get_program().to_string_lossy().into_owned(),
                log.display().to_string(),
            ])
            .map_err(|_| {
                let _ = std::fs::remove_dir_all(temp);
                "Could not prepare test supervisor"
            })?,
        );
        guardian
            .current_dir(cwd)
            .stdin(other)
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // A separate session keeps terminal/launcher group signals from killing
        // this lock owner, and is distinct from the listener's session.
        #[cfg(unix)]
        unsafe {
            use std::os::unix::process::CommandExt;
            guardian.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        // Windows: its own hidden console, outside a terminal's Ctrl+C group.
        // An enclosing kill-on-close launcher job can still end the guardian.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            guardian.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
        }
        let child = guardian.spawn().map_err(|_| {
            let _ = std::fs::remove_dir_all(temp); // no guardian can use it
            "Could not start agent supervisor"
        })?;
        // After spawn, only the guardian can decide when temp storage is safe to remove.
        if socket
            .set_read_timeout(Some(Duration::from_secs(10)))
            .is_err()
        {
            drop(socket);
            reap_failed_start(child);
            return Err("Could not confirm agent supervisor".into());
        }
        let (socket, child) = confirm_start(socket, child)?;
        Ok(Self {
            socket,
            child,
            stopped: false,
            cleanup_failed: false,
            shutdown_unconfirmed: false,
        })
    }
    pub(crate) fn stopped(&self) -> bool {
        self.stopped
    }
    pub(crate) fn alive(&mut self) -> Result<bool> {
        if self.stopped {
            return Ok(false);
        }
        if self.cleanup_failed || self.failed()? {
            return Err("Agent session cleanup failed; ownership remains held".into());
        }
        if self.shutdown_unconfirmed {
            return Err("Agent session shutdown could not be confirmed".into());
        }
        if self
            .child
            .try_wait()
            .map_err(|_| "Could not inspect agent supervisor")?
            .is_some()
        {
            // Read S/E from the completed guardian; exit status alone cannot
            // distinguish a clean stop from failed private-directory removal.
            self.stop()?;
            return Ok(false);
        }
        Ok(true)
    }
    fn failed(&self) -> Result<bool> {
        let byte = peek(&self.socket).map_err(|_| "Could not inspect agent supervisor")?;
        Ok(byte == Some(b'F'))
    }
    pub(crate) fn stop(&mut self) -> Result<()> {
        if self.stopped {
            return Ok(());
        }
        if self.cleanup_failed || self.failed()? {
            return Err("Agent session cleanup failed; ownership remains held".into());
        }
        if !self.shutdown_unconfirmed {
            self.shutdown_unconfirmed = true;
            let _ = self.socket.write_all(b"S");
        }
        let _ = self.socket.set_read_timeout(Some(Duration::from_secs(8)));
        let mut result = [0u8];
        if self.socket.read_exact(&mut result).is_err() {
            return Err("Agent session shutdown could not be confirmed".into());
        }
        if result == *b"F" {
            self.cleanup_failed = true;
            return Err("Agent session cleanup failed; ownership remains held".into());
        }
        if !matches!(result, [b'S' | b'E']) {
            return Err("Agent session shutdown could not be confirmed".into());
        }
        self.child
            .wait()
            .map_err(|_| "Could not reap agent supervisor")?;
        self.stopped = true;
        if result == *b"E" {
            Err("Agent stopped, but its private runtime directory could not be removed".into())
        } else {
            Ok(())
        }
    }
}
impl Drop for Supervised {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

/// Unix transport: a socketpair on the guardian's stdin.
#[cfg(unix)]
mod unix {
    use std::io;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    pub(super) use std::os::unix::net::UnixStream as Channel;
    use std::process::Stdio;

    pub(super) fn channel() -> io::Result<(Channel, Stdio)> {
        let (ours, theirs) = Channel::pair()?;
        Ok((ours, OwnedFd::from(theirs).into()))
    }

    pub(super) fn inherited() -> io::Result<Channel> {
        Ok(unsafe { Channel::from_raw_fd(0) })
    }

    pub(super) fn log_channel() -> io::Result<(Channel, Stdio, Stdio)> {
        let (reader, output) = Channel::pair()?;
        reader.set_nonblocking(true)?;
        let stderr = output.try_clone()?;
        Ok((
            reader,
            OwnedFd::from(output).into(),
            OwnedFd::from(stderr).into(),
        ))
    }

    pub(super) fn peek(channel: &Channel) -> io::Result<Option<u8>> {
        let mut byte = [0u8];
        let n = unsafe {
            libc::recv(
                channel.as_raw_fd(),
                byte.as_mut_ptr().cast(),
                1,
                libc::MSG_PEEK | libc::MSG_DONTWAIT,
            )
        };
        if n < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::WouldBlock {
                return Ok(None);
            }
            return Err(error);
        }
        Ok((n == 1).then_some(byte[0]))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn entrypoint() {
        let Some(args) = std::env::var_os("BUZZ_SUPERVISOR_TEST_ARGS") else {
            return;
        };
        let args: Vec<String> = serde_json::from_str(&args.to_string_lossy()).unwrap();
        let socket = super::inherited().unwrap();
        super::serve(
            socket,
            std::path::Path::new(&args[0]),
            &args[1],
            std::path::Path::new(&args[2]),
            std::path::Path::new(&args[3]),
            std::path::Path::new(&args[4]),
        )
        .unwrap();
    }
}

#[cfg(all(test, windows))]
mod windows_tests;

#[cfg(all(test, unix))]
mod lifecycle_tests {
    use super::*;
    use std::fs;
    use std::os::unix::net::UnixStream;
    use std::time::Instant;

    const ID: &str = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798-79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

    #[test]
    fn parent_entrypoint() {
        let Some(dir) = std::env::var_os("BUZZ_SUPERVISOR_PARENT_TEST") else {
            return;
        };
        let dir = Path::new(&dir);
        let mut command = Command::new(dir.join("listener"));
        command.current_dir(dir);
        let run = Supervised::spawn(
            &command,
            &dir.join("locks"),
            ID,
            &dir.join("temp"),
            &dir.join("harness.log"),
        )
        .unwrap();
        fs::write(dir.join("ready"), run.child.id().to_string()).unwrap();
        loop {
            std::thread::park();
        }
    }

    fn wait(path: &Path) {
        let deadline = Instant::now() + Duration::from_secs(8);
        while !path.exists() {
            assert!(Instant::now() < deadline, "fixture did not reach {path:?}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    struct FixtureCleanup {
        parent: i32,
        guardian: i32,
        leader: i32,
        worker: i32,
        root: std::path::PathBuf,
    }
    impl Drop for FixtureCleanup {
        fn drop(&mut self) {
            if self.guardian <= 1 {
                self.guardian = fs::read_to_string(self.root.join("ready"))
                    .ok()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0);
            }
            if self.leader <= 1 || self.worker <= 1 {
                if let Ok(text) = fs::read_to_string(self.root.join("worker")) {
                    if let Some((leader, worker)) = text.split_once(' ') {
                        self.leader = leader.parse().unwrap_or(0);
                        self.worker = worker.parse().unwrap_or(0);
                    }
                }
            }
            unsafe {
                if self.parent > 1 {
                    libc::kill(self.parent, libc::SIGKILL);
                }
                if self.worker > 1 && libc::getsid(self.worker) == self.leader {
                    libc::kill(self.worker, libc::SIGKILL);
                }
                if self.leader > 1 && libc::getsid(self.leader) == self.leader {
                    libc::kill(self.leader, libc::SIGKILL);
                }
                if self.guardian > 1 && libc::getsid(self.guardian) == self.guardian {
                    libc::kill(self.guardian, libc::SIGCONT);
                    libc::kill(self.guardian, libc::SIGKILL);
                }
            }
        }
    }

    #[test]
    fn confirmed_failure_waits_and_uncertain_handshake_reaps_later() {
        for &response in b"EOX" {
            let child = Command::new("/usr/bin/true").spawn().unwrap();
            let pid = child.id() as i32;
            let (parent, mut guardian) = UnixStream::pair().unwrap();
            guardian.write_all(&[response]).unwrap();
            let error = confirm_start(parent, child).err().unwrap();
            assert_eq!(
                error,
                if response == b'O' {
                    "Another buzz-app profile is already running this exact agent/community"
                } else {
                    "Could not start agent listener or acquire ownership"
                }
            );
            assert_eq!(
                unsafe { libc::kill(pid, 0) },
                -1,
                "terminal guardian was not reaped"
            );
        }
        // No handshake: Start returns without waiting for a still-live child,
        // but its socket closes and its exit is eventually reaped.
        let child = Command::new("/bin/sleep").arg("60").spawn().unwrap();
        let pid = child.id() as i32;
        // An assertion before the explicit kill must not leave /bin/sleep running.
        struct KillOnFailure(i32);
        impl Drop for KillOnFailure {
            fn drop(&mut self) {
                if self.0 > 1 {
                    unsafe { libc::kill(self.0, libc::SIGKILL) };
                }
            }
        }
        let mut cleanup = KillOnFailure(pid);
        let (parent, mut guardian) = UnixStream::pair().unwrap();
        parent
            .set_read_timeout(Some(Duration::from_millis(30)))
            .unwrap();
        // Model a peer reference that outlives confirm_start's socket drop.
        let delayed_peer = parent.try_clone().unwrap();
        assert_eq!(
            confirm_start(parent, child).err().unwrap(),
            "Could not start agent listener or acquire ownership"
        );
        assert_eq!(unsafe { libc::kill(pid, 0) }, 0);
        guardian.set_nonblocking(true).unwrap();
        let mut byte = [0];
        let deadline = Instant::now() + Duration::from_secs(5);
        // Verify the race path: the extra reference prevents immediate EOF.
        assert_eq!(
            guardian.read(&mut byte).unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        drop(delayed_peer);
        loop {
            match guardian.read(&mut byte) {
                Ok(0) => break, // peer socket closed
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(Instant::now() < deadline, "peer socket did not close");
                    std::thread::sleep(Duration::from_millis(10));
                }
                result => panic!("unexpected peer read: {result:?}"),
            }
        }
        assert_eq!(unsafe { libc::kill(pid, libc::SIGKILL) }, 0);
        cleanup.0 = 0;
        let deadline = Instant::now() + Duration::from_secs(5);
        while unsafe { libc::kill(pid, 0) } == 0 {
            assert!(
                Instant::now() < deadline,
                "failed-start child was not reaped"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn startup_abort_releases_ownership_and_private_directory() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let temp = root.join("temp");
        fs::create_dir(&temp).unwrap();
        let mut command = Command::new(root.join("missing-listener"));
        command.current_dir(root);
        assert!(Supervised::spawn(
            &command,
            &root.join("locks"),
            ID,
            &temp,
            &root.join("harness.log")
        )
        .is_err());
        assert!(!temp.exists());
        let _lock = Ownership::acquire(&root.join("locks"), ID).unwrap();
    }

    #[test]
    fn listener_self_exit_reaps_guardian_and_allows_retry() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let temp = root.join("temp");
        fs::create_dir(&temp).unwrap();
        let listener = root.join("listener");
        // Keep the listener alive until Start's handshake has completed.
        // Then explicitly permit it to exit, without sending Stop to guardian.
        let gate = root.join("exit");
        fs::write(
            &listener,
            format!(
                "#!/bin/sh\nwhile [ ! -f '{}' ]; do /bin/sleep .01; done\n",
                gate.display()
            ),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&listener, fs::Permissions::from_mode(0o700)).unwrap();
        let mut command = Command::new(&listener);
        command.current_dir(root);
        let mut run = Supervised::spawn(
            &command,
            &root.join("locks"),
            ID,
            &temp,
            &root.join("harness.log"),
        )
        .unwrap();
        fs::write(&gate, b"exit").unwrap();
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            if !run.alive().unwrap() {
                break;
            }
            assert!(Instant::now() < deadline, "exited listener was not reaped");
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!temp.exists());
        let _lock = Ownership::acquire(&root.join("locks"), ID).unwrap();
    }

    #[test]
    fn stop_timeout_cannot_report_running_and_explicit_stop_confirms_completion() {
        let (parent, mut guardian) = UnixStream::pair().unwrap();
        let child = Command::new("/bin/sleep").arg("60").spawn().unwrap();
        let mut run = Supervised {
            socket: parent,
            child,
            stopped: false,
            cleanup_failed: false,
            shutdown_unconfirmed: false,
        };
        // The guardian waits on an explicit gate after receiving Stop.
        let (accepted, accepted_rx) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel();
        let sender = std::thread::spawn(move || {
            let mut byte = [0];
            guardian.read_exact(&mut byte).unwrap();
            accepted.send(()).unwrap();
            released.recv().unwrap();
            guardian.write_all(b"S").unwrap();
        });
        // Exercise the real eight-second read timeout while the gate is held;
        // not a sleep racing with process teardown.
        assert_eq!(
            run.stop().unwrap_err(),
            "Agent session shutdown could not be confirmed"
        );
        accepted_rx.recv().unwrap();
        assert_eq!(
            run.alive().unwrap_err(),
            "Agent session shutdown could not be confirmed"
        );
        release.send(()).unwrap();
        sender.join().unwrap();
        run.child.kill().unwrap();
        assert!(run.stop().is_ok());
        assert!(!run.alive().unwrap());
    }

    #[test]
    fn failed_session_cleanup_remains_failed_after_stop_consumes_the_signal() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let temp = root.join("temp");
        fs::create_dir(&temp).unwrap();
        let mut command = Command::new("/usr/bin/true");
        command.current_dir(root);
        // A test-only guardian fixture sends F without exiting. It models an
        // incomplete session teardown, not a private-directory deletion error.
        let (parent, mut guardian) = UnixStream::pair().unwrap();
        let child = Command::new("/bin/sleep").arg("60").spawn().unwrap();
        let mut run = Supervised {
            socket: parent,
            child,
            stopped: false,
            cleanup_failed: false,
            shutdown_unconfirmed: false,
        };
        let sender = std::thread::spawn(move || {
            let mut byte = [0];
            guardian.read_exact(&mut byte).unwrap();
            guardian.write_all(b"F").unwrap();
        });
        assert_eq!(
            run.stop().unwrap_err(),
            "Agent session cleanup failed; ownership remains held"
        );
        sender.join().unwrap();
        assert_eq!(
            run.alive().unwrap_err(),
            "Agent session cleanup failed; ownership remains held"
        );
        assert_eq!(
            run.stop().unwrap_err(),
            "Agent session cleanup failed; ownership remains held"
        );
        run.child.kill().unwrap();
        run.child.wait().unwrap();
    }

    #[test]
    fn app_death_keeps_lock_through_worker_session_cleanup() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir(root.join("temp")).unwrap();
        // No real credentials or relay. This listener spawns a worker in a
        // different process group and ignores TERM; session cleanup must kill it.
        fs::write(
            root.join("listener"),
            format!(
                r##"#!/usr/bin/python3
import os, signal, subprocess, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
signal.signal(signal.SIGHUP, signal.SIG_IGN)
child=subprocess.Popen(['/bin/sleep','60'], preexec_fn=os.setpgrp)
with open('{}/worker.tmp', 'w') as f: f.write(str(os.getpid())+' '+str(child.pid))
os.rename('{}/worker.tmp', '{}/worker')
while True: time.sleep(.1)
"##,
                root.display(),
                root.display(),
                root.display()
            ),
        )
        .unwrap();
        fs::set_permissions(root.join("listener"), fs::Permissions::from_mode(0o700)).unwrap();
        let mut parent = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "supervisor::lifecycle_tests::parent_entrypoint",
                "--nocapture",
            ])
            .env("BUZZ_SUPERVISOR_PARENT_TEST", root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut cleanup = FixtureCleanup {
            parent: parent.id() as i32,
            guardian: 0,
            leader: 0,
            worker: 0,
            root: root.into(),
        };
        wait(&root.join("ready"));
        wait(&root.join("worker"));
        let pids = fs::read_to_string(root.join("worker")).unwrap();
        let (leader, worker) = pids.split_once(' ').unwrap();
        let leader: i32 = leader.parse().unwrap();
        let worker: i32 = worker.parse().unwrap();
        let guardian_pid: i32 = fs::read_to_string(root.join("ready"))
            .unwrap()
            .parse()
            .unwrap();
        cleanup.guardian = guardian_pid;
        cleanup.leader = leader;
        cleanup.worker = worker;
        assert!(leader > 1 && worker > 1);
        assert_eq!(unsafe { libc::getsid(worker) }, leader);
        assert_eq!(unsafe { libc::getpgid(worker) }, worker);
        assert_ne!(guardian_pid, leader);
        // Freeze the guardian: a fast cleanup cannot make this race pass by luck.
        assert_eq!(unsafe { libc::kill(guardian_pid, libc::SIGSTOP) }, 0);
        unsafe { libc::kill(parent.id() as i32, libc::SIGKILL) };
        parent.wait().unwrap();
        assert!(Ownership::acquire(&root.join("locks"), ID).is_err());
        assert_eq!(unsafe { libc::kill(guardian_pid, libc::SIGCONT) }, 0);
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            if Ownership::acquire(&root.join("locks"), ID).is_ok() {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "guardian did not release after cleanup"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!root.join("temp").exists());
        let state = Command::new("/bin/ps")
            .args(["-p", &worker.to_string(), "-o", "stat="])
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&state.stdout);
        assert!(
            text.trim().is_empty() || text.trim().starts_with('Z'),
            "worker still live: {text}"
        );
    }
}
