//! Process-owned identity. Status and revocation never wait on credential storage.
mod config;
mod dto;
mod platform;
pub(crate) mod relay;
mod secret;
mod store;

use dto::{ErrorCode, Result, StatusState};
pub use dto::{IdentityError, IdentityStatus, ImportRequest, SignOutRequest, UnlockRequest};
use secret::{validate_pin, IdentityKey};
use std::sync::{Arc, Mutex, MutexGuard};
use store::{decode_legacy, decode_saved, encode_saved, CredentialStore};

struct Authority {
    generation: u64,
    revocation: String,
    key: Option<IdentityKey>,
    reason: Option<ErrorCode>,
    busy: bool,
}
struct Inner {
    namespace: Result<String>,
    store: Arc<dyn CredentialStore>,
    authority: Mutex<Authority>,
    relay_http: std::sync::OnceLock<relay::HttpResult>,
}
#[derive(Clone)]
pub struct Identity(Arc<Inner>);

/// Admitted BEFORE spawn_blocking. Owns the single OS-work slot even after
/// revocation. No task queue builds up behind a hung credential prompt.
struct Activation {
    identity: Identity,
    generation: u64,
    completed: bool,
}
impl Activation {
    fn current(&self) -> Result<()> {
        self.identity.current(self.generation)
    }
    fn finish(mut self, result: Result<IdentityKey>) -> Result<IdentityStatus> {
        let result = self.identity.finish(self.generation, result);
        self.completed = true;
        result
    }
}
impl Drop for Activation {
    fn drop(&mut self) {
        if !self.completed {
            // Includes worker panic/cancellation: release admission, never activate.
            let _ = self
                .identity
                .finish(self.generation, Err(ErrorCode::Unavailable.into()));
        }
    }
}

impl Identity {
    /// Public configuration only; no credential lookup, generation or network IO.
    pub fn from_env() -> Self {
        let namespace = config::namespace(
            std::env::var_os("BUZZODZ_PROFILE"),
            std::env::var_os("BUZZODZ_HOME"),
        )
        .and_then(|namespace| {
            if cfg!(target_os = "macos") {
                Ok(namespace)
            } else {
                Err(ErrorCode::UnsupportedPlatform.into())
            }
        });
        Self::new(namespace, Arc::new(platform::PlatformStore))
    }
    fn new(namespace: Result<String>, store: Arc<dyn CredentialStore>) -> Self {
        Self(Arc::new(Inner {
            namespace,
            store,
            relay_http: std::sync::OnceLock::new(),
            authority: Mutex::new(Authority {
                generation: 0,
                revocation: uuid::Uuid::new_v4().to_string(),
                key: None,
                reason: None,
                busy: false,
            }),
        }))
    }
    fn authority(&self) -> Result<MutexGuard<'_, Authority>> {
        self.0
            .authority
            .lock()
            .map_err(|_| ErrorCode::Unavailable.into())
    }
    fn snapshot(&self, state: &Authority) -> IdentityStatus {
        let reason = if state.generation == u64::MAX {
            Some(ErrorCode::Unavailable)
        } else {
            self.0
                .namespace
                .as_ref()
                .err()
                .map(|e| e.code)
                .or(state.reason)
        };
        IdentityStatus {
            state: if self.0.namespace.is_err() || state.generation == u64::MAX {
                StatusState::Unavailable
            } else if state.key.is_some() {
                StatusState::Ready
            } else {
                StatusState::SignedOut
            },
            pubkey: state.key.as_ref().map(|key| key.pubkey().to_owned()),
            generation: state.generation.to_string(),
            revocation: state.revocation.clone(),
            busy: state.busy,
            reason,
        }
    }
    pub fn status(&self) -> Result<IdentityStatus> {
        Ok(self.snapshot(&*self.authority()?))
    }
    fn revoke(state: &mut Authority) {
        state.key = None;
        state.reason = None;
        state.revocation = uuid::Uuid::new_v4().to_string();
        state.generation = state.generation.saturating_add(1);
        // Do not clear busy: an OS call may still be blocked and owns admission.
    }
    fn sign_out(&self, request: SignOutRequest) -> Result<IdentityStatus> {
        let mut state = self.authority()?;
        if request.revocation != state.revocation {
            return Err(ErrorCode::Cancelled.into());
        }
        Self::revoke(&mut state);
        Ok(self.snapshot(&state))
    }
    /// Process exit only, never registered as a renderer command.
    pub(crate) fn shutdown(&self) {
        let mut state = self.0.authority.lock().unwrap_or_else(|e| e.into_inner());
        Self::revoke(&mut state);
        // Exit is terminal, unlike an explicit sign-out. A queued handler cannot
        // unlock again while terminal/plugin shutdown is still draining.
        state.generation = u64::MAX;
    }
    fn begin(&self, pin: &str, generation: &str, revocation: &str) -> Result<Activation> {
        validate_pin(pin)?;
        self.0.namespace.as_ref().map_err(|error| *error)?;
        let mut state = self.authority()?;
        if state.generation >= u64::MAX - 2 {
            return Err(ErrorCode::Unavailable.into());
        }
        if generation != state.generation.to_string() || revocation != state.revocation {
            return Err(ErrorCode::Cancelled.into());
        }
        if state.key.is_some() || state.busy {
            return Err(ErrorCode::Busy.into());
        }
        // Consume the captured revision before scheduling; duplicates do no IO.
        state.generation += 1;
        state.reason = None;
        state.busy = true;
        Ok(Activation {
            identity: self.clone(),
            generation: state.generation,
            completed: false,
        })
    }
    fn current(&self, generation: u64) -> Result<()> {
        if generation != u64::MAX && self.authority()?.generation == generation {
            Ok(())
        } else {
            Err(ErrorCode::Cancelled.into())
        }
    }
    fn finish(&self, generation: u64, result: Result<IdentityKey>) -> Result<IdentityStatus> {
        let mut state = self.authority()?;
        let current = generation != u64::MAX && state.generation == generation;
        state.busy = false;
        state.generation = state.generation.saturating_add(1);
        if !current {
            return Err(ErrorCode::Cancelled.into());
        }
        match result {
            Ok(key) => {
                state.key = Some(key);
                state.reason = None;
                Ok(self.snapshot(&state))
            }
            Err(error) => {
                state.key = None;
                state.reason = Some(error.code);
                Err(error)
            }
        }
    }
    fn import(&self, request: ImportRequest, activation: Activation) -> Result<IdentityStatus> {
        let result = (|| {
            activation.current()?;
            let service = self.0.namespace.as_ref().map_err(|error| *error)?;
            if let Some(raw) = self.0.store.read_saved(service, &request.expected_pubkey)? {
                decode_saved(&raw)?.verify_pin(&request.expected_pubkey)?;
                return Err(ErrorCode::Occupied.into());
            }
            activation.current()?;
            let raw = self.0.store.read_legacy(request.source)?;
            let key = decode_legacy(request.source, &raw)?;
            key.verify_pin(&request.expected_pubkey)?;
            activation.current()?;
            self.0
                .store
                .add_saved(service, &request.expected_pubkey, &encode_saved(&key))?;
            // Cancellation may leave a saved copy, but cannot activate authority.
            activation.current()?;
            let saved = self
                .0
                .store
                .read_saved(service, &request.expected_pubkey)?
                .ok_or(ErrorCode::VerificationFailed)?;
            let verified = decode_saved(&saved).map_err(|_| ErrorCode::VerificationFailed)?;
            verified
                .verify_pin(&request.expected_pubkey)
                .map_err(|_| ErrorCode::VerificationFailed)?;
            if verified.bytes() != key.bytes() {
                return Err(ErrorCode::VerificationFailed.into());
            }
            Ok(verified)
        })();
        activation.finish(result)
    }
    fn unlock(&self, request: UnlockRequest, activation: Activation) -> Result<IdentityStatus> {
        let result = (|| {
            activation.current()?;
            let service = self.0.namespace.as_ref().map_err(|error| *error)?;
            let raw = self
                .0
                .store
                .read_saved(service, &request.expected_pubkey)?
                .ok_or(ErrorCode::Absent)?;
            let key = decode_saved(&raw)?;
            key.verify_pin(&request.expected_pubkey)?;
            Ok(key)
        })();
        activation.finish(result)
    }
}

