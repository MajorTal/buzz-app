//! Public-only, purpose-bound community IPC. Errors never echo request data.
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type Result<T> = std::result::Result<T, CommunityError>;
pub(super) const MAX_INPUT: usize = 68 * 1024;
pub(super) const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Code {
    InvalidInput,
    Cancelled,
    Busy,
    Denied,
    Unavailable,
    InvalidResponse,
    Rejected,
    RateLimited,
    PolicyRequired,
    PolicyChanged,
    InviteInvalid,
    InviteExpired,
    InviteExhausted,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    NotSent,
    Rejected,
    Unknown,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunityError {
    pub code: Code,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<Outcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
}
impl From<Code> for CommunityError {
    fn from(code: Code) -> Self {
        Self {
            code,
            outcome: None,
            http_status: None,
            retry_after_ms: None,
        }
    }
}
impl CommunityError {
    pub(super) fn outcome(mut self, value: Outcome) -> Self {
        self.outcome = Some(value);
        self
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scope {
    pub origin: String,
    pub expected_pubkey: String,
    pub generation: String,
    pub revocation: String,
}
#[derive(Debug, Serialize)]
pub struct Reply<T> {
    pub scope: Scope,
    pub value: T,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Discover {
    pub scope: Scope,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Query {
    pub scope: Scope,
    pub filters: Value,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Template {
    pub kind: u16,
    pub created_at: u64,
    pub content: String,
    pub tags: Vec<Vec<String>>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Event {
    pub id: String,
    pub pubkey: String,
    pub sig: String,
    pub kind: u16,
    pub created_at: u64,
    pub content: String,
    pub tags: Vec<Vec<String>>,
}
impl Event {
    pub fn template(&self) -> Template {
        Template {
            kind: self.kind,
            created_at: self.created_at,
            content: self.content.clone(),
            tags: self.tags.clone(),
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Sign {
    pub scope: Scope,
    pub template: Template,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Publish {
    pub scope: Scope,
    pub event: Event,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct AcceptPolicy {
    pub scope: Scope,
    pub code: String,
    pub policy_version: String,
    pub age_confirmed: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Claim {
    pub scope: Scope,
    pub code: String,
    pub policy_receipt: Option<String>,
}

/// Bound serialization before a second request allocation, including nested values.
pub(super) fn bounded(value: &impl Serialize, limit: usize) -> Result<()> {
    struct Budget(usize);
    impl std::io::Write for Budget {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self
                .0
                .checked_sub(bytes.len())
                .ok_or_else(|| std::io::Error::other("input budget"))?;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    serde_json::to_writer(Budget(limit), value).map_err(|_| Code::InvalidInput.into())
}
pub(super) fn parse<T: serde::de::DeserializeOwned>(value: Value) -> Result<T> {
    bounded(&value, MAX_INPUT)?;
    serde_json::from_value(value).map_err(|_| Code::InvalidInput.into())
}
pub(super) fn json(value: &impl Serialize) -> Result<Value> {
    serde_json::to_value(value).map_err(|_| Code::Unavailable.into())
}
