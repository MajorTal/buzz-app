//! One agent-only Keychain item; session caching never couples human custody.
use super::{Failure, Keychain, SecretMap, MAX_BLOB, SERVICE};
use crate::{Result, Secret};
use std::sync::Mutex;
use zeroize::{Zeroize, Zeroizing};

pub(super) const ACCOUNT: &str = "agent-bundle-v1";

// A non-secret epoch fences cached copies in other cooperating app processes.
// Advance before a write, so a crash/uncertain write also invalidates old caches.
pub(super) trait BundleLock {
    fn epoch(&mut self) -> std::result::Result<[u8; 16], Failure>;
    fn invalidate(&mut self) -> std::result::Result<[u8; 16], Failure>;
}
#[derive(Default)]
pub(super) struct Bundle(Mutex<State>);
#[derive(Default)]
struct State {
    cached: Option<([u8; 16], SecretMap)>,
    failure: Option<Failure>,
}
impl Bundle {
    pub fn retry(&self) {
        if let Ok(mut state) = self.0.try_lock() {
            state.failure = None;
        }
    }
    fn access<T>(
        &self,
        keychain: &dyn Keychain,
        operation: impl FnOnce(&mut State, &mut dyn BundleLock) -> std::result::Result<T, Failure>,
    ) -> Result<T> {
        let mut state = self.0.try_lock().map_err(|_| Failure::Busy.message())?;
        if let Some(failure) = state.failure {
            return Err(failure.message());
        }
        let result = keychain
            .bundle_lock()
            .and_then(|mut lock| operation(&mut state, lock.as_mut()));
        if let Err(error) = result {
            state.cached = None;
            // Only a denied unlock is shared. Busy and an individual malformed
            // migration must not poison otherwise valid agents in the queue.
            if error == Failure::Denied {
                state.failure = Some(error);
            }
        }
        result.map_err(Failure::message)
    }
    pub fn read(
        &self,
        keychain: &dyn Keychain,
        account: &str,
        pubkey: &str,
    ) -> Result<Option<Secret>> {
        self.access(keychain, |state, lock| {
            let epoch = lock.epoch()?;
            if state.cached.as_ref().map(|(at, _)| at) != Some(&epoch) {
                state.cached = Some((epoch, load(keychain)?));
            }
            if let Some(value) = state
                .cached
                .as_ref()
                .and_then(|(_, map)| map.0.get(account))
            {
                return parse(value, pubkey).map(Some);
            }
            // Only absence in a successfully loaded bundle permits migration.
            // Never consult old Buzz or substitute another identity/community.
            let bytes = match keychain.saved(SERVICE, account) {
                Ok(bytes) => bytes,
                Err(Failure::Absent) => return Ok(None),
                Err(error) => return Err(error),
            };
            if bytes.len() > 64 {
                return Err(Failure::Corrupt);
            }
            let key = parse(
                std::str::from_utf8(&bytes).map_err(|_| Failure::Corrupt)?,
                pubkey,
            )?;
            // Fresh read under the mutation lock, never write back a session cache.
            let mut map = load(keychain)?;
            map.0.insert(account.into(), (*key.hex()).clone());
            persist(keychain, lock, state, map)?;
            // Retain the individual entry for rollback. Explicit Delete removes both.
            Ok(Some(key))
        })
    }
    pub fn add(&self, keychain: &dyn Keychain, account: &str, key: &Secret) -> Result<()> {
        self.access(keychain, |state, lock| {
            let mut map = load(keychain)?;
            if map.0.contains_key(account) {
                return Err(Failure::Occupied);
            }
            match keychain.saved(SERVICE, account) {
                Ok(_) => return Err(Failure::Occupied),
                Err(Failure::Absent) => {}
                Err(error) => return Err(error),
            }
            map.0.insert(account.into(), (*key.hex()).clone());
            persist(keychain, lock, state, map)
        })
    }
    pub fn delete(&self, keychain: &dyn Keychain, account: &str) -> Result<()> {
        // Delete is explicit recovery too, including after a refused unlock.
        self.retry();
        self.access(keychain, |state, lock| {
            let mut map = load(keychain)?;
            state.cached = None;
            lock.invalidate()?;
            // Remove the rollback copy first. A failure leaves the bundle intact;
            // a later bundle-write failure leaves the card available for retry.
            match keychain.delete(SERVICE, account) {
                Ok(()) | Err(Failure::Absent) => {}
                Err(error) => return Err(error),
            }
            if let Some(mut value) = map.0.remove(account) {
                value.zeroize();
            }
            persist(keychain, lock, state, map)
        })
    }
}
fn parse(value: &str, pubkey: &str) -> std::result::Result<Secret, Failure> {
    Secret::parse(value, pubkey).map_err(|_| Failure::Corrupt)
}
fn load(keychain: &dyn Keychain) -> std::result::Result<SecretMap, Failure> {
    let bytes = match keychain.saved(SERVICE, ACCOUNT) {
        Ok(bytes) => bytes,
        Err(Failure::Absent) => return Ok(SecretMap::default()),
        Err(error) => return Err(error),
    };
    decode(&bytes)
}
fn decode(bytes: &[u8]) -> std::result::Result<SecretMap, Failure> {
    if bytes.len() > MAX_BLOB {
        return Err(Failure::Corrupt);
    }
    let map: SecretMap = serde_json::from_slice(bytes).map_err(|_| Failure::Corrupt)?;
    for (account, value) in &map.0 {
        let id = account.strip_prefix("agent:").ok_or(Failure::Corrupt)?;
        super::account(id).map_err(|_| Failure::Corrupt)?;
        parse(value, id.split_once('-').ok_or(Failure::Corrupt)?.0)?;
    }
    Ok(map)
}
fn persist(
    keychain: &dyn Keychain,
    lock: &mut dyn BundleLock,
    state: &mut State,
    map: SecretMap,
) -> std::result::Result<(), Failure> {
    let mut bytes = Zeroizing::new(Vec::new());
    serde_json::to_writer(&mut *bytes, &map.0).map_err(|_| Failure::Corrupt)?;
    if bytes.len() > MAX_BLOB {
        return Err(Failure::Corrupt);
    }
    state.cached = None;
    let epoch = lock.invalidate()?;
    keychain.replace(SERVICE, ACCOUNT, &bytes)?;
    let verified = decode(&keychain.saved(SERVICE, ACCOUNT)?)?;
    if verified.0 != map.0 {
        return Err(Failure::Corrupt);
    }
    state.cached = Some((epoch, verified));
    Ok(())
}

#[test]
fn same_process_contention_reports_busy_without_blame_or_keychain_access() {
    let bundle = Bundle::default();
    let _pending = bundle.0.lock().unwrap();
    // Unit-test OsKeychain rejects access; the held session mutex must fail first.
    let result = bundle.read(&super::platform::OsKeychain, "agent:fixture", "fixture");
    assert_eq!(
        result.err().unwrap(),
        "Credentials are busy; retry after the current operation finishes"
    );
}
