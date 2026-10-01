use crate::Result;
use bech32::{primitives::decode::CheckedHrpstring, Bech32};
use secp256k1::{PublicKey, Secp256k1, SecretKey};
use zeroize::Zeroizing;

/// No Debug/Serialize: secret bytes never belong in a command result or log.
pub struct Secret {
    bytes: Zeroizing<[u8; 32]>,
    pubkey: String,
}
impl Secret {
    pub fn generate() -> Result<Self> {
        let mut bytes = Zeroizing::new([0; 32]);
        loop {
            getrandom::fill(bytes.as_mut()).map_err(|_| "Could not generate agent identity")?;
            if let Ok(mut key) = SecretKey::from_byte_array(*bytes) {
                let pubkey = PublicKey::from_secret_key(&Secp256k1::signing_only(), &key)
                    .x_only_public_key()
                    .0
                    .to_string();
                key.non_secure_erase();
                return Ok(Self { bytes, pubkey });
            }
        }
    }
    /// Merge only after verifying the exact agent's current kind-0 event.
    pub(crate) fn profile(
        &self,
        name: &str,
        picture: Option<&str>,
        auth: &str,
        existing: &[serde_json::Value],
    ) -> Result<serde_json::Value> {
        use serde_json::json;
        let existing = crate::profile::current(existing, &self.pubkey)?;
        let (mut content, mut tags, previous) = match existing {
            Some(profile) => (profile.content, profile.tags, Some(profile.created_at)),
            None => (
                serde_json::from_value(json!({"name": name, "display_name": name, "bot": true}))
                    .map_err(|_| "Could not initialize profile")?,
                vec![],
                None,
            ),
        };
        if let Some(picture) = picture {
            if picture.is_empty() {
                content.remove("picture");
            } else {
                content.insert("picture".into(), json!(picture));
            }
        }
        let auth: Vec<String> =
            serde_json::from_str(auth).map_err(|_| "Invalid owner authorization")?;
        tags.retain(|tag| tag.first().map(String::as_str) != Some("auth"));
        tags.push(auth);
        self.sign_event_after(
            0,
            serde_json::Value::Object(content).to_string(),
            tags,
            previous,
        )
    }
    pub(crate) fn profile_auth(&self, url: &str, body: &[u8]) -> Result<serde_json::Value> {
        use sha2::{Digest, Sha256};
        let mut nonce = [0; 16];
        getrandom::fill(&mut nonce).map_err(|_| "Could not authorize profile request")?;
        self.sign_event(
            27235,
            String::new(),
            vec![
                vec!["u".into(), url.into()],
                vec!["method".into(), "POST".into()],
                vec!["payload".into(), format!("{:x}", Sha256::digest(body))],
                vec![
                    "nonce".into(),
                    nonce.iter().map(|b| format!("{b:02x}")).collect(),
                ],
            ],
        )
    }
    /// NIP-98 event authorizing one POST of `body` to a connected app's `url`,
    /// carrying the owner's NIP-OA attestation (a JSON tag) when supplied.
    pub fn app_request_auth(
        &self,
        url: &str,
        body: &[u8],
        attestation: Option<&str>,
    ) -> Result<serde_json::Value> {
        use sha2::{Digest, Sha256};
        let mut tags = vec![
            vec!["u".into(), url.into()],
            vec!["method".into(), "POST".into()],
            vec!["payload".into(), format!("{:x}", Sha256::digest(body))],
        ];
        if let Some(raw) = attestation {
            let tag: Vec<String> =
                serde_json::from_str(raw).map_err(|_| "Invalid owner authorization")?;
            if tag.len() != 4 || tag[0] != "auth" {
                return Err("Invalid owner authorization".into());
            }
            tags.push(tag);
        }
        self.sign_event(27235, String::new(), tags)
    }
    fn sign_event(
        &self,
        kind: u16,
        content: String,
        tags: Vec<Vec<String>>,
    ) -> Result<serde_json::Value> {
        self.sign_event_after(kind, content, tags, None)
    }
    fn sign_event_after(
        &self,
        kind: u16,
        content: String,
        tags: Vec<Vec<String>>,
        previous: Option<u64>,
    ) -> Result<serde_json::Value> {
        use secp256k1::Keypair;
        use serde_json::json;
        use sha2::{Digest, Sha256};
        let created_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "System clock is unavailable")?
            .as_secs();
        // NIP-01 ties choose the lower event ID. A replacement must be newer.
        let created_at = previous.map_or(created_at, |at| created_at.max(at.saturating_add(1)));
        let serialized =
            serde_json::to_vec(&json!([0, self.pubkey, created_at, kind, tags, content]))
                .map_err(|_| "Could not encode agent event")?;
        let hash = Sha256::digest(serialized);
        let mut secret =
            SecretKey::from_byte_array(*self.bytes).map_err(|_| "Invalid agent key")?;
        let mut pair = Keypair::from_secret_key(&Secp256k1::signing_only(), &secret);
        let signature = Secp256k1::signing_only()
            .sign_schnorr_no_aux_rand(&hash, &pair)
            .to_string();
        secret.non_secure_erase();
        pair.non_secure_erase();
        Ok(
            json!({"id": format!("{hash:x}"), "pubkey": self.pubkey, "created_at": created_at,
            "kind": kind, "tags": tags, "content": content, "sig": signature}),
        )
    }

    pub fn parse(text: &str, expected: &str) -> Result<Self> {
        let mut bytes = Zeroizing::new([0; 32]);
        if text.len() == 64 && text.bytes().all(|c| c.is_ascii_hexdigit()) {
            for (i, pair) in text.as_bytes().chunks_exact(2).enumerate() {
                let digit = |c: u8| {
                    if c <= b'9' {
                        c - b'0'
                    } else {
                        c.to_ascii_lowercase() - b'a' + 10
                    }
                };
                bytes[i] = digit(pair[0]) * 16 + digit(pair[1]);
            }
        } else {
            if text.len() != 63 || !text.starts_with("nsec1") {
                return Err("Agent key is malformed".into());
            }
            let checked =
                CheckedHrpstring::new::<Bech32>(text).map_err(|_| "Agent key is malformed")?;
            let mut values = checked.byte_iter();
            for b in bytes.iter_mut() {
                *b = values.next().ok_or("Agent key is malformed")?;
            }
            if values.next().is_some() {
                return Err("Agent key is malformed".into());
            }
        }
        let mut key = SecretKey::from_byte_array(*bytes).map_err(|_| "Agent key is malformed")?;
        let pubkey = PublicKey::from_secret_key(&Secp256k1::signing_only(), &key)
            .x_only_public_key()
            .0
            .to_string();
        key.non_secure_erase();
        if pubkey != expected {
            return Err("Agent key does not match the selected identity".into());
        }
        Ok(Self { bytes, pubkey })
    }
    pub fn pubkey(&self) -> &str {
        &self.pubkey
    }
    pub fn hex(&self) -> Zeroizing<String> {
        use std::fmt::Write;
        let mut output = Zeroizing::new(String::with_capacity(64));
        for byte in self.bytes.iter() {
            write!(&mut *output, "{byte:02x}").expect("string formatting");
        }
        output
    }
}
/// Native OS adapter; tests inject isolated memory credentials. No silent fallback
/// to plaintext private-key files and no overwrite of existing or legacy entries.
pub trait Credentials: Send + Sync {
    /// A deliberate Start/Retry may reopen a previously refused unlock. Restore
    /// and observation must never turn denial into a series of automatic prompts.
    fn retry(&self) {}
    /// Read only this selected source; absence/denial must not search another service.
    fn read_legacy(&self, source: crate::LegacySource, pubkey: &str) -> Result<Secret>;
    fn read(&self, id: &str, pubkey: &str) -> Result<Option<Secret>>;
    fn add(&self, id: &str, key: &Secret) -> Result<()>;
    /// Remove only this app's exact saved key. Absence is successful for retry.
    fn delete(&self, id: &str, pubkey: &str) -> Result<()>;
}