#[tauri::command]
pub fn identity_status(identity: tauri::State<'_, Identity>) -> Result<IdentityStatus> {
    identity.status()
}
#[tauri::command]
pub fn identity_sign_out(
    identity: tauri::State<'_, Identity>,
    request: serde_json::Value,
) -> Result<IdentityStatus> {
    let request = serde_json::from_value(request).map_err(|_| ErrorCode::InvalidInput)?;
    identity.sign_out(request)
}
#[tauri::command]
pub async fn identity_import_legacy(
    identity: tauri::State<'_, Identity>,
    request: serde_json::Value,
) -> Result<IdentityStatus> {
    let request: ImportRequest =
        serde_json::from_value(request).map_err(|_| ErrorCode::InvalidInput)?;
    if !request.consent {
        return Err(ErrorCode::InvalidInput.into());
    }
    let activation = identity.begin(
        &request.expected_pubkey,
        &request.generation,
        &request.revocation,
    )?;
    let identity = identity.inner().clone();
    tauri::async_runtime::spawn_blocking(move || identity.import(request, activation))
        .await
        .map_err(|_| IdentityError::from(ErrorCode::Unavailable))?
}
#[tauri::command]
pub async fn identity_unlock_saved(
    identity: tauri::State<'_, Identity>,
    request: serde_json::Value,
) -> Result<IdentityStatus> {
    let request: UnlockRequest =
        serde_json::from_value(request).map_err(|_| ErrorCode::InvalidInput)?;
    let activation = identity.begin(
        &request.expected_pubkey,
        &request.generation,
        &request.revocation,
    )?;
    let identity = identity.inner().clone();
    tauri::async_runtime::spawn_blocking(move || identity.unlock(request, activation))
        .await
        .map_err(|_| IdentityError::from(ErrorCode::Unavailable))?
}

#[cfg(test)]
mod tests;
