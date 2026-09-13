//! Fixed-path HTTPS IO. No redirects, implicit retries, cookie jar or request ledger.
use super::{dto::*, events, Identity};
use reqwest::{Client, Request, Response};
use serde_json::Value;
use std::{
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};
use url::Url;

pub(super) const MAX_INFLIGHT: usize = 6;
pub(super) const METADATA_BYTES: usize = 1024 * 1024;
pub(super) const QUERY_BYTES: usize = 8 * 1024 * 1024;
const ERROR_BYTES: usize = 4096;

pub(crate) struct Http {
    client: Client,
    active: AtomicUsize,
    #[cfg(test)]
    destination: Url,
}
impl Http {
    pub(super) fn new() -> Result<Self> {
        // Unit/mock-handler tests must explicitly install a loopback HTTP fixture.
        #[cfg(test)]
        {
            Err(Code::Unavailable.into())
        }
        #[cfg(not(test))]
        {
            let client = client_builder()
                .https_only(true)
                .build()
                .map_err(|_| Code::Unavailable)?;
            Ok(Self {
                client,
                active: AtomicUsize::new(0),
            })
        }
    }
    pub(super) fn admit(&self) -> Result<Permit<'_>> {
        self.active
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < MAX_INFLIGHT).then_some(n + 1)
            })
            .map_err(|_| Code::Busy)?;
        Ok(Permit(self))
    }
    fn request(&self, scope: &Scope, path: &str, body: Option<Vec<u8>>) -> Result<Request> {
        let url = format!("{}{path}", scope.origin);
        let request = if let Some(bytes) = body {
            self.client
                .post(&url)
                .header("Content-Type", "application/json")
                .body(bytes)
        } else {
            self.client
                .get(&url)
                .header("Accept", "application/nostr+json")
        };
        let request = request.build().map_err(|_| Code::InvalidInput)?;
        Ok(request)
    }
}
fn client_builder() -> reqwest::ClientBuilder {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(5))
        .pool_idle_timeout(Duration::from_secs(60))
        .pool_max_idle_per_host(2)
}
/// The handler selects a purpose, never a renderer-supplied URL/auth policy.
pub(super) enum Operation {
    Metadata,
    Policy,
    Query,
    Publish,
    AcceptPolicy,
    Claim,
}
impl Operation {
    fn policy(&self) -> (&'static str, bool, usize, bool) {
        match self {
            Self::Metadata => ("/", false, METADATA_BYTES, false),
            Self::Policy => ("/api/join-policy", false, METADATA_BYTES, false),
            Self::Query => ("/query", true, QUERY_BYTES, false),
            Self::Publish => ("/events", true, ERROR_BYTES, true),
            Self::AcceptPolicy => ("/api/invites/accept-policy", false, ERROR_BYTES, true),
            Self::Claim => ("/api/invites/claim", true, ERROR_BYTES, true),
        }
    }
}
pub(super) struct Permit<'a>(&'a Http);
impl Drop for Permit<'_> {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::AcqRel);
    }
}
impl Permit<'_> {
    /// The authority lock covers only signing and synchronous dispatch admission.
    /// execute's future is awaited AFTER releasing the lock; sign-out never waits on IO.
    pub(super) async fn request(
        &self,
        identity: &Identity,
        scope: &Scope,
        operation: Operation,
        body: Option<Value>,
    ) -> Result<Value> {
        let (path, authenticated, limit, write) = operation.policy();
        let bytes = body
            .as_ref()
            .map(serde_json::to_vec)
            .transpose()
            .map_err(|_| Code::InvalidInput)?;
        let mut request = self.0.request(scope, path, bytes.clone())?;
        let pending = identity.with_relay_key(scope, |key| {
            if authenticated {
                let auth = events::authorization(
                    key,
                    request.url().as_str(),
                    bytes.as_deref().unwrap_or_default(),
                )?;
                request.headers_mut().insert(
                    reqwest::header::AUTHORIZATION,
                    auth.parse().map_err(|_| Code::Unavailable)?,
                );
            }
            #[cfg(test)]
            {
                // Only the socket destination changes in fixtures. Purpose selection,
                // exact auth URL/body, origin validation and redirect policy are production.
                let mut target = self.0.destination.clone();
                target.set_path(path);
                *request.url_mut() = target;
            }
            Ok(self.0.client.execute(request))
        })?;
        let response = pending
            .await
            .map_err(|_| unknown(write, Code::Unavailable))?;
        // This is a late-result fence, not a claim that sign-out undid a remote write.
        identity.with_relay_key(scope, |_| Ok(())).map_err(|e| {
            if write {
                e.outcome(Outcome::Unknown)
            } else {
                e
            }
        })?;
        let status = response.status().as_u16();
        let ok = response.status().is_success();
        let raw = read_body(response, if ok { limit } else { ERROR_BYTES }).await;
        identity.with_relay_key(scope, |_| Ok(())).map_err(|e| {
            if write {
                e.outcome(Outcome::Unknown)
            } else {
                e
            }
        })?;
        if !ok {
            // Error body parse failure cannot invent a quota reason. A bounded,
            // definitive HTTP rejection remains a rejection even without JSON.
            return Err(http_error(status, raw.ok().as_deref(), write));
        }
        let raw = raw.map_err(|_| unknown(write, Code::InvalidResponse))?;
        serde_json::from_slice(&raw).map_err(|_| unknown(write, Code::InvalidResponse))
    }
}
pub(super) fn unknown(write: bool, code: Code) -> CommunityError {
    let error: CommunityError = code.into();
    if write {
        error.outcome(Outcome::Unknown)
    } else {
        error
    }
}
async fn read_body(mut response: Response, limit: usize) -> Result<Vec<u8>> {
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err(Code::InvalidResponse.into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Code::Unavailable)? {
        if chunk.len() > limit.saturating_sub(bytes.len()) {
            return Err(Code::InvalidResponse.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
fn http_error(status: u16, body: Option<&[u8]>, write: bool) -> CommunityError {
    let parsed: Value = body
        .and_then(|b| serde_json::from_slice(b).ok())
        .unwrap_or(Value::Null);
    let reason = parsed.get("error").and_then(Value::as_str).unwrap_or("");
    let quota = status == 429
        && (reason == "rate-limited: quota exceeded"
            || reason.starts_with("rate-limited: quota exceeded;"));
    let code = match (status, reason) {
        (_, _) if quota => Code::RateLimited,
        (403, "join_policy_required") => Code::PolicyRequired,
        (400, "join_policy_not_accepted") => Code::PolicyChanged,
        (403, "invite_invalid") => Code::InviteInvalid,
        (403, "invite_expired") => Code::InviteExpired,
        (403, "invite_exhausted") => Code::InviteExhausted,
        (401 | 403, _) => Code::Denied,
        (400 | 404 | 413 | 422, _) => Code::Rejected,
        _ => Code::Unavailable,
    };
    let definitive = matches!(status, 400 | 401 | 403 | 404 | 413 | 422) || quota;
    CommunityError {
        code,
        http_status: Some(status),
        outcome: write.then_some(if definitive {
            Outcome::Rejected
        } else {
            Outcome::Unknown
        }),
        retry_after_ms: quota.then(|| {
            let seconds = reason
                .strip_prefix("rate-limited: quota exceeded; retry in ")
                .and_then(|s| s.strip_suffix('s'))
                .and_then(|s| s.parse::<u64>().ok())
                .filter(|n| *n <= 86400)
                .unwrap_or(86400);
            (seconds + 1) * 1000
        }),
    }
}
/// Reject spelling that URL parsers otherwise silently strip or repair.
pub(super) fn origin(input: &str) -> Result<String> {
    let input = input.trim();
    if input.len() > 2048 {
        return Err(Code::InvalidInput.into());
    }
    let (scheme, authority) = input.split_once("://").ok_or(Code::InvalidInput)?;
    if !(scheme.eq_ignore_ascii_case("https") || scheme.eq_ignore_ascii_case("wss")) {
        return Err(Code::InvalidInput.into());
    }
    let authority = authority.strip_suffix('/').unwrap_or(authority);
    if authority.is_empty()
        || authority
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || "/?@#\\".contains(c))
    {
        return Err(Code::InvalidInput.into());
    }
    let mut url = Url::parse(&format!("https://{authority}")).map_err(|_| Code::InvalidInput)?;
    let parsed_host = url.host_str().ok_or(Code::InvalidInput)?;
    let host = parsed_host
        .strip_suffix('.')
        .unwrap_or(parsed_host)
        .to_owned();
    if host.is_empty() {
        return Err(Code::InvalidInput.into());
    }
    url.set_host(Some(&host)).map_err(|_| Code::InvalidInput)?;
    Ok(url.origin().ascii_serialization())
}

#[cfg(test)]
impl Http {
    pub(super) fn fixture(destination: Url, timeout: Duration) -> Self {
        assert_eq!(destination.scheme(), "http");
        assert_eq!(destination.host_str(), Some("127.0.0.1"));
        Self {
            client: client_builder()
                .no_proxy()
                .timeout(timeout)
                .build()
                .unwrap(),
            active: AtomicUsize::new(0),
            destination,
        }
    }
}
