use serde::Deserialize;
use uuid::Uuid;

/// Public presentation context, captured once when the shell starts. Never credentials.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TerminalContext {
    pub channel_id: String,
    pub channel_name: String,
    pub thread_id: Option<String>,
    pub npub: String,
    pub relay_url: String,
}

impl TerminalContext {
    pub(super) fn validate(&self) -> Result<(), String> {
        Uuid::parse_str(&self.channel_id).map_err(|_| "Invalid terminal channel UUID")?;
        if self.channel_name.len() > 1024 {
            return Err("Terminal channel name is too long".into());
        }
        if self
            .thread_id
            .as_ref()
            .is_some_and(|id| id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Err("Invalid terminal thread ID".into());
        }
        // Metadata only, not identity authority. Restrict to the npub alphabet.
        if self.npub.len() != 63
            || !self.npub.starts_with("npub1")
            || !self.npub[5..]
                .bytes()
                .all(|b| b"qpzry9x8gf2tvdw0s3jn54khce6mua7l".contains(&b))
        {
            return Err("Invalid terminal public npub".into());
        }
        if self.relay_url.len() > 2048 {
            return Err("Terminal relay URL is too long".into());
        }
        let url = url::Url::parse(&self.relay_url).map_err(|_| "Invalid terminal relay URL")?;
        if !matches!(url.scheme(), "ws" | "wss")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || url.query().is_some()
            || self.relay_url.chars().any(|c| c.is_control())
        {
            return Err("Terminal relay URL must be a credential-free ws/wss URL".into());
        }
        Ok(())
    }

    #[cfg(unix)]
    pub(super) fn display(&self) -> &str {
        if !self.channel_name.is_empty()
            && self.channel_name.chars().count() <= 64
            && self
                .channel_name
                .chars()
                .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.'))
        {
            &self.channel_name
        } else {
            &self.channel_id
        }
    }
}
