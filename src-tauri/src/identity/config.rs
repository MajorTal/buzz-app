use super::dto::{ErrorCode, Result};
use std::{ffi::OsString, path::Path};

pub(super) fn namespace(profile: Option<OsString>, home: Option<OsString>) -> Result<String> {
    let explicit = profile.is_some();
    let profile = profile
        .unwrap_or_else(|| "default".into())
        .into_string()
        .map_err(|_| ErrorCode::InvalidConfiguration)?;
    buzzodz_plugins::valid_id(&profile).map_err(|_| ErrorCode::InvalidConfiguration)?;
    if let Some(home) = home {
        // A temporary app-data directory must never implicitly select real default keys.
        if !Path::new(&home).is_absolute() || !explicit || profile == "default" {
            return Err(ErrorCode::InvalidConfiguration.into());
        }
    }
    Ok(format!("dev.local.buzz.foundation.identity.v1.{profile}"))
}
