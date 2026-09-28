//! Exact native agent profile publication; no renderer-supplied event or key.
use base64::Engine;
use buzz_agent_controller::{CreationProfile, Secret};
use serde_json::Value;

type Result<T> = std::result::Result<T, String>;
fn authorization(event: Value) -> Result<String> {
    Ok(format!(
        "Nostr {}",
        base64::engine::general_purpose::STANDARD
            .encode(serde_json::to_vec(&event).map_err(|_| "Could not authorize profile request")?)
    ))
}
async fn body(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>> {
    if !response.status().is_success() {
        return Err("Profile request refused; saved profile remains pending".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Profile response unavailable; retry publication")?
    {
        if bytes.len() + chunk.len() > limit {
            return Err("Profile response is too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
async fn current(
    client: &reqwest::Client,
    profile: &CreationProfile,
    key: &Secret,
) -> Result<Vec<Value>> {
    let query = serde_json::to_vec(
        &serde_json::json!([{ "kinds": [0], "authors": [&profile.pubkey], "limit": 5 }]),
    )
    .map_err(|_| "Could not encode profile query")?;
    let response = client
        .post(profile.query_url())
        .header("Content-Type", "application/json")
        .header(
            "Authorization",
            authorization(profile.authenticate_query(key, &query)?)?,
        )
        .header("x-auth-tag", &profile.auth)
        .body(query)
        .send()
        .await
        .map_err(|_| "Could not read current profile; saved profile remains pending")?;
    serde_json::from_slice(&body(response, 1024 * 1024).await?)
        .map_err(|_| "Invalid current profile response".into())
}

pub(super) async fn publish<F: std::future::Future<Output = Result<()>>>(
    client: &reqwest::Client,
    profile: &CreationProfile,
    key: &Secret,
    before_send: impl FnOnce() -> F,
) -> Result<()> {
    let event = profile.event(key, &current(client, profile, key).await?)?;
    let event_id = event
        .get("id")
        .and_then(Value::as_str)
        .ok_or("Invalid profile")?;
    let bytes = serde_json::to_vec(&event).map_err(|_| "Could not encode profile")?;
    let authorization = authorization(profile.authenticate(key, &bytes)?)?;
    before_send().await?;
    let response = client
        .post(&profile.url)
        .header("Content-Type", "application/json")
        .header("Authorization", authorization)
        .header("x-auth-tag", &profile.auth)
        .body(bytes)
        .send()
        .await
        .map_err(|_| "Profile publication unconfirmed; retry this saved agent")?;
    let receipt: Value = serde_json::from_slice(&body(response, 16 * 1024).await?)
        .map_err(|_| "Invalid profile receipt; retry this saved agent")?;
    if receipt.get("accepted").and_then(Value::as_bool) != Some(true)
        || receipt.get("event_id").and_then(Value::as_str) != Some(event_id)
    {
        return Err("Profile was not accepted; retry this saved agent".into());
    }
    // A superseded replaceable event can be accepted without becoming current.
    profile.confirm(&current(client, profile, key).await?, event_id)
}

#[cfg(test)]
mod tests;
