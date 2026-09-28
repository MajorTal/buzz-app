//! Exact-source read-only legacy lookup and create-only native credential custody.
//! No environment, shell, per-key migration or fallback to another legacy service.
use crate::{Credentials, LegacySource, Result, Secret};
use std::collections::BTreeMap;
use std::sync::Arc;
use zeroize::{Zeroize, Zeroizing};

mod platform;
#[cfg(test)]
mod tests;

const SERVICE: &str = "dev.local.buzz.foundation.agents";
const MAX_BLOB: usize = 2 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Failure {
    Absent,
    Occupied,
    Denied,
    Corrupt,
    Unavailable,
    #[cfg(any(target_os = "windows", target_os = "linux", test))]
    Busy,
}
impl Failure {
    fn message(self) -> String {
        match self {
            Self::Absent => "Selected agent credential is absent",
            Self::Occupied => {
                "Destination agent credential already exists; nothing was overwritten"
            }
            Self::Denied => "Secure storage access was denied; allow access explicitly and retry",
            Self::Corrupt => "Selected secure-storage credential is malformed",
            #[cfg(any(target_os = "windows", target_os = "linux", test))]
            Self::Busy => "Another Buzz app is accessing this credential; retry shortly",
            Self::Unavailable => "The OS credential store is unavailable on this platform",
        }
        .into()
    }
}

// Real OS calls and fixture calls share the entire Credentials implementation.
trait Keychain: Send + Sync {
    fn legacy(
        &self,
        service: &str,
        account: &str,
    ) -> std::result::Result<Zeroizing<Vec<u8>>, Failure>;
    fn saved(
        &self,
        service: &str,
        account: &str,
    ) -> std::result::Result<Zeroizing<Vec<u8>>, Failure>;
    fn add(&self, service: &str, account: &str, value: &[u8]) -> std::result::Result<(), Failure>;
    fn delete(&self, service: &str, account: &str) -> std::result::Result<(), Failure>;
}

pub struct PlatformCredentials {
    keychain: Arc<dyn Keychain>,
}
impl Default for PlatformCredentials {
    fn default() -> Self {
        Self {
            keychain: Arc::new(platform::OsKeychain),
        }
    }
}

fn account(id: &str) -> Result<String> {
    // A credential ID must have the imported exact-key/community digest shape.
    let (pubkey, community) = id
        .split_once('-')
        .ok_or("Invalid agent credential identifier")?;
    if !crate::config::canonical_key(pubkey) || !crate::config::canonical_key(community) {
        return Err("Invalid agent credential identifier".into());
    }
    Ok(format!("agent:{id}"))
}

impl Credentials for PlatformCredentials {
    fn read_legacy(&self, source: LegacySource, pubkey: &str) -> Result<Secret> {
        if !crate::config::canonical_key(pubkey) {
            return Err("Invalid selected agent identity".into());
        }
        let bytes = self
            .keychain
            .legacy(source.keyring_service(), "secrets")
            .map_err(Failure::message)?;
        if bytes.len() > MAX_BLOB {
            return Err(Failure::Corrupt.message());
        }
        let map: SecretMap =
            serde_json::from_slice(&bytes).map_err(|_| Failure::Corrupt.message())?;
        let value = map
            .0
            .get(&format!("agent:{pubkey}"))
            .ok_or_else(|| Failure::Absent.message())?;
        Secret::parse(value, pubkey)
    }
    fn read(&self, id: &str, pubkey: &str) -> Result<Option<Secret>> {
        let account = account(id)?;
        if id.split_once('-').map(|(key, _)| key) != Some(pubkey) {
            return Err("Credential identifier does not match the selected agent".into());
        }
        match self.keychain.saved(SERVICE, &account) {
            Ok(bytes) => {
                if bytes.len() > 64 {
                    return Err(Failure::Corrupt.message());
                }
                let text = std::str::from_utf8(&bytes).map_err(|_| Failure::Corrupt.message())?;
                Secret::parse(text, pubkey).map(Some)
            }
            Err(Failure::Absent) => Ok(None),
            Err(error) => Err(error.message()),
        }
    }
    fn add(&self, id: &str, key: &Secret) -> Result<()> {
        let account = account(id)?;
        if id.split_once('-').map(|(pubkey, _)| pubkey) != Some(key.pubkey()) {
            return Err("Credential identifier does not match the selected agent".into());
        }
        let value = key.hex();
        self.keychain
            .add(SERVICE, &account, value.as_bytes())
            .map_err(Failure::message)
    }
    fn delete(&self, id: &str, pubkey: &str) -> Result<()> {
        let account = account(id)?;
        if id.split_once('-').map(|(key, _)| key) != Some(pubkey) {
            return Err("Credential identifier does not match the selected agent".into());
        }
        match self.keychain.delete(SERVICE, &account) {
            Ok(()) | Err(Failure::Absent) => Ok(()),
            Err(error) => Err(error.message()),
        }
    }
}

// Wipe all parsed values, including when parsing fails mid-map. Reject duplicate
// accounts rather than choosing a different key by JSON ordering.
#[derive(Default)]
struct SecretMap(BTreeMap<String, String>);
impl Drop for SecretMap {
    fn drop(&mut self) {
        for value in self.0.values_mut() {
            value.zeroize();
        }
    }
}
impl<'de> serde::Deserialize<'de> for SecretMap {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = SecretMap;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a credential map")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut entries: A,
            ) -> std::result::Result<SecretMap, A::Error> {
                let mut map = SecretMap::default();
                while let Some(key) = entries.next_key::<String>()? {
                    if map.0.contains_key(&key) {
                        return Err(serde::de::Error::custom("duplicate credential"));
                    }
                    let value = entries.next_value::<String>()?;
                    map.0.insert(key, value);
                }
                Ok(map)
            }
        }
        deserializer.deserialize_map(Visitor)
    }
}
