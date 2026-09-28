//! Windows/Linux credential primitives shared by human and agent identity owners.
//! Password encoding matches keyring's native Windows UTF-16 / Linux UTF-8 format.
//! Create-only writes are serialized across cooperating app processes, not profiles.
//! Locks contain no secrets; missing/locked/broken secure storage never falls back.
#![cfg(any(target_os = "windows", target_os = "linux", test))]

use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::path::Path;
use zeroize::{Zeroize, Zeroizing};

/// Sanitized outcomes. Only `Absent` permits creation of a new credential.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Absent,
    Occupied,
    Denied,
    Corrupt,
    Unavailable,
    Busy,
}
type Result<T> = std::result::Result<T, Error>;

fn error(value: keyring::Error) -> Error {
    match value {
        keyring::Error::NoEntry => Error::Absent,
        keyring::Error::NoStorageAccess(_) => Error::Denied,
        keyring::Error::BadEncoding(mut bytes) => {
            bytes.zeroize();
            Error::Corrupt
        }
        keyring::Error::Ambiguous(_) => Error::Corrupt,
        _ => Error::Unavailable,
    }
}

trait Backend {
    fn read(&self) -> Result<Zeroizing<Vec<u8>>>;
    fn write(&self, value: &str) -> Result<()>;
    fn delete(&self) -> Result<()>;
}

// Unit tests cannot accidentally call the real OS adapter.
#[cfg(not(test))]
impl Backend for keyring::Entry {
    fn read(&self) -> Result<Zeroizing<Vec<u8>>> {
        self.get_password()
            .map(|value| Zeroizing::new(value.into_bytes()))
            .map_err(error)
    }
    fn write(&self, value: &str) -> Result<()> {
        self.set_password(value).map_err(error)
    }
    fn delete(&self) -> Result<()> {
        self.delete_credential().map_err(error)
    }
}

#[cfg(not(test))]
fn entry(service: &str, account: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(service, account).map_err(error)
}

fn lock_root() -> Result<std::path::PathBuf> {
    // Resolve the OS account, not HOME/XDG overrides, profile, worktree or temp
    // paths: all processes writing the same per-user entry must share its lock.
    #[cfg(unix)]
    let home = nix::unistd::User::from_uid(nix::unistd::Uid::effective())
        .map_err(|_| Error::Unavailable)?
        .map(|user| user.dir);
    #[cfg(windows)]
    let home = dirs::home_dir(); // Windows Known Folder API, not environment.
    home.filter(|path| path.is_absolute())
        .map(|path| path.join(".buzz-foundation/credential-locks"))
        .ok_or(Error::Unavailable)
}

/// Read an exact service/account without consulting any other credential.
#[cfg(not(test))]
pub fn read(service: &str, account: &str) -> Result<Zeroizing<Vec<u8>>> {
    entry(service, account)?.read()
}

/// Add a credential only if a fresh read under its interprocess lock is absent.
#[cfg(not(test))]
pub fn add(service: &str, account: &str, value: &[u8]) -> Result<()> {
    add_entry(
        &entry(service, account)?,
        &lock_root()?,
        service,
        account,
        value,
    )
}

/// Delete only the exact credential, serialized with this app's creates/deletes.
#[cfg(not(test))]
pub fn delete(service: &str, account: &str) -> Result<()> {
    delete_entry(&entry(service, account)?, &lock_root()?, service, account)
}

fn add_entry(
    entry: &impl Backend,
    root: &Path,
    service: &str,
    account: &str,
    value: &[u8],
) -> Result<()> {
    let value = std::str::from_utf8(value).map_err(|_| Error::Corrupt)?;
    let _lock = acquire(root, service, account)?;
    match entry.read() {
        Ok(_) => return Err(Error::Occupied),
        Err(Error::Absent) => {}
        Err(error) => return Err(error),
    }
    entry.write(value)
}

fn delete_entry(entry: &impl Backend, root: &Path, service: &str, account: &str) -> Result<()> {
    let _lock = acquire(root, service, account)?;
    entry.delete()
}

struct Lock(File);

impl Drop for Lock {
    fn drop(&mut self) {
        // fork/dup can retain the open-file description after our descriptor
        // closes. Explicitly release ownership when the operation finishes.
        let _ = self.0.unlock();
    }
}

fn acquire(root: &Path, service: &str, account: &str) -> Result<Lock> {
    if !root.is_absolute() {
        return Err(Error::Unavailable);
    }
    fs::create_dir_all(root).map_err(|_| Error::Unavailable)?;
    let mut hash = Sha256::new();
    hash.update(service.as_bytes());
    hash.update([0]);
    hash.update(account.as_bytes());
    let path = root.join(format!("{:x}.lock", hash.finalize()));
    // The file is never read, written, truncated or removed; it contains no
    // secrets. These advisory locks coordinate this app, not hostile OS peers.
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|_| Error::Unavailable)?;
    // Unlike a blocking lock, contention cannot strand an IPC worker behind a
    // second process's credential-consent dialog. Retry is explicitly user-driven.
    file.try_lock().map_err(|e| match e {
        std::fs::TryLockError::WouldBlock => Error::Busy,
        std::fs::TryLockError::Error(_) => Error::Unavailable,
    })?;
    Ok(Lock(file))
}

#[cfg(test)]
mod tests;
