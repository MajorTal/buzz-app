//! Windows stand-in for the Unix socketpair: one private duplex named-pipe
//! instance per guardian. Reads poll `PeekNamedPipe`, so a timeout never
//! leaves a blocking read queued ahead of a write on the synchronous handle.
use std::cell::Cell;
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::process::Stdio;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{
    SetHandleInformation, ERROR_BROKEN_PIPE, ERROR_PIPE_NOT_CONNECTED, GENERIC_READ, GENERIC_WRITE,
    HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_FIRST_PIPE_INSTANCE, OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
};
use windows_sys::Win32::System::Pipes::{
    CreateNamedPipeW, PeekNamedPipe, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
};

pub(crate) struct Channel {
    file: File,
    timeout: Cell<Option<Duration>>,
}

impl Channel {
    fn new(handle: OwnedHandle) -> Self {
        Self {
            file: File::from(handle),
            timeout: Cell::new(None),
        }
    }

    pub(crate) fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        self.timeout.set(timeout);
        Ok(())
    }

    pub(crate) fn set_nonblocking(&self, nonblocking: bool) -> io::Result<()> {
        self.timeout.set(nonblocking.then_some(Duration::ZERO));
        Ok(())
    }

    /// Readable byte count and the next byte, unconsumed. `None` once the peer
    /// has closed and buffered bytes are drained.
    fn poll(&self) -> io::Result<Option<(u32, u8)>> {
        let (mut byte, mut read, mut available) = (0u8, 0u32, 0u32);
        let peeked = unsafe {
            PeekNamedPipe(
                self.file.as_raw_handle(),
                (&mut byte as *mut u8).cast(),
                1,
                &mut read,
                &mut available,
                std::ptr::null_mut(),
            )
        };
        if peeked == 0 {
            let error = io::Error::last_os_error();
            return match error.raw_os_error().map(|code| code as u32) {
                Some(ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED) => Ok(None),
                _ => Err(error),
            };
        }
        Ok(Some((available, byte)))
    }
}

impl Read for Channel {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let deadline = self.timeout.get().map(|timeout| Instant::now() + timeout);
        loop {
            match self.poll()? {
                None => return Ok(0),
                Some((0, _)) => {}
                Some((available, _)) => {
                    let n = buf.len().min(available as usize);
                    return self.file.read(&mut buf[..n]);
                }
            }
            if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                return Err(io::ErrorKind::WouldBlock.into());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Write for Channel {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.file.write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Both ends start non-inheritable; std duplicates the guardian's end only
/// for the duration of that one spawn.
pub(crate) fn channel() -> io::Result<(Channel, Stdio)> {
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).map_err(|_| io::Error::other("no randomness"))?;
    let name = format!(
        r"\\.\pipe\buzz-agent-supervisor-{:032x}",
        u128::from_ne_bytes(nonce)
    );
    let name: Vec<u16> = name.encode_utf16().chain([0]).collect();
    // A single first instance: a squatter or competing client fails closed.
    let server = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            4096,
            4096,
            0,
            std::ptr::null(),
        )
    };
    if server == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let server = unsafe { OwnedHandle::from_raw_handle(server) };
    let client = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        )
    };
    if client == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let client = unsafe { OwnedHandle::from_raw_handle(client) };
    Ok((Channel::new(server), Stdio::from(client)))
}

/// The guardian's stdin. Clear inheritance before anything is spawned so the
/// listener's tree cannot hold the app channel open past app death.
pub(crate) fn inherited() -> io::Result<Channel> {
    let handle = io::stdin().as_raw_handle();
    if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(Channel::new(unsafe {
        OwnedHandle::from_raw_handle(handle)
    }))
}

/// Listener stdout/stderr; the guardian-private read end never blocks.
pub(crate) fn log_channel() -> io::Result<(Channel, Stdio, Stdio)> {
    let (reader, writer) = io::pipe()?;
    let stderr = writer.try_clone()?;
    let reader = Channel::new(reader.into());
    reader.set_nonblocking(true)?;
    Ok((reader, writer.into(), stderr.into()))
}

/// The next unread byte without consuming it; `None` when empty or closed.
pub(crate) fn peek(channel: &Channel) -> io::Result<Option<u8>> {
    Ok(channel
        .poll()?
        .filter(|(n, _)| *n > 0)
        .map(|(_, byte)| byte))
}
