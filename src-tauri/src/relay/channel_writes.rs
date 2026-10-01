use super::*;
use serde_json::Value;

pub(super) fn uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok()
        && value.len() == 36
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
fn tag<'a>(event: &'a EventTemplate, index: usize, name: &str) -> Option<&'a str> {
    let t = event.tags.get(index)?;
    match t.as_slice() {
        [key, value] if key == name => Some(value.as_str()),
        _ => None,
    }
}
fn common(event: &EventTemplate) -> bool {
    event.content.is_empty() && event.created_at <= i64::MAX as u64
}
fn details(event: &EventTemplate) -> bool {
    if event.kind != 9002 || !common(event) || !(3..=5).contains(&event.tags.len()) {
        return false;
    }
    let (Some(id), Some(name), Some(about)) = (
        tag(event, 0, "h"),
        tag(event, 1, "name"),
        tag(event, 2, "about"),
    ) else {
        return false;
    };
    let mut index = 3;
    if let Some(visibility) = tag(event, index, "visibility") {
        if !matches!(visibility, "private" | "open") {
            return false;
        }
        index += 1;
    }
    if let Some(ttl) = tag(event, index, "ttl") {
        if !ttl.is_empty()
            && (ttl.starts_with('0')
                || !ttl.bytes().all(|b| b.is_ascii_digit())
                || !ttl.parse::<i32>().is_ok_and(|n| n > 0))
        {
            return false;
        }
        index += 1;
    }
    uuid(id)
        && !name.is_empty()
        && name.chars().count() <= 120
        && name
            .trim_start_matches(|c: char| c == '#' || c.is_whitespace())
            .trim_end_matches(char::is_whitespace)
            == name
        && about.chars().count() <= 1000
        && !about.contains("Buzz session (")
        && index == event.tags.len()
}
fn lifecycle(event: &EventTemplate) -> bool {
    if !matches!(event.kind, 9002 | 9008 | 9022 | 41012)
        || !common(event)
        || event.tags.len() != if event.kind == 9002 { 2 } else { 1 }
    {
        return false;
    }
    tag(event, 0, "h").is_some_and(uuid)
        && (event.kind != 9002 || tag(event, 1, "archived") == Some("true"))
}
fn archive(event: &EventTemplate) -> bool {
    if !matches!(event.kind, 9035 | 9036)
        || !common(event)
        || !(2..=3).contains(&event.tags.len())
        || event.tags[0] != ["-"]
    {
        return false;
    }
    let Some(target) = tag(event, 1, "p") else {
        return false;
    };
    if !super::hex_key(target) {
        return false;
    }
    if event.tags.len() == 2 {
        return true;
    }
    let auth = &event.tags[2];
    auth.len() == 4
        && auth[0] == "auth"
        && super::hex_key(&auth[1])
        && auth[1] != target
        && auth[3].len() == 128
        && auth[3]
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn valid(route: &str, event: &EventTemplate) -> bool {
    match route {
        "channel-details" => details(event),
        "channel-lifecycle" => lifecycle(event),
        "identity-archive" => archive(event),
        _ => false,
    }
}
fn template(event: &Value) -> Result<EventTemplate> {
    super::template(event, "Invalid channel lifecycle command")
}
fn validate(route: &str, event: &Value, viewer: Option<&str>) -> Result<EventTemplate> {
    let parsed = template(event)?;
    if !valid(route, &parsed)
        || viewer.is_some_and(|v| event.get("pubkey").and_then(Value::as_str) != Some(v))
    {
        return Err("Invalid channel lifecycle command".into());
    }
    if viewer.is_some() {
        super::verify_signature(event)?;
    }
    Ok(parsed)
}

#[tauri::command]
pub(crate) async fn relay_channel_sign(
    host: tauri::State<'_, IdentityHost>,
    community: String,
    route: String,
    event: Value,
) -> Result<Value> {
    origin(&community)?;
    let parsed = validate(&route, &event, None)?;
    host.sign(parsed).await
}

#[tauri::command]
pub(crate) async fn relay_channel_publish(
    host: tauri::State<'_, IdentityHost>,
    community: String,
    route: String,
    event: Value,
) -> Result<RelayResponse> {
    let url = request_url(&community, "/events", "POST")?;
    let viewer = host.viewer().await?;
    validate(&route, &event, Some(&viewer))?;
    let body = serde_json::to_string(&event).map_err(|_| "Invalid channel lifecycle command")?;
    if body.len() > MAX_BODY {
        return Err("Invalid relay request body".into());
    }
    send(host.inner(), url, "POST", Some(body), true, MAX_RESPONSE).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn purpose_bound_templates() {
        let mut event = EventTemplate {
            kind: 9002,
            created_at: 12,
            content: String::new(),
            tags: vec![
                vec!["h".into(), uuid::Uuid::nil().to_string()],
                vec!["archived".into(), "true".into()],
            ],
        };
        assert!(valid("channel-lifecycle", &event));
        assert!(!valid("channel-details", &event));
        event.tags.push(vec!["name".into(), "injected".into()]);
        assert!(!valid("channel-lifecycle", &event));
        event.kind = 9035;
        assert!(!valid("identity-archive", &event));
        event.kind = 9002;
        event.tags = vec![
            vec!["h".into(), uuid::Uuid::nil().to_string()],
            vec!["name".into(), "C#".into()],
            vec!["about".into(), "".into()],
        ];
        assert!(valid("channel-details", &event));
        event.tags[1][1] = "#C".into();
        assert!(!valid("channel-details", &event));
    }
}

#[tauri::command]
pub(crate) async fn relay_kit_prepare(
    host: tauri::State<'_, IdentityHost>,
    community: String,
    record: Value,
) -> Result<String> {
    origin(&community)?;
    super::kit::prepare(&record, &community)?;
    let text = serde_json::to_string(&record).map_err(|_| "Invalid channel recipe")?;
    host.kit_cipher(text, true).await
}

#[tauri::command]
pub(crate) async fn relay_kit_decode(
    host: tauri::State<'_, IdentityHost>,
    community: String,
    events: Vec<Value>,
) -> Result<Vec<Value>> {
    origin(&community)?;
    if events.len() > 16
        || serde_json::to_vec(&events)
            .map_err(|_| "Invalid channel recipe")?
            .len()
            > 512 * 1024
    {
        return Err("Invalid channel recipe".into());
    }
    let viewer = host.viewer().await?;
    let mut decoded = Vec::with_capacity(events.len());
    for event in events {
        let raw: nostr::event::Event =
            serde_json::from_value(event.clone()).map_err(|_| "Invalid channel recipe")?;
        raw.verify().map_err(|_| "Invalid channel recipe")?;
        if event.get("pubkey").and_then(Value::as_str) != Some(&viewer)
            || event.get("kind") != Some(&serde_json::json!(30078))
        {
            return Err("Invalid channel recipe".into());
        }
        let record = super::kit::validate_ciphertext(host.inner(), &event, &community).await?;
        decoded.push(serde_json::json!({"eventId": event["id"], "record": record}));
    }
    Ok(decoded)
}

#[tauri::command]
pub(crate) async fn relay_direct_message(
    host: tauri::State<'_, IdentityHost>,
    community: String,
    pubkeys: Vec<String>,
) -> Result<String> {
    let url = request_url(&community, "/events", "POST")?;
    let viewer = host.viewer().await?;
    let unique: std::collections::HashSet<_> = pubkeys.iter().collect();
    if pubkeys.is_empty()
        || pubkeys.len() > 8
        || unique.len() != pubkeys.len()
        || pubkeys.iter().any(|p| !super::hex_key(p) || p == &viewer)
    {
        return Err("Choose between one and eight other people.".into());
    }
    let event = host
        .sign(EventTemplate {
            kind: 41010,
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| "System clock is unavailable")?
                .as_secs(),
            content: String::new(),
            tags: pubkeys
                .into_iter()
                .map(|p| vec!["p".into(), p])
                .chain(std::iter::once(vec![
                    "client".into(),
                    uuid::Uuid::new_v4().to_string(),
                ]))
                .collect(),
        })
        .await?;
    let body = serde_json::to_string(&event).map_err(|_| "Invalid channel lifecycle command")?;
    let response = send(host.inner(), url, "POST", Some(body), true, MAX_RESPONSE).await?;
    if response.status != 200 {
        return Err("The direct message could not be opened. Try again.".into());
    }
    let receipt: Value = serde_json::from_str(&response.body)
        .map_err(|_| "The direct message could not be opened. Try again.")?;
    if receipt.get("event_id") != event.get("id")
        || receipt.get("accepted") != Some(&Value::Bool(true))
    {
        return Err("The direct message could not be opened. Try again.".into());
    }
    let payload = receipt
        .get("message")
        .and_then(Value::as_str)
        .and_then(|m| m.strip_prefix("response:"))
        .ok_or("The direct message could not be opened. Try again.")?;
    let result: Value = serde_json::from_str(payload)
        .map_err(|_| "The relay returned an invalid direct message.")?;
    let id = result
        .get("channel_id")
        .and_then(Value::as_str)
        .ok_or("The relay returned an invalid direct message.")?;
    if !uuid(id) {
        return Err("The relay returned an invalid direct message.".into());
    }
    Ok(id.into())
}

