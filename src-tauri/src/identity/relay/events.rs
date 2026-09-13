//! Internal NIP-01/NIP-98 construction, never a generic renderer signer.
use super::dto::*;
use crate::identity::secret::{validate_pin, IdentityKey};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use secp256k1::{schnorr::Signature, Secp256k1, XOnlyPublicKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

pub(super) fn hash(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}
pub(super) fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8] = b"0123456789abcdef";
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push(DIGITS[(byte >> 4) as usize] as char);
        text.push(DIGITS[(byte & 15) as usize] as char);
    }
    text
}
pub(super) fn is_hex(text: &str, length: usize) -> bool {
    text.len() == length
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn event_hash(template: &Template, pubkey: &str) -> Result<[u8; 32]> {
    let bytes = serde_json::to_vec(&json!([
        0,
        pubkey,
        template.created_at,
        template.kind,
        template.tags,
        template.content
    ]))
    .map_err(|_| Code::InvalidInput)?;
    Ok(hash(&bytes))
}
pub(super) fn sign(key: &IdentityKey, template: Template) -> Result<Event> {
    let id = event_hash(&template, key.pubkey())?;
    let signature = key.sign_hash(&id).map_err(|_| Code::Unavailable)?;
    Ok(Event {
        id: hex(&id),
        pubkey: key.pubkey().into(),
        sig: signature,
        kind: template.kind,
        created_at: template.created_at,
        content: template.content,
        tags: template.tags,
    })
}
pub(super) fn verify(event: &Event) -> Result<()> {
    if !is_hex(&event.id, 64) || !is_hex(&event.sig, 128) {
        return Err(Code::InvalidInput.into());
    }
    let public = event
        .pubkey
        .parse::<XOnlyPublicKey>()
        .map_err(|_| Code::InvalidInput)?;
    validate_pin(&event.pubkey).map_err(|_| Code::InvalidInput)?;
    let id = event_hash(&event.template(), &event.pubkey)?;
    if hex(&id) != event.id {
        return Err(Code::InvalidInput.into());
    }
    let signature = event
        .sig
        .parse::<Signature>()
        .map_err(|_| Code::InvalidInput)?;
    Secp256k1::verification_only()
        .verify_schnorr(&signature, &id, &public)
        .map_err(|_| Code::InvalidInput.into())
}
pub(super) fn validate_template(event: &Template, kind: u16) -> Result<()> {
    bounded(event, 64 * 1024)?;
    if event.kind != kind || event.created_at > MAX_SAFE_INTEGER {
        return Err(Code::InvalidInput.into());
    }
    match kind {
        9 => {
            let channels: Vec<_> = event
                .tags
                .iter()
                .filter(|t| t.first().is_some_and(|s| s == "h"))
                .collect();
            let references: Vec<_> = event
                .tags
                .iter()
                .filter(|t| t.first().is_some_and(|s| s == "e"))
                .collect();
            if event.content.trim().is_empty()
                || event.content.len() > 32_000
                || channels.len() != 1
                || channels[0].get(1).map_or(true, String::is_empty)
                || !(references.is_empty()
                    || (references.len() == 1
                        && references[0].len() == 4
                        && is_hex(&references[0][1], 64)
                        && references[0][2].is_empty()
                        && references[0][3] == "reply"))
            {
                return Err(Code::InvalidInput.into());
            }
        }
        0 => {
            if event.content.len() > 16_000
                || event.tags.len() > 1
                || event.tags.iter().any(|t| {
                    t.len() != 2 || t[0] != "client-id" || uuid::Uuid::parse_str(&t[1]).is_err()
                })
            {
                return Err(Code::InvalidInput.into());
            }
            let content: Value =
                serde_json::from_str(&event.content).map_err(|_| Code::InvalidInput)?;
            let object = content.as_object().ok_or(Code::InvalidInput)?;
            let name = object
                .get("name")
                .and_then(Value::as_str)
                .ok_or(Code::InvalidInput)?;
            let display = object
                .get("display_name")
                .and_then(Value::as_str)
                .ok_or(Code::InvalidInput)?;
            let picture = object
                .get("picture")
                .and_then(Value::as_str)
                .ok_or(Code::InvalidInput)?;
            if name.trim().is_empty()
                || name.encode_utf16().count() > 100
                || display != name
                || picture.encode_utf16().count() > 2048
                || (!picture.is_empty() && !picture.starts_with("https://"))
            {
                return Err(Code::InvalidInput.into());
            }
        }
        _ => return Err(Code::InvalidInput.into()),
    }
    Ok(())
}
/// Every HTTP retry gets fresh auth, never a new data event.
pub(super) fn authorization(key: &IdentityKey, url: &str, body: &[u8]) -> Result<String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| Code::Unavailable)?
        .as_secs();
    let event = sign(
        key,
        Template {
            kind: 27235,
            created_at: now,
            content: String::new(),
            tags: vec![
                vec!["u".into(), url.into()],
                vec!["method".into(), "POST".into()],
                vec!["payload".into(), hex(&hash(body))],
                vec!["nonce".into(), uuid::Uuid::new_v4().to_string()],
            ],
        },
    )?;
    Ok(format!(
        "Nostr {}",
        STANDARD.encode(serde_json::to_vec(&event).map_err(|_| Code::Unavailable)?)
    ))
}
pub(super) fn validate_invite(code: &str) -> Result<()> {
    if code.is_empty() || code.len() > 1024 {
        return Err(Code::InvalidInput.into());
    }
    let (left, right) = code.split_once('.').ok_or(Code::InvalidInput)?;
    let decoded = URL_SAFE_NO_PAD
        .decode(right)
        .map_err(|_| Code::InvalidInput)?;
    if decoded.len() != 32 || URL_SAFE_NO_PAD.encode(&decoded) != right {
        return Err(Code::InvalidInput.into());
    }
    if left != "v2" {
        let bytes = URL_SAFE_NO_PAD
            .decode(left)
            .map_err(|_| Code::InvalidInput)?;
        if bytes.is_empty() || URL_SAFE_NO_PAD.encode(&bytes) != left {
            return Err(Code::InvalidInput.into());
        }
    }
    Ok(())
}
pub(super) fn validate_filters(filters: &Value) -> Result<()> {
    bounded(filters, 64 * 1024)?;
    let filters = filters.as_array().ok_or(Code::InvalidInput)?;
    if filters.is_empty() || filters.len() > 4 {
        return Err(Code::InvalidInput.into());
    }
    for filter in filters {
        let filter = filter.as_object().ok_or(Code::InvalidInput)?;
        let limit = filter
            .get("limit")
            .and_then(Value::as_u64)
            .ok_or(Code::InvalidInput)?;
        if !(1..=500).contains(&limit) {
            return Err(Code::InvalidInput.into());
        }
        let kinds = filter.get("kinds");
        if kinds.is_none()
            && !filter
                .get("ids")
                .and_then(Value::as_array)
                .is_some_and(|a| !a.is_empty())
        {
            return Err(Code::InvalidInput.into());
        }
        for (name, value) in filter {
            let strings = || {
                value
                    .as_array()
                    .is_some_and(|a| a.iter().all(|v| v.is_string()))
            };
            let ids = || {
                value.as_array().is_some_and(|a| {
                    !a.is_empty()
                        && a.iter().all(|v| {
                            v.as_str().is_some_and(|s| {
                                !s.is_empty() && s.len() <= 64 && is_hex(s, s.len())
                            })
                        })
                })
            };
            let valid = match name.as_str() {
                "kinds" => value.as_array().is_some_and(|a| {
                    !a.is_empty() && a.iter().all(|v| v.as_u64().is_some_and(|n| n <= 65535))
                }),
                "ids" | "authors" => ids(),
                "limit" => true,
                "since" | "until" | "page" | "depth_limit" | "thread_cursor" => {
                    value.as_u64().is_some_and(|n| n <= MAX_SAFE_INTEGER)
                }
                "top_level" | "include_aux" | "include_summaries" => value.is_boolean(),
                "before_id" | "thread_cursor_id" => value.as_str().is_some_and(|s| is_hex(s, 64)),
                "search" => value.is_string(),
                "search_mode" => value
                    .as_str()
                    .is_some_and(|s| s == "prefix" || s == "fulltext"),
                "feed_types" => strings(),
                _ if name.len() == 2
                    && name.starts_with('#')
                    && name.as_bytes()[1].is_ascii_alphabetic() =>
                {
                    strings()
                }
                _ => false,
            };
            if !valid {
                return Err(Code::InvalidInput.into());
            }
        }
    }
    Ok(())
}
