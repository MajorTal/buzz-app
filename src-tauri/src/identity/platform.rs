//! Platform adapter. No shell, environment credentials, migration, update or delete.
use super::{
    dto::{ErrorCode, LegacySource, Result},
    store::CredentialStore,
};
use zeroize::Zeroizing;

pub(super) struct PlatformStore;

#[cfg(target_os = "macos")]
mod macos {
    use super::super::store::LEGACY_SERVICE;
    use super::*;
    use security_framework::os::macos::{keychain::SecKeychain, passwords::find_generic_password};

    fn map_error(error: security_framework::base::Error) -> super::super::dto::IdentityError {
        // Never surface framework Display (may include arbitrary source/context text).
        match error.code() {
            -25300 => ErrorCode::Absent,                 // errSecItemNotFound
            -25299 => ErrorCode::Occupied,               // errSecDuplicateItem
            -128 | -25293 | -25308 => ErrorCode::Denied, // cancel, auth, interaction denied
            -26275 => ErrorCode::Corrupt,                // errSecDecode
            _ => ErrorCode::Unavailable,
        }
        .into()
    }
    // Intentional compile-time guard: even accidental PlatformStore use in a
    // unit test must stop before any live OS credential operation.
    #[allow(clippy::assertions_on_constants)]
    impl CredentialStore for PlatformStore {
        fn read_legacy(&self, source: LegacySource) -> Result<Zeroizing<Vec<u8>>> {
            assert!(!cfg!(test), "Tests must never access a live Keychain");
            let account = match source {
                LegacySource::BuzzDesktopBlob => "secrets",
                LegacySource::BuzzDesktopPerKey => "identity",
            };
            // SecKeychain API matches legacy keyring's file-keychain backend, not DPK.
            let (password, _item) =
                find_generic_password(None, LEGACY_SERVICE, account).map_err(map_error)?;
            Ok(Zeroizing::new(password.to_vec()))
        }
        fn read_saved(&self, service: &str, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>> {
            assert!(!cfg!(test), "Tests must never access a live Keychain");
            // Use the same concrete default keychain as add, not the search-list first match.
            let keychain = SecKeychain::default().map_err(map_error)?;
            match keychain.find_generic_password(service, account) {
                Ok((password, _item)) => Ok(Some(Zeroizing::new(password.to_vec()))),
                Err(error) if error.code() == -25300 => Ok(None),
                Err(error) => Err(map_error(error)),
            }
        }
        fn add_saved(&self, service: &str, account: &str, value: &[u8]) -> Result<()> {
            assert!(!cfg!(test), "Tests must never access a live Keychain");
            // OS create-only is the cross-process no-overwrite gate. Never set_password.
            SecKeychain::default()
                .map_err(map_error)?
                .add_generic_password(service, account, value)
                .map_err(map_error)
        }
    }
}

#[cfg(not(target_os = "macos"))]
impl CredentialStore for PlatformStore {
    fn read_legacy(&self, _: LegacySource) -> Result<Zeroizing<Vec<u8>>> {
        Err(ErrorCode::UnsupportedPlatform.into())
    }
    fn read_saved(&self, _: &str, _: &str) -> Result<Option<Zeroizing<Vec<u8>>>> {
        Err(ErrorCode::UnsupportedPlatform.into())
    }
    fn add_saved(&self, _: &str, _: &str, _: &[u8]) -> Result<()> {
        Err(ErrorCode::UnsupportedPlatform.into())
    }
}