pub(super) fn creation(event: &EventTemplate) -> bool {
    if event.kind != 9007 || !event.content.is_empty() || !(4..=7).contains(&event.tags.len()) {
        return false;
    }
    let (Some(id), Some(name), Some(visibility), Some(channel_type)) = (
        tag(event, 0, "h"),
        tag(event, 1, "name"),
        tag(event, 2, "visibility"),
        tag(event, 3, "channel_type"),
    ) else {
        return false;
    };
    if !uuid(id)
        || name.trim().is_empty()
        || name.chars().count() > 120
        || !matches!(visibility, "open" | "private")
        || channel_type != "stream"
    {
        return false;
    }
    let mut index = 4;
    if event
        .tags
        .get(index)
        .is_some_and(|t| t.first().is_some_and(|s| s == "about"))
    {
        let Some(about) = tag(event, index, "about") else {
            return false;
        };
        if about.chars().count() > 1000
            || (about.contains("Buzz session (") && !session_metadata(about))
        {
            return false;
        }
        index += 1;
    }
    if event
        .tags
        .get(index)
        .is_some_and(|t| t.first().is_some_and(|s| s == "ttl"))
    {
        let Some(ttl) = tag(event, index, "ttl") else {
            return false;
        };
        if event.tags.get(4).is_some_and(|t| {
            t.first().is_some_and(|s| s == "about") && session_metadata(&event.tags[4][1])
        }) || ttl.starts_with('0')
            || !ttl.parse::<u32>().is_ok_and(|n| n <= 2_147_483_647)
        {
            return false;
        }
        index += 1;
    }
    if event
        .tags
        .get(index)
        .is_some_and(|t| t.first().is_some_and(|s| s == "client-id"))
    {
        let Some(client) = tag(event, index, "client-id") else {
            return false;
        };
        if !uuid(client) {
            return false;
        }
        index += 1;
    }
    index == event.tags.len()
}

