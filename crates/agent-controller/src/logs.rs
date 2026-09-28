//! Private bounded listener output, separate from sanitized controller snapshots.
use crate::Result;
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
#[cfg(any(unix, test))]
use std::io::Write;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// Domain-separated proof input; only the native-generated single-use nonce is
/// signed by the connected community's owner signer. The relay URL is canonical wss.
pub fn proof_message(id: &str, pubkey: &str, relay: &str, nonce: &str) -> String {
    format!("buzz-app:harness-log:v1:{id}:{pubkey}:{relay}:{nonce}")
}

pub(crate) fn verify_owner_proof(
    owner: &str,
    id: &str,
    pubkey: &str,
    relay: &str,
    nonce: &str,
    signature: &str,
) -> Result<()> {
    use secp256k1::{schnorr::Signature, Secp256k1, XOnlyPublicKey};
    let invalid = || "Owner authorization is unavailable".to_string();
    if nonce.len() != 36 || !uuid_shape(nonce) || signature.len() != 128 {
        return Err(invalid());
    }
    let key: XOnlyPublicKey = owner.parse().map_err(|_| invalid())?;
    let sig: Signature = signature.parse().map_err(|_| invalid())?;
    let digest = Sha256::digest(proof_message(id, pubkey, relay, nonce));
    Secp256k1::verification_only()
        .verify_schnorr(&sig, &digest, &key)
        .map_err(|_| invalid())
}

fn uuid_shape(value: &str) -> bool {
    value.bytes().enumerate().all(|(i, b)| {
        if [8, 13, 18, 23].contains(&i) {
            b == b'-'
        } else {
            b.is_ascii_hexdigit() && !b.is_ascii_uppercase()
        }
    })
}

const MAX_BYTES: u64 = 1024 * 1024;
const VISIBLE_LINES: usize = 120;
const MAX_RESPONSE_BYTES: usize = 64 * 1024;

