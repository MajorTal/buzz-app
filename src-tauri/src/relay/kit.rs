use super::*;
use serde_json::Value;

const KIT_TAG: &str = "buzz-channel-kit-v1";
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn text(value: Option<&Value>, max: usize, required: bool) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|s| s.chars().count() <= max && (!required || !s.trim().is_empty()))
}
fn keys(value: Option<&Value>, max: usize, ids: bool) -> bool {
    let Some(list) = value.and_then(Value::as_array) else {
        return false;
    };
    let mut unique = std::collections::HashSet::new();
    list.len() <= max
        && list.iter().all(|v| {
            v.as_str().is_some_and(|s| {
                (if ids {
                    identifier(s)
                } else {
                    super::hex_key(s)
                }) && unique.insert(s)
            })
        })
}
fn lineup(value: &Value) -> bool {
    keys(value.get("teamIds"), 100, true)
        && keys(value.get("agents"), 200, false)
        && text(value.get("canvas"), 24 * 1024, false)
        && value["canvas"]
            .as_str()
            .is_some_and(|s| s.len() <= 24 * 1024)
}
fn only(value: &Value, allowed: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|map| map.keys().all(|key| allowed.contains(&key.as_str())))
}
fn exact_lineup(value: &Value, allowed: &[&str]) -> bool {
    only(value, allowed) && lineup(value)
}
fn record(raw: &Value, community: &str) -> Result<String> {
    let bytes = serde_json::to_vec(raw).map_err(|_| "Invalid channel recipe")?;
    if !only(raw, &["version", "community", "deleted", "value"])
        || bytes.len() > 16 * 1024
        || raw.get("version") != Some(&Value::from(1))
        || raw.get("community").and_then(Value::as_str) != Some(community)
        || !raw.get("deleted").is_some_and(Value::is_boolean)
    {
        return Err("Invalid channel recipe".into());
    }
    let value = raw.get("value").ok_or("Invalid channel recipe")?;
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .ok_or("Invalid channel recipe")?;
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .ok_or("Invalid channel recipe")?;
    let valid = match kind {
        "team" => {
            only(value, &["type", "id", "name", "agents"])
                && identifier(id)
                && text(value.get("name"), 120, true)
                && keys(value.get("agents"), 200, false)
        }
        "template" => {
            exact_lineup(
                value,
                &[
                    "type",
                    "id",
                    "name",
                    "description",
                    "teamIds",
                    "agents",
                    "canvas",
                ],
            ) && identifier(id)
                && text(value.get("name"), 120, true)
                && text(value.get("description"), 1000, false)
        }
        "groups" => {
            if id != "personal" || !only(value, &["type", "id", "groups", "assignments"]) {
                return Err("Invalid channel recipe".into());
            }
            let Some(groups) = value.get("groups").and_then(Value::as_array) else {
                return Err("Invalid channel recipe".into());
            };
            let mut names = std::collections::HashSet::new();
            groups.len() <= 100
                && groups.iter().all(|g| {
                    only(g, &["id", "name", "defaultTemplateId"])
                        && g.get("id")
                            .and_then(Value::as_str)
                            .is_some_and(|s| identifier(s) && names.insert(s))
                        && text(g.get("name"), 120, true)
                        && g.get("defaultTemplateId")
                            .and_then(Value::as_str)
                            .is_some_and(|s| s.is_empty() || identifier(s))
                })
                && value
                    .get("assignments")
                    .and_then(Value::as_object)
                    .is_some_and(|a| {
                        a.len() <= 1000
                            && a.iter().all(|(channel, group)| {
                                super::channel_writes::uuid(channel)
                                    && group.as_str().is_some_and(|s| names.contains(s))
                            })
                    })
        }
        _ => false,
    };
    if !valid {
        return Err("Invalid channel recipe".into());
    }
    // encodeURIComponent for an HTTPS origin leaves only alphanumeric, -_.!~*'() unescaped.
    let encoded: String = community
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    Ok(format!("{KIT_TAG}:{encoded}:{kind}:{id}"))
}
pub(super) fn admission(event: &Value, raw: &Value, community: &str) -> Result<()> {
    let coordinate = record(raw, community)?;
    let tags = event
        .get("tags")
        .and_then(Value::as_array)
        .ok_or("Invalid channel recipe")?;
    let mut d = 0;
    let mut t = 0;
    for tag in tags {
        let items = tag.as_array().ok_or("Invalid channel recipe")?;
        if items.len() != 2 {
            return Err("Invalid channel recipe".into());
        }
        match items[0].as_str() {
            Some("d") if items[1].as_str() == Some(&coordinate) => d += 1,
            Some("t") if items[1].as_str() == Some(KIT_TAG) => t += 1,
            Some("client-id") if items[1].as_str().is_some_and(|s| s.len() <= 128) => (),
            _ => return Err("Invalid channel recipe".into()),
        }
    }
    if d != 1 || t != 1 {
        return Err("Invalid channel recipe".into());
    }
    Ok(())
}