#[cfg(test)]
mod boundary_tests {
    use super::*;
    #[test]
    fn commands_reject_cross_route_and_foreign_signatures() {
        let host = IdentityHost::fixture();
        let template = EventTemplate {
            kind: 9002,
            created_at: 1700000010,
            content: String::new(),
            tags: vec![
                vec!["h".into(), uuid::Uuid::new_v4().to_string()],
                vec!["archived".into(), "true".into()],
            ],
        };
        let event = tauri::async_runtime::block_on(host.sign(template)).unwrap();
        assert!(validate("channel-lifecycle", &event, event["pubkey"].as_str()).is_ok());
        assert!(validate("channel-details", &event, event["pubkey"].as_str()).is_err());
        assert!(validate("channel-lifecycle", &event, Some(&"f".repeat(64))).is_err());
        let mut altered = event.clone();
        altered["tags"][1][1] = Value::String("false".into());
        assert!(validate("channel-lifecycle", &altered, event["pubkey"].as_str()).is_err());
    }
    fn details_event(extra: Vec<Vec<String>>) -> EventTemplate {
        EventTemplate {
            kind: 9002,
            created_at: 1700000010,
            content: String::new(),
            tags: vec![
                vec!["h".into(), uuid::Uuid::nil().to_string()],
                vec!["name".into(), "Team".into()],
                vec!["about".into(), "Description".into()],
            ]
            .into_iter()
            .chain(extra)
            .collect(),
        }
    }

