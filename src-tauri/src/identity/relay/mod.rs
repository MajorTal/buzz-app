//! Seven fixed-purpose native community operations. Identity owns keys; the host
//! session/outbox owns durable data events, retry intent and delivery state.
mod dto;
mod events;
mod http;
use super::{
    secret::{validate_pin, IdentityKey},
    Identity,
};
use dto::*;
use serde_json::{json, Value};
pub(crate) type HttpResult = Result<http::Http>;

impl Identity {
    fn with_relay_key<T>(
        &self,
        scope: &Scope,
        action: impl FnOnce(&IdentityKey) -> Result<T>,
    ) -> Result<T> {
        let state = self.authority().map_err(|_| Code::Unavailable)?;
        if self.0.namespace.is_err() || state.generation == u64::MAX {
            return Err(Code::Unavailable.into());
        }
        if scope.generation != state.generation.to_string() || scope.revocation != state.revocation
        {
            return Err(Code::Cancelled.into());
        }
        let key = state.key.as_ref().ok_or(Code::Denied)?;
        if key.pubkey() != scope.expected_pubkey {
            return Err(Code::Cancelled.into());
        }
        action(key)
    }
    fn relay_scope(&self, mut scope: Scope) -> Result<Scope> {
        scope.origin = http::origin(&scope.origin)?;
        validate_pin(&scope.expected_pubkey).map_err(|_| Code::InvalidInput)?;
        if scope.generation.len() > 20
            || scope.generation.parse::<u64>().is_err()
            || uuid::Uuid::parse_str(&scope.revocation).is_err()
        {
            return Err(Code::InvalidInput.into());
        }
        self.with_relay_key(&scope, |_| Ok(()))?;
        Ok(scope)
    }
    fn relay_http(&self) -> Result<&http::Http> {
        self.0
            .relay_http
            .get_or_init(http::Http::new)
            .as_ref()
            .map_err(|e| *e)
    }
}
fn not_sent<T>(result: Result<T>) -> Result<T> {
    result.map_err(|e| {
        if e.outcome.is_none() {
            e.outcome(Outcome::NotSent)
        } else {
            e
        }
    })
}
fn reply(identity: &Identity, scope: Scope, value: Value, write: bool) -> Result<Reply<Value>> {
    identity.with_relay_key(&scope, |_| Ok(())).map_err(|e| {
        if write {
            e.outcome(Outcome::Unknown)
        } else {
            e
        }
    })?;
    Ok(Reply { scope, value })
}
fn optional_text(value: &Value, name: &str, limit: usize) -> Result<Option<String>> {
    match value.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if text.len() <= limit => Ok(Some(text.clone())),
        _ => Err(Code::InvalidResponse.into()),
    }
}
fn policy(raw: &Value) -> Result<Value> {
    let Some(value) = raw.get("policy").filter(|p| !p.is_null()) else {
        return Ok(Value::Null);
    };
    let version = value
        .get("version")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 1024)
        .ok_or(Code::InvalidResponse)?;
    let age = value
        .get("age_attestation_required")
        .and_then(Value::as_bool)
        .ok_or(Code::InvalidResponse)?;
    let mut result = json!({"version": version, "age_attestation_required": age});
    for field in ["terms_markdown", "privacy_markdown"] {
        if let Some(text) = optional_text(value, field, http::METADATA_BYTES)? {
            result[field] = text.into();
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn community_discover(
    identity: tauri::State<'_, Identity>,
    request: Value,
) -> Result<Reply<Value>> {
    let request: Discover = parse(request)?;
    let scope = identity.relay_scope(request.scope)?;
    let http = identity.relay_http()?.admit()?;
    let nip11 = http
        .request(&identity, &scope, http::Operation::Metadata, None)
        .await?;
    if !nip11.is_object() {
        return Err(Code::InvalidResponse.into());
    }
    let author = nip11
        .get("self")
        .or_else(|| nip11.get("pubkey"))
        .and_then(Value::as_str)
        .ok_or(Code::InvalidResponse)?;
    validate_pin(author).map_err(|_| Code::InvalidResponse)?;
    let policy_response = match http
        .request(&identity, &scope, http::Operation::Policy, None)
        .await
    {
        Err(error) if error.http_status == Some(404) => json!({}),
        result => result?,
    };
    if !policy_response.is_object() {
        return Err(Code::InvalidResponse.into());
    }
    let mut value = json!({"viewer":scope.expected_pubkey,"relayAuthor":author,"policy":policy(&policy_response)?});
    if nip11.get("self").and_then(Value::as_str) == Some(author) {
        value["archiveAuthority"] = author.into();
    }
    for field in ["name", "icon"] {
        if let Some(text) = optional_text(&nip11, field, 2048)? {
            value[field] = text.into();
        }
    }
    reply(&identity, scope, value, false)
}
#[tauri::command]
pub async fn community_query(
    identity: tauri::State<'_, Identity>,
    request: Value,
) -> Result<Reply<Value>> {
    let request: Query = parse(request)?;
    let scope = identity.relay_scope(request.scope)?;
    events::validate_filters(&request.filters)?;
    let value = identity
        .relay_http()?
        .admit()?
        .request(
            &identity,
            &scope,
            http::Operation::Query,
            Some(request.filters),
        )
        .await?;
    if !value.is_array() {
        return Err(Code::InvalidResponse.into());
    }
    // Signature verification stays in the existing host eventDto transport boundary.
    reply(&identity, scope, value, false)
}
fn sign(identity: &Identity, request: Value, kind: u16) -> Result<Reply<Value>> {
    let request: Sign = parse(request)?;
    let scope = identity.relay_scope(request.scope)?;
    events::validate_template(&request.template, kind)?;
    let event = identity.with_relay_key(&scope, |key| events::sign(key, request.template))?;
    reply(identity, scope, dto::json(&event)?, false)
}
#[tauri::command]
pub fn community_sign_message(
    identity: tauri::State<'_, Identity>,
    request: Value,
) -> Result<Reply<Value>> {
    sign(&identity, request, 9)
}
#[tauri::command]
pub fn community_sign_profile(
    identity: tauri::State<'_, Identity>,
    request: Value,
) -> Result<Reply<Value>> {
    sign(&identity, request, 0)
}
#[tauri::command]
pub async fn community_publish(
    identity: tauri::State<'_, Identity>,
    request: Value,
) -> Result<Reply<Value>> {
    let prepared = (|| {
        let request: Publish = parse(request)?;
        let scope = identity.relay_scope(request.scope)?;
        if request.event.pubkey != scope.expected_pubkey {
            return Err(Code::Cancelled.into());
        }
        events::validate_template(&request.event.template(), request.event.kind)?;
        events::verify(&request.event)?;
        Ok((scope, request.event))
    })();
    let (scope, event) = not_sent(prepared)?;
    let http = not_sent(identity.relay_http().and_then(|h| h.admit()))?;
    let result = not_sent(
        http.request(
            &identity,
            &scope,
            http::Operation::Publish,
            Some(dto::json(&event)?),
        )
        .await,
    )?;
    let accepted = result
        .get("accepted")
        .and_then(Value::as_bool)
        .ok_or_else(|| http::unknown(true, Code::InvalidResponse))?;
    if result.get("event_id").and_then(Value::as_str) != Some(&event.id) {
        return Err(http::unknown(true, Code::InvalidResponse));
    }
    reply(
        &identity,
        scope,
        json!({"event_id":event.id, "accepted": accepted,
        "duplicate":result.get("message").and_then(Value::as_str).is_some_and(|s| s.starts_with("duplicate:"))}),
        true,
    )
}
#[tauri::command]
pub async fn community_accept_policy(
    identity: tauri::State<'_, Identity>,
    request: Value,
) -> Result<Reply<Value>> {
    let prepared = (|| {
        let request: AcceptPolicy = parse(request)?;
        let scope = identity.relay_scope(request.scope)?;
        events::validate_invite(&request.code)?;
        if request.policy_version.is_empty() || request.policy_version.len() > 1024 {
            return Err(Code::InvalidInput.into());
        }
        Ok((
            scope,
            json!({"code":request.code,"policy_version":request.policy_version,"age_confirmed":request.age_confirmed}),
        ))
    })();
    let (scope, body) = not_sent(prepared)?;
    let http = not_sent(identity.relay_http().and_then(|h| h.admit()))?;
    let result = not_sent(
        http.request(&identity, &scope, http::Operation::AcceptPolicy, Some(body))
            .await,
    )?;
    let receipt = result
        .get("receipt")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 2048)
        .ok_or_else(|| http::unknown(true, Code::InvalidResponse))?;
    reply(&identity, scope, json!({"receipt":receipt}), true)
}
#[tauri::command]
pub async fn community_claim(
    identity: tauri::State<'_, Identity>,
    request: Value,
) -> Result<Reply<Value>> {
    let prepared = (|| {
        let request: Claim = parse(request)?;
        let scope = identity.relay_scope(request.scope)?;
        events::validate_invite(&request.code)?;
        if request
            .policy_receipt
            .as_ref()
            .is_some_and(|s| s.is_empty() || s.len() > 2048)
        {
            return Err(Code::InvalidInput.into());
        }
        let mut body = json!({"code":request.code});
        if let Some(receipt) = request.policy_receipt {
            body["policy_receipt"] = receipt.into();
        }
        Ok((scope, body))
    })();
    let (scope, body) = not_sent(prepared)?;
    let http = not_sent(identity.relay_http().and_then(|h| h.admit()))?;
    let value = not_sent(
        http.request(&identity, &scope, http::Operation::Claim, Some(body))
            .await,
    )?;
    let host = scope
        .origin
        .strip_prefix("https://")
        .ok_or(Code::InvalidInput)?;
    if !value
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|s| s == "joined" || s == "already_member")
        || value.get("host").and_then(Value::as_str) != Some(host)
        || !value
            .get("community_id")
            .and_then(Value::as_str)
            .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok())
        || value.get("role").and_then(Value::as_str) != Some("member")
    {
        return Err(http::unknown(true, Code::InvalidResponse));
    }
    reply(
        &identity,
        scope,
        json!({"status":value["status"],"host":value["host"],"community_id":value["community_id"],"role":"member"}),
        true,
    )
}

#[cfg(test)]
mod tests;