pub(super) async fn validate_ciphertext(
    host: &IdentityHost,
    event: &Value,
    community: &str,
) -> Result<Value> {
    if event.get("kind") != Some(&Value::from(30078)) {
        return Err("Invalid channel recipe".into());
    }
    let ciphertext = event
        .get("content")
        .and_then(Value::as_str)
        .ok_or("Invalid channel recipe")?;
    if ciphertext.len() > 24 * 1024 {
        return Err("Invalid channel recipe".into());
    }
    let plaintext = host.kit_cipher(ciphertext.to_owned(), false).await?;
    if plaintext.len() > 16 * 1024 {
        return Err("Invalid channel recipe".into());
    }
    let raw: Value = serde_json::from_str(&plaintext).map_err(|_| "Invalid channel recipe")?;
    admission(event, &raw, community)?;
    Ok(raw)
}

pub(super) fn prepare(raw: &Value, community: &str) -> Result<()> {
    record(raw, community).map(|_| ())
}

#[tauri::command]
pub(crate) async fn relay_kit_sign(
    host: tauri::State<'_, IdentityHost>,
    community: String,
    event: crate::identity::EventTemplate,
) -> Result<Value> {
    origin(&community)?;
    let raw = serde_json::to_value(&event).map_err(|_| "Invalid channel recipe")?;
    validate_ciphertext(host.inner(), &raw, &community).await?;
    host.sign(event).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recipe_boundary_rejects_cross_community_and_invalid_values() {
        let community = "https://relay.test";
        let mut record = serde_json::json!({"version":1,"community":community,"deleted":false,
          "value":{"type":"team","id":"team-one","name":"Team","agents":[]}});
        assert!(prepare(&record, community).is_ok());
        assert!(prepare(&record, "https://other.test").is_err());
        record["value"]["agents"] = serde_json::json!(["invalid"]);
        assert!(prepare(&record, community).is_err());
    }
}

#[cfg(test)]
mod crypto_tests {
    use super::*;
    #[tokio::test]
    async fn kit_crypto_round_trips_and_enforces_coordinate_and_community() {
        let host = IdentityHost::fixture();
        let community = "https://relay.test";
        let raw = serde_json::json!({"version":1,"community":community,"deleted":false,
            "value":{"type":"team","id":"team-one","name":"Team","agents":[]}});
        let ciphertext = host.kit_cipher(raw.to_string(), true).await.unwrap();
        let coordinate = record(&raw, community).unwrap();
        let event = serde_json::json!({"kind":30078,"content":ciphertext,"tags":[["d",coordinate],["t",KIT_TAG]]});
        validate_ciphertext(&host, &event, community).await.unwrap();
        assert!(validate_ciphertext(&host, &event, "https://other.test")
            .await
            .is_err());
        let mut wrong = event.clone();
        wrong["tags"][0][1] = serde_json::json!("wrong");
        assert!(validate_ciphertext(&host, &wrong, community).await.is_err());
        wrong["tags"] = serde_json::json!([["d", coordinate], ["t", KIT_TAG], ["h", "injected"]]);
        assert!(validate_ciphertext(&host, &wrong, community).await.is_err());
    }
}