    #[test]
    fn details_admit_visibility_and_duration_at_sign_and_publish_boundaries() {
        let host = IdentityHost::fixture();
        for visibility in [None, Some("private"), Some("open")] {
            for ttl in [None, Some(""), Some("1"), Some("86400"), Some("2147483647")] {
                let extra = [("visibility", visibility), ("ttl", ttl)]
                    .into_iter()
                    .filter_map(|(key, value)| value.map(|value| vec![key.into(), value.into()]))
                    .collect();
                let event = serde_json::to_value(details_event(extra)).unwrap();
                let parsed = validate("channel-details", &event, None)
                    .unwrap_or_else(|error| panic!("{visibility:?}/{ttl:?}: {error}"));
                assert!(validate("channel-lifecycle", &event, None).is_err());
                let signed = tauri::async_runtime::block_on(host.sign(parsed)).unwrap();
                assert!(validate("channel-details", &signed, signed["pubkey"].as_str()).is_ok());
                assert!(validate("channel-details", &signed, Some(&"f".repeat(64))).is_err());
                let mut altered = signed;
                altered["tags"][1][1] = Value::String("Tampered".into());
                assert!(validate("channel-details", &altered, altered["pubkey"].as_str()).is_err());
            }
        }
    }

    #[test]
    fn details_reject_malformed_optional_tags() {
        for extra in [
            vec![vec![]],
            vec![vec!["ttl"]],
            vec![vec!["ttl", "1", "extra"]],
            vec![vec!["visibility"]],
            vec![vec!["visibility", "open", "extra"]],
            vec![vec!["visibility", "public"]],
            vec![vec!["visibility", ""]],
            vec![vec!["archived", "true"]],
            vec![vec!["p", "injected"]],
            vec![vec!["ttl", "0"]],
            vec![vec!["ttl", "01"]],
            vec![vec!["ttl", "-1"]],
            vec![vec!["ttl", "+1"]],
            vec![vec!["ttl", " 1"]],
            vec![vec!["ttl", "1\n"]],
            vec![vec!["ttl", "1.5"]],
            vec![vec!["ttl", "1e3"]],
            vec![vec!["ttl", "2147483648"]],
            vec![vec!["ttl", "18446744073709551616"]],
            vec![vec!["ttl", "86400"], vec!["visibility", "open"]],
            vec![vec!["visibility", "private"], vec!["visibility", "open"]],
            vec![vec!["ttl", "1"], vec!["ttl", ""]],
            vec![vec!["visibility", "open"], vec!["ttl", "0"]],
            vec![
                vec!["visibility", "open"],
                vec!["ttl", "1"],
                vec!["ttl", ""],
            ],
        ] {
            let event = details_event(
                extra
                    .iter()
                    .map(|tag| tag.iter().map(|s| (*s).into()).collect())
                    .collect(),
            );
            assert!(!valid("channel-details", &event), "{extra:?}");
        }
    }

    #[test]
    fn creation_requires_the_exact_stream_command() {
        let mut event = EventTemplate {
            kind: 9007,
            created_at: 1700000010,
            content: String::new(),
            tags: vec![
                vec!["h".into(), uuid::Uuid::new_v4().to_string()],
                vec!["name".into(), "Team".into()],
                vec!["visibility".into(), "private".into()],
                vec!["channel_type".into(), "stream".into()],
            ],
        };
        assert!(creation(&event));
        for malformed in [
            vec![],
            vec!["h".into()],
            vec!["h".into(), "x".into(), "extra".into()],
        ] {
            event.tags[0] = malformed;
            assert!(!creation(&event));
        }
        event.tags[0] = vec!["h".into(), uuid::Uuid::new_v4().to_string()];
        event.tags.swap(0, 1);
        assert!(!creation(&event));
        event.tags.swap(0, 1);
        event.tags[1] = event.tags[0].clone();
        assert!(!creation(&event));
        event.tags[1] = vec!["name".into(), "Team".into()];
        event.tags.push(vec!["p".into(), "attacker".into()]);
        assert!(!creation(&event));
        event.tags.pop();
        event.tags[3][1] = "dm".into();
        assert!(!creation(&event));
    }
}

fn session_metadata(description: &str) -> bool {
    const PREFIX: &str = "Buzz session (buzz.sessions/v1)";
    description == PREFIX
        || description
            .strip_prefix(&format!("{PREFIX}\nparent:"))
            .is_some_and(uuid)
}