/// V1 starts only unrestricted, verified NIP-OA credentials. Conditional grants
/// remain saved but need event-aware readiness rather than a misleading Ready.
pub(crate) fn validate_attestation(raw: &str, agent: &str) -> Result<()> {
    use secp256k1::{schnorr::Signature, XOnlyPublicKey};
    use sha2::{Digest, Sha256};
    if raw.len() > 4096 {
        return Err("Saved owner attestation is too large".into());
    }
    let tag: Vec<String> =
        serde_json::from_str(raw).map_err(|_| "Saved owner attestation is malformed")?;
    if tag.len() != 4
        || tag[0] != "auth"
        || tag[1] == agent
        || !crate::config::canonical_key(&tag[1])
        || tag[3].len() != 128
        || !tag[3]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("Saved owner attestation is malformed".into());
    }
    let owner: XOnlyPublicKey = tag[1].parse().map_err(|_| "Invalid attestation owner")?;
    let signature: Signature = tag[3]
        .parse()
        .map_err(|_| "Invalid owner attestation signature")?;
    let digest = Sha256::digest(format!("nostr:agent-auth:{agent}:{}", tag[2]));
    Secp256k1::verification_only()
        .verify_schnorr(&signature, &digest, &owner)
        .map_err(|_| "Owner attestation does not authorize this agent key")?;
    if !tag[2].is_empty() {
        return Err("Conditional owner attestations need event-aware readiness; this controller cannot start them yet".into());
    }
    Ok(())
}
#[cfg(test)]
pub(crate) fn test_attestation(agent: &str) -> String {
    use secp256k1::Keypair;
    use sha2::{Digest, Sha256};
    let secp = Secp256k1::new();
    let mut bytes = [0; 32];
    bytes[31] = 2;
    let pair = Keypair::from_secret_key(&secp, &SecretKey::from_byte_array(bytes).unwrap());
    let digest = Sha256::digest(format!("nostr:agent-auth:{agent}:"));
    let sig = secp.sign_schnorr_no_aux_rand(&digest, &pair);
    serde_json::to_string(&[
        "auth",
        &pair.x_only_public_key().0.to_string(),
        "",
        &sig.to_string(),
    ])
    .unwrap()
}
