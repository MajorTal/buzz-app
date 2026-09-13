//! Narrow source-read / destination-add contract. No overwrite or deletion method.
use super::{
    dto::{ErrorCode, LegacySource, Result},
    secret::IdentityKey,
};
use serde::{
    de::{IgnoredAny, MapAccess, Visitor},
    Deserialize,
};
use std::fmt;
use zeroize::Zeroizing;

pub(super) const LEGACY_SERVICE: &str = "buzz-desktop";
const MAX_BLOB_BYTES: usize = 1024 * 1024;

pub(super) trait CredentialStore: Send + Sync {
    /// Exact selected legacy slot, never migration or fallback. Returned allocation is scrubbed.
    fn read_legacy(&self, source: LegacySource) -> Result<Zeroizing<Vec<u8>>>;
    /// Uncached OS read on every invocation; account is the canonical public key.
    fn read_saved(&self, service: &str, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>>;
    /// Atomic create-only. Existing records (even identical ones) return Occupied.
    fn add_saved(&self, service: &str, account: &str, value: &[u8]) -> Result<()>;
}

// Avoid deserializing every unrelated agent secret into String. Raw JSON is borrowed;
// only the identity string is decoded and immediately placed in a zeroizing owner.
struct SelectedIdentity(Option<Zeroizing<String>>);
impl<'de> Deserialize<'de> for SelectedIdentity {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct IdentityVisitor;
        impl<'de> Visitor<'de> for IdentityVisitor {
            type Value = SelectedIdentity;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("legacy secret object")
            }
            fn visit_map<M: MapAccess<'de>>(
                self,
                mut map: M,
            ) -> std::result::Result<Self::Value, M::Error> {
                let mut identity = None;
                while let Some(key) = map.next_key::<String>()? {
                    if key == "identity" {
                        if identity.is_some() {
                            return Err(serde::de::Error::custom("duplicate identity"));
                        }
                        identity = Some(Zeroizing::new(map.next_value::<String>()?));
                    } else {
                        map.next_value::<IgnoredAny>()?;
                    }
                }
                Ok(SelectedIdentity(identity))
            }
        }
        d.deserialize_map(IdentityVisitor)
    }
}

pub(super) fn decode_legacy(source: LegacySource, raw: &[u8]) -> Result<IdentityKey> {
    if raw.len() > MAX_BLOB_BYTES {
        return Err(ErrorCode::Corrupt.into());
    }
    match source {
        LegacySource::BuzzDesktopBlob => {
            let selected: SelectedIdentity =
                serde_json::from_slice(raw).map_err(|_| ErrorCode::Corrupt)?;
            IdentityKey::parse(&selected.0.ok_or(ErrorCode::Absent)?)
        }
        LegacySource::BuzzDesktopPerKey => {
            if raw.len() > 256 {
                return Err(ErrorCode::Corrupt.into());
            }
            IdentityKey::parse(std::str::from_utf8(raw).map_err(|_| ErrorCode::Corrupt)?)
        }
    }
}

// App format: version byte + 32-byte secret. Pubkey is derived, never trusted metadata.
// No persisted signed-in authorization exists. Every launch requires explicit unlock.
pub(super) fn encode_saved(key: &IdentityKey) -> Zeroizing<Vec<u8>> {
    let mut value = Zeroizing::new(Vec::with_capacity(33));
    value.push(1);
    value.extend_from_slice(key.bytes());
    value
}
pub(super) fn decode_saved(raw: &[u8]) -> Result<IdentityKey> {
    if raw.len() != 33 || raw[0] != 1 {
        return Err(ErrorCode::Corrupt.into());
    }
    let mut bytes = Zeroizing::new([0; 32]);
    bytes.copy_from_slice(&raw[1..]);
    IdentityKey::from_bytes(bytes)
}
