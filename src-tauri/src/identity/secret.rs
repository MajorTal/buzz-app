//! Key parsing is native-only. Do not implement Debug, Serialize, Clone or export.
use super::dto::{ErrorCode, Result};
use bech32::{primitives::decode::CheckedHrpstring, Bech32};
use secp256k1::{PublicKey, Secp256k1, SecretKey};
use zeroize::Zeroizing;

pub(super) struct IdentityKey {
    bytes: Zeroizing<[u8; 32]>,
    pubkey: String,
}
impl IdentityKey {
    pub(super) fn from_bytes(bytes: Zeroizing<[u8; 32]>) -> Result<Self> {
        let mut secret = SecretKey::from_byte_array(*bytes).map_err(|_| ErrorCode::Corrupt)?;
        let public = PublicKey::from_secret_key(&Secp256k1::signing_only(), &secret);
        secret.non_secure_erase();
        Ok(Self {
            bytes,
            pubkey: public.x_only_public_key().0.to_string(),
        })
    }
    pub(super) fn parse(text: &str) -> Result<Self> {
        let text = text.trim();
        let mut bytes = Zeroizing::new([0; 32]);
        if text.len() == 64 && text.bytes().all(|b| b.is_ascii_hexdigit()) {
            for (pair, dest) in text.as_bytes().chunks_exact(2).zip(bytes.iter_mut()) {
                let nibble = |b: u8| {
                    if b <= b'9' {
                        b - b'0'
                    } else {
                        b.to_ascii_lowercase() - b'a' + 10
                    }
                };
                *dest = nibble(pair[0]) * 16 + nibble(pair[1]);
            }
        } else {
            // NIP-19 nsec uses Bech32, NOT Bech32m. Bound before decoder allocation.
            if text.len() != 63 || !text.starts_with("nsec1") {
                return Err(ErrorCode::Corrupt.into());
            }
            let decoded = CheckedHrpstring::new::<Bech32>(text).map_err(|_| ErrorCode::Corrupt)?;
            let mut iter = decoded.byte_iter();
            for dest in bytes.iter_mut() {
                *dest = iter.next().ok_or(ErrorCode::Corrupt)?;
            }
            if iter.next().is_some() {
                return Err(ErrorCode::Corrupt.into());
            }
        }
        Self::from_bytes(bytes)
    }
    pub(super) fn pubkey(&self) -> &str {
        &self.pubkey
    }
    pub(super) fn bytes(&self) -> &[u8; 32] {
        &self.bytes
    }
    pub(super) fn verify_pin(&self, pin: &str) -> Result<()> {
        if self.pubkey == pin {
            Ok(())
        } else {
            Err(ErrorCode::Mismatch.into())
        }
    }
}

pub(super) fn validate_pin(pin: &str) -> Result<()> {
    if pin.len() != 64
        || !pin
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(ErrorCode::InvalidInput.into());
    }
    // Reject non-curve public keys, not just malformed spelling.
    pin.parse::<secp256k1::XOnlyPublicKey>()
        .map_err(|_| ErrorCode::InvalidInput)?;
    Ok(())
}