pub(crate) fn path(root: &Path, id: &str) -> Result<PathBuf> {
    // IDs are native identity/community hashes, never caller-supplied paths.
    if id.len() != 129
        || !id.bytes().enumerate().all(|(i, b)| {
            if i == 64 {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
    {
        return Err("Invalid agent identifier".into());
    }
    let dir = root.join("logs");
    crate::connection::private_directory(&dir)?;
    Ok(dir.join(format!("{id}.log")))
}

fn open(path: &Path, write: bool) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(write).create(write);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(std::io::Error::other("Invalid log file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if meta.nlink() != 1 {
            return Err(std::io::Error::other("Invalid log file"));
        }
        if write {
            file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        }
    }
    Ok(file)
}

// Only the Unix supervisor writes logs; keep the cross-platform retention tests.
#[cfg(any(unix, test))]
pub(crate) struct Writer {
    file: File,
}
#[cfg(any(unix, test))]
impl Writer {
    pub(crate) fn new(path: &Path) -> Result<Self> {
        let file = open(path, true).map_err(|_| "Could not open harness log")?;
        Ok(Self { file })
    }
    pub(crate) fn append(&mut self, bytes: &[u8]) -> Result<()> {
        // Serialized by the supervisor. Lock readers across compaction so a poll
        // cannot observe a half-written tail. Work per write and retention are bounded.
        self.file.lock().map_err(|_| "Could not lock harness log")?;
        let result = (|| -> std::io::Result<()> {
            let len = self.file.metadata()?.len();
            let bytes = &bytes[bytes.len().saturating_sub(MAX_BYTES as usize)..];
            if len + bytes.len() as u64 > MAX_BYTES {
                // Drop half the retained history at a time, so steady output
                // does not rewrite 1 MiB for every small append.
                let keep = (MAX_BYTES / 2).min(len).min(MAX_BYTES - bytes.len() as u64);
                self.file.seek(SeekFrom::End(-(keep as i64)))?;
                let mut tail = vec![0; keep as usize];
                self.file.read_exact(&mut tail)?;
                self.file.seek(SeekFrom::Start(0))?;
                self.file.write_all(&tail)?;
                self.file.set_len(keep)?;
            }
            self.file.seek(SeekFrom::End(0))?;
            self.file.write_all(bytes)
        })();
        let unlocked = self.file.unlock();
        result
            .and(unlocked)
            .map_err(|_| "Could not write harness log".into())
    }
}

pub(crate) fn read(path: &Path) -> Result<String> {
    let mut file = match open(path, false) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(_) => return Err("Could not read harness log".into()),
    };
    file.lock_shared()
        .map_err(|_| "Could not lock harness log")?;
    let result = (|| -> std::io::Result<String> {
        let len = file.metadata()?.len();
        file.seek(SeekFrom::Start(0))?;
        let mut bytes = Vec::with_capacity(len.min(MAX_BYTES) as usize);
        file.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
        if bytes.len() > MAX_BYTES as usize {
            return Err(std::io::Error::other("Harness log exceeds retention limit"));
        }
        // Match the base profile view's last 120 lines. Bound the native IPC
        // response independently of the private on-disk retention budget.
        let text = strip_ansi_escapes::strip_str(String::from_utf8_lossy(&bytes));
        let lines: Vec<&str> = text.lines().collect();
        let tail = lines[lines.len().saturating_sub(VISIBLE_LINES)..].join("\n");
        // A single enormous line must not turn a focused read into a 1 MiB IPC.
        let start = tail.len().saturating_sub(MAX_RESPONSE_BYTES);
        let start = (start..tail.len())
            .find(|&index| tail.is_char_boundary(index))
            .unwrap_or(tail.len());
        Ok(tail[start..].to_string())
    })();
    // Dropping the file releases the read lock, including on failure.
    result.map_err(|_| "Could not read harness log".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retained_history_and_bounded_profile_tail_survive_restart() {
        let dir = tempfile::tempdir().unwrap();
        let id = format!("{}-{}", "a".repeat(64), "b".repeat(64));
        let path = path(dir.path(), &id).unwrap();
        assert_eq!(read(&path).unwrap(), "");
        assert!(super::path(dir.path(), "../escape").is_err());
        let mut writer = Writer::new(&path).unwrap();
        for line in 0..250 {
            writer.append(format!("line {line}\n").as_bytes()).unwrap();
        }
        let tail = read(&path).unwrap();
        assert_eq!(tail.lines().count(), VISIBLE_LINES);
        assert!(tail.starts_with("line 130\n"));
        assert!(tail.ends_with("line 249"));
        writer.append(b"\x1b[31mcolored\x1b[0m\n").unwrap();
        assert!(read(&path).unwrap().ends_with("colored"));
        assert!(!read(&path).unwrap().contains('\x1b'));
        writer.append(&vec![b'x'; MAX_BYTES as usize]).unwrap();
        assert!(std::fs::metadata(&path).unwrap().len() <= MAX_BYTES);
        assert_eq!(read(&path).unwrap().len(), MAX_RESPONSE_BYTES);
        drop(writer);
        let mut restarted = Writer::new(&path).unwrap();
        restarted.append(b"\nrestart\n").unwrap();
        assert!(read(&path).unwrap().ends_with("restart"));
        assert!(std::fs::metadata(&path).unwrap().len() <= MAX_BYTES / 2 + 9);
        restarted.append(b"more\n").unwrap();
        assert!(std::fs::metadata(&path).unwrap().len() <= MAX_BYTES / 2 + 14);
        let tail = read(&path).unwrap();
        assert_eq!(tail.lines().count(), 3);
        assert!(tail.lines().next().unwrap().bytes().all(|b| b == b'x'));
        assert!(tail.ends_with("restart\nmore"));
        assert!(super::path(dir.path(), "../escape").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_is_not_read_or_written() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("secret");
        std::fs::write(&target, "private").unwrap();
        let link = dir.path().join("log");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(read(&link).is_err());
        assert!(Writer::new(&link).is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "private");
    }
}
