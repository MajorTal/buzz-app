//! Public-only IPC. Neither requests nor responses can contain key material.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    InvalidInput,
    InvalidConfiguration,
    UnsupportedPlatform,
    Absent,
    // Stable wire variant; the implemented OS denial mapping is currently macOS-only.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Denied,
    Unavailable,
    Corrupt,
    Mismatch,
    Occupied,
    VerificationFailed,
    Cancelled,
    Busy,
}

/// Stable, redacted error: never serialize OS errors, source bytes or paths.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct IdentityError {
    pub code: ErrorCode,
}
impl From<ErrorCode> for IdentityError {
    fn from(code: ErrorCode) -> Self {
        Self { code }
    }
}
pub(super) type Result<T> = std::result::Result<T, IdentityError>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StatusState {
    SignedOut,
    Ready,
    Unavailable,
}

/// A snapshot of this process's authority, not a discovery of saved credentials.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityStatus {
    pub state: StatusState,
    pub pubkey: Option<String>,
    pub generation: String,
    pub revocation: String,
    pub busy: bool,
    pub reason: Option<ErrorCode>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LegacySource {
    BuzzDesktopBlob,
    BuzzDesktopPerKey,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportRequest {
    pub expected_pubkey: String,
    pub generation: String,
    pub revocation: String,
    pub source: LegacySource,
    pub consent: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnlockRequest {
    pub expected_pubkey: String,
    pub generation: String,
    pub revocation: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignOutRequest {
    pub revocation: String,
}
