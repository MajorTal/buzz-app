use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;

#[test]
fn routes_cannot_retarget_credentials_or_expand_http_access() {
    for community in [
        "http://relay.test",
        "https://u:p@relay.test",
        "https://relay.test/path",
        "https://relay.test/?q",
        "https://relay.test/#x",
    ] {
        assert!(request_url(community, "/query", "POST").is_err());
    }
    for path in [
        "//other.test/query",
        "/query?target=x",
        "/api/admin",
        "/../query",
        "https://other.test/query",
    ] {
        assert!(request_url("https://relay.test", path, "POST").is_err());
    }
    assert!(request_url("https://relay.test", "/events", "GET").is_err());
    assert_eq!(
        request_url("https://relay.test", "/query", "POST")
            .unwrap()
            .as_str(),
        "https://relay.test/query"
    );
}

#[test]
fn websocket_auth_is_bound_to_the_captured_community() {
    let mut event = EventTemplate {
        kind: 22242,
        created_at: 1,
        content: "".into(),
        tags: vec![
            vec!["relay".into(), "wss://relay.test".into()],
            vec!["challenge".into(), "nonce".into()],
        ],
    };
    assert!(validate_event("https://relay.test", &event).is_ok());
    assert!(validate_event("https://other.test", &event).is_err());
    event
        .tags
        .push(vec!["relay".into(), "wss://other.test".into()]);
    assert!(validate_event("https://relay.test", &event).is_err());
    event.kind = 27235;
    assert!(validate_event("https://relay.test", &event).is_err());
}

fn fixture_server(response: String) -> (Url, std::thread::JoinHandle<(String, String)>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = Url::parse(&format!("http://{}/query", listener.local_addr().unwrap())).unwrap();
    let task = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut buffer = [0; 4096];
        loop {
            let count = socket.read(&mut buffer).unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&buffer[..count]);
            let text = String::from_utf8_lossy(&bytes);
            if let Some((headers, body)) = text.split_once("\r\n\r\n") {
                let length: usize = headers
                    .lines()
                    .find_map(|line| {
                        line.to_lowercase()
                            .strip_prefix("content-length: ")
                            .map(str::to_owned)
                    })
                    .map(|value| value.parse().unwrap())
                    .unwrap_or(0);
                if body.len() == length {
                    let result = (headers.into(), body.into());
                    socket.write_all(response.as_bytes()).unwrap();
                    return result;
                }
            }
        }
    });
    (url, task)
}

#[tokio::test]
async fn native_http_signs_exact_bytes_and_never_follows_redirects() {
    // HTTP is test-transport-only; the IPC boundary always requires HTTPS.
    let (url, task) = fixture_server("HTTP/1.1 302 Found\r\nLocation: https://other.test/\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".into());
    let body = r#"[{"kinds":[0],"limit":5}]"#;
    let result = send(
        &IdentityHost::fixture(),
        url.clone(),
        "POST",
        Some(body.into()),
        true,
        MAX_RESPONSE,
    )
    .await
    .unwrap();
    assert_eq!(result.status, 302);
    let (headers, sent) = task.join().unwrap();
    assert_eq!(sent, body);
    let encoded = headers
        .lines()
        .find_map(|line| line.strip_prefix("authorization: Nostr "))
        .unwrap();
    let event: serde_json::Value =
        serde_json::from_slice(&STANDARD.decode(encoded).unwrap()).unwrap();
    assert_eq!(event["kind"], 27235);
    assert_eq!(event["content"], "");
    assert_eq!(event["tags"][0], serde_json::json!(["u", url.as_str()]));
    assert_eq!(event["tags"][1], serde_json::json!(["method", "POST"]));
    assert_eq!(
        event["tags"][2],
        serde_json::json!(["payload", format!("{:x}", Sha256::digest(body.as_bytes()))])
    );
    verify(&event);
}

#[tokio::test]
async fn memory_response_limit_rejects_before_generic_transport_budget() {
    // The advertised size alone must be rejected. A multi-megabyte server write
    // blocks the fixture thread after the client closes on this header.
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        2 * 1024 * 1024 + 1
    );
    let (url, task) = fixture_server(response);
    let result = send(
        &IdentityHost::fixture(),
        url,
        "POST",
        Some("[]".into()),
        true,
        2 * 1024 * 1024,
    )
    .await;
    assert!(matches!(result, Err(ref message) if message == "Relay response is too large"));
    task.join().unwrap();
}

fn verify(event: &serde_json::Value) {
    let serialized = serde_json::to_vec(&serde_json::json!([
        0,
        event["pubkey"],
        event["created_at"],
        event["kind"],
        event["tags"],
        event["content"]
    ]))
    .unwrap();
    let hash = Sha256::digest(serialized);
    assert_eq!(event["id"], format!("{hash:x}"));
    let signature: secp256k1::schnorr::Signature = event["sig"].as_str().unwrap().parse().unwrap();
    let public: secp256k1::XOnlyPublicKey = event["pubkey"].as_str().unwrap().parse().unwrap();
    secp256k1::Secp256k1::verification_only()
        .verify_schnorr(&signature, &hash, &public)
        .unwrap();
}

#[test]
fn real_ipc_restores_identity_signs_and_rejects_invalid_requests() {
    // The path resolver reads HOME at runtime. Isolate it in a child rather
    // than changing process-global HOME under the parallel test runner.
    let mut child = std::process::Command::new(std::env::current_exe().unwrap());
    child.args([
        "--exact",
        "relay::tests::isolated_agent_ipc_probe",
        "--nocapture",
    ]);
    #[cfg(unix)]
    {
        let home = tempfile::tempdir().unwrap();
        #[cfg(target_os = "macos")]
        let path = home
            .path()
            .join("Library/Application Support/xyz.block.buzz.app/agents/managed-agents.json");
        #[cfg(target_os = "linux")]
        let path = home
            .path()
            .join(".local/share/xyz.block.buzz.app/agents/managed-agents.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "[]").unwrap();
        child.env("HOME", home.path()).env_remove("XDG_DATA_HOME");
        let output = child.env("BUZZ_AGENT_IPC_PROBE", "1").output().unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    #[cfg(target_os = "windows")]
    {
        let output = child.env("BUZZ_AGENT_IPC_PROBE", "1").output().unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
fn isolated_agent_ipc_probe() {
    if std::env::var("BUZZ_AGENT_IPC_PROBE").as_deref() != Ok("1") {
        return;
    }
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    #[cfg(unix)]
    use tauri::Manager;
    let app = mock_builder()
        .manage(IdentityHost::fixture())
        .invoke_handler(crate::commands())
        .build(crate::app_context())
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
        .build()
        .unwrap();
    let invoke = |cmd: &str, body: serde_json::Value| {
        get_ipc_response(
            &view,
            tauri::webview::InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: view.url().unwrap(),
                body: tauri::ipc::InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        )
        .map(|body| body.deserialize::<serde_json::Value>().unwrap())
    };
    let public = invoke("identity_restore", serde_json::json!({})).unwrap();
    let event = invoke(
        "relay_sign",
        serde_json::json!({
            "community": "https://relay.test", "event": {
                "kind": 9, "created_at": 123, "tags": [["h", "channel"]], "content": "IPC message"
            }
        }),
    )
    .unwrap();
    assert_eq!(event["pubkey"], public);
    verify(&event);
    // The old direct attestation IPC must be absent, not merely unused by the UI.
    assert!(invoke(
        "relay_agent_authorize",
        serde_json::json!({
            "community": "https://relay.test",
            "target": {"owner": public, "pubkey": "02".repeat(32)}
        }),
    )
    .is_err());
    let resolved = invoke("relay_agent_resolve", serde_json::json!({
        "community": "https://relay.test", "target": {"owner": public, "pubkey": "02".repeat(32), "confirmed": true}
    })).unwrap();
    assert_eq!(resolved["relayUrl"], "wss://relay.test");
    #[cfg(unix)]
    {
        let library = invoke("relay_agent_library", serde_json::json!({})).unwrap();
        assert_eq!(
            library,
            serde_json::json!({"definitions": [], "identities": []})
        );
        assert!(app
            .path()
            .data_dir()
            .unwrap()
            .starts_with(std::env::var("HOME").unwrap()));
    }
    // Library IPC success is exercised against an isolated HOME on Unix.
    // Windows known-folder inventory is not isolated here; do not invoke its
    // reader until a test-only fixture can control that path.
    // Each must reach the command: a handler refusal is fine; an ACL refusal is not.
    for (command, input) in [
        (
            "relay_agent_memories_read",
            serde_json::json!({"community": "https://relay.test", "agent": public}),
        ),
        (
            "relay_agent_observer",
            serde_json::json!({"community": "https://relay.test", "event": {"id": "bad"}}),
        ),
        (
            "relay_agent_log_proof",
            serde_json::json!({"community": "https://relay.test", "target": {"id": "bad", "pubkey": public, "relayUrl": "wss://relay.test", "nonce": "bad"}}),
        ),
    ] {
        let result = invoke(command, input);
        assert!(
            !format!("{result:?}").contains(&format!("{command} not allowed")),
            "ACL blocked {command}"
        );
    }
    assert!(invoke("relay_http", serde_json::json!({
        "community": "https://relay.test", "path": "//other.test/query", "method": "POST", "body": "[]"
    })).is_err());
    assert!(invoke("relay_sign", serde_json::json!({
        "community": "https://relay.test", "event": {
            "kind": 22242, "created_at": 123, "tags": [["relay", "wss://other.test"], ["challenge", "nonce"]], "content": ""
        }
    })).is_err());
    let id = "11111111-1111-4111-8111-111111111111";
    assert!(invoke(
        "relay_sign",
        serde_json::json!({
            "community": "https://relay.test", "event": {
                "kind": 5, "created_at": 123,
                "tags": [["h", id], ["a", format!("30620:{}:{id}", "a".repeat(64))]], "content": ""
            }
        })
    )
    .is_err());
    let deletion = invoke("relay_sign", serde_json::json!({
        "community": "https://relay.test", "event": {
            "kind": 5, "created_at": 123,
            "tags": [["h", id], ["a", format!("30620:{}:{id}", public.as_str().unwrap())]], "content": ""
        }
    })).unwrap();
    verify(&deletion);
    assert!(invoke(
        "relay_workflow_runs",
        serde_json::json!({
            "community": "https://relay.test", "id": "../query", "cursor": null
        })
    )
    .unwrap_err()
    .to_string()
    .contains("Invalid workflow read"));
}

#[tokio::test]
async fn signing_is_verifiable_and_does_not_export_a_key() {
    let event = IdentityHost::fixture()
        .sign(EventTemplate {
            kind: 9,
            created_at: 123,
            tags: vec![vec!["h".into(), "channel".into()]],
            content: "Hello\nfrom native".into(),
        })
        .await
        .unwrap();
    verify(&event);
    assert_eq!(
        event["pubkey"],
        "1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f"
    );
    assert!(!event.to_string().contains("nsec"));
    assert!(IdentityHost::default()
        .sign(EventTemplate {
            kind: 9,
            created_at: 0,
            tags: vec![],
            content: "".into()
        })
        .await
        .is_err());
}

#[test]
fn workflow_history_is_fixed_and_cannot_retarget_native_http() {
    let id = "11111111-1111-4111-8111-111111111111";
    let cursor = WorkflowCursor {
        before: "2026-09-29T20:00:00Z".into(),
        before_id: id.into(),
    };
    assert_eq!(workflow_runs_url("https://relay.test", id, Some(&cursor)).unwrap().as_str(),
        "https://relay.test/workflows/11111111-1111-4111-8111-111111111111/runs?limit=20&before=2026-09-29T20%3A00%3A00Z&before_id=11111111-1111-4111-8111-111111111111");
    for invalid in [
        "../query",
        "11111111-1111-4111-8111-111111111111?target=x",
        "11111111-1111-4111-8111-111111111111/../query",
    ] {
        assert!(workflow_runs_url("https://relay.test", invalid, None).is_err());
    }
    assert!(workflow_runs_url(
        "https://relay.test",
        id,
        Some(&WorkflowCursor {
            before: "2026-09-29T20:00:00Z&target=x".into(),
            before_id: id.into()
        })
    )
    .is_err());
    assert!(request_url(
        "https://relay.test",
        "/workflows/11111111-1111-4111-8111-111111111111/runs",
        "GET"
    )
    .is_err());
}

#[test]
fn workflow_signer_rejects_nonworkflow_deletes_and_invalid_commands() {
    let id = "11111111-1111-4111-8111-111111111111";
    let mut event = EventTemplate {
        kind: 5,
        created_at: 1,
        content: "".into(),
        tags: vec![
            vec!["h".into(), id.into()],
            vec!["a".into(), format!("30620:{}:{id}", "a".repeat(64))],
        ],
    };
    assert!(validate_event("https://relay.test", &event).is_ok());
    event.tags[1][1] = format!("30030:{}:{id}", "a".repeat(64));
    assert!(validate_event("https://relay.test", &event).is_err());
    event.tags[1][1] = format!("30620:{}:{id}", "a".repeat(64));
    event.tags.push(vec!["e".into(), "b".repeat(64)]);
    assert!(validate_event("https://relay.test", &event).is_err());
    event.tags.pop();
    event.kind = 46020;
    assert!(validate_event("https://relay.test", &event).is_err());
    event.tags[1] = vec!["d".into(), id.into()];
    assert!(validate_event("https://relay.test", &event).is_ok());
    event.content = "not empty".into();
    assert!(validate_event("https://relay.test", &event).is_err());
}

#[tokio::test]
async fn workflow_get_is_authenticated_without_payload_and_never_redirects() {
    let (mut url, task) = fixture_server("HTTP/1.1 302 Found\r\nLocation: https://other.test/\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".into());
    url.set_path("/workflows/11111111-1111-4111-8111-111111111111/runs");
    url.set_query(Some("limit=20"));
    let response = send(
        &IdentityHost::fixture(),
        url.clone(),
        "GET",
        None,
        true,
        1024 * 1024,
    )
    .await
    .unwrap();
    assert_eq!(response.status, 302);
    let (headers, body) = task.join().unwrap();
    assert!(headers
        .starts_with("GET /workflows/11111111-1111-4111-8111-111111111111/runs?limit=20 HTTP/1.1"));
    assert!(body.is_empty());
    let encoded = headers
        .lines()
        .find_map(|line| line.strip_prefix("authorization: Nostr "))
        .unwrap();
    let event: serde_json::Value =
        serde_json::from_slice(&STANDARD.decode(encoded).unwrap()).unwrap();
    assert_eq!(event["tags"][0], serde_json::json!(["u", url.as_str()]));
    assert_eq!(event["tags"][1], serde_json::json!(["method", "GET"]));
    assert_eq!(event["tags"].as_array().unwrap().len(), 3);
    verify(&event);
}

#[test]
fn shared_kind_five_signer_accepts_message_and_reaction_deletion_only_in_broker_shape() {
    let id = "a".repeat(64);
    let mut event = EventTemplate {
        kind: 5,
        created_at: 123,
        content: String::new(),
        tags: vec![
            vec!["h".into(), "room".into()],
            vec!["e".into(), id.clone()],
            vec!["k".into(), "9".into()],
            vec!["client-id".into(), "intent".into()],
        ],
    };
    assert!(validate_event("https://relay.test", &event).is_ok());
    event.created_at = 9_007_199_254_740_992;
    assert!(validate_event("https://relay.test", &event).is_err());
    event.created_at = 123;
    event.content = "not empty".into();
    assert!(validate_event("https://relay.test", &event).is_err());
    event.content.clear();
    event.tags[0][1].clear();
    assert!(validate_event("https://relay.test", &event).is_err());
    event.tags[0][1] = "😀".repeat(128);
    assert!(validate_event("https://relay.test", &event).is_ok());
    event.tags[0][1].push('😀');
    assert!(validate_event("https://relay.test", &event).is_err());
    event.tags[0][1] = "room".into();
    event.tags[2][1] = "7".into();
    assert!(validate_event("https://relay.test", &event).is_ok());
    event.tags[2][1] = "40002".into();
    assert!(validate_event("https://relay.test", &event).is_ok());
    event.tags[2][1] = "30620".into();
    assert!(validate_event("https://relay.test", &event).is_err());
    event.tags[2][1] = "9".into();
    event.tags.push(vec!["e".into(), id.clone()]);
    assert!(validate_event("https://relay.test", &event).is_err());
    event.tags.pop();
    event.tags[1][1] = "A".repeat(64);
    assert!(validate_event("https://relay.test", &event).is_err());
    event.tags[1][1] = id;
    event.tags.push(vec!["a".into(), "30620:other:id".into()]);
    assert!(validate_event("https://relay.test", &event).is_err());
}

#[test]
fn native_write_commands_reach_handlers_through_production_ipc() {
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    let app = mock_builder()
        .manage(IdentityHost::fixture())
        .invoke_handler(crate::commands())
        .build(crate::app_context())
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
        .build()
        .unwrap();
    let requests = [
        (
            "relay_channel_sign",
            serde_json::json!({"community":"https://relay.test","route":"channel-lifecycle","event":{"kind":9002,"created_at":1700000010,"content":"","tags":[["h","11111111-1111-4111-8111-111111111111"],["archived","true"]]}}),
        ),
        (
            "relay_kit_prepare",
            serde_json::json!({"community":"https://relay.test","record":{"version":1,"community":"https://relay.test","deleted":false,"value":{"type":"team","id":"mine","name":"Mine","agents":[]}}}),
        ),
        (
            "relay_kit_decode",
            serde_json::json!({"community":"https://relay.test","events":[]}),
        ),
        (
            "relay_kit_sign",
            serde_json::json!({"community":"invalid","event":{"kind":30078,"created_at":1,"content":"","tags":[]}}),
        ),
        (
            "relay_channel_publish",
            serde_json::json!({"community":"invalid","route":"channel-lifecycle","event":{}}),
        ),
        (
            "relay_direct_message",
            serde_json::json!({"community":"invalid","pubkeys":[]}),
        ),
    ];
    for (command, body) in requests {
        let result = get_ipc_response(
            &view,
            tauri::webview::InvokeRequest {
                cmd: command.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: view.url().unwrap(),
                body: tauri::ipc::InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        );
        if let Err(error) = result {
            assert!(
                !error.to_string().contains("not allowed"),
                "{command} blocked by ACL: {error}"
            );
        }
    }
}

#[test]
fn channel_commands_reject_malformed_tags_through_ipc() {
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    let app = mock_builder()
        .manage(IdentityHost::fixture())
        .invoke_handler(crate::commands())
        .build(crate::app_context())
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
        .build()
        .unwrap();
    let invoke = |tags: Vec<Vec<String>>| {
        get_ipc_response(
            &view,
            tauri::webview::InvokeRequest {
                cmd: "relay_channel_sign".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: view.url().unwrap(),
                body: tauri::ipc::InvokeBody::Json(serde_json::json!({
                    "community": "https://relay.test", "route": "channel-lifecycle",
                    "event": { "kind": 9002, "created_at": 123, "content": "", "tags": tags }
                })),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        )
    };
    let h = vec!["h".into(), uuid::Uuid::nil().to_string()];
    let archived = vec!["archived".into(), "true".into()];
    assert!(invoke(vec![h.clone(), archived.clone()]).is_ok());
    for tags in [
        vec![vec![], archived.clone()],
        vec![vec!["h".into()], archived.clone()],
        vec![h.clone(), vec!["archived".into()]],
        vec![h.clone(), h.clone()],
        vec![archived.clone(), h.clone()],
    ] {
        let error = match invoke(tags) {
            Ok(_) => panic!("invalid tag must reject"),
            Err(error) => error,
        };
        assert!(
            !error.to_string().contains("not allowed"),
            "ACL blocked command: {error}"
        );
    }
}

#[test]
fn creation_rejects_truncated_tags_through_existing_ipc() {
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    let app = mock_builder()
        .manage(IdentityHost::fixture())
        .invoke_handler(crate::commands())
        .build(crate::app_context())
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
        .build()
        .unwrap();
    for tag in [vec![], vec!["h"]] {
        let response = get_ipc_response(
            &view,
            tauri::webview::InvokeRequest {
                cmd: "relay_sign".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: view.url().unwrap(),
                body: tauri::ipc::InvokeBody::Json(serde_json::json!({
                    "community": "https://relay.test",
                    "event": { "kind": 9007, "created_at": 123, "content": "", "tags": [
                        tag, ["name", "Team"], ["visibility", "private"], ["channel_type", "stream"]
                    ] }
                })),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        );
        let error = match response {
            Ok(_) => panic!("malformed creation must reject before discovery"),
            Err(error) => error,
        };
        assert!(
            !error.to_string().contains("not allowed"),
            "ACL blocked command: {error}"
        );
    }
}

#[tokio::test]
async fn discovery_body_is_bounded_for_length_and_chunked_transfer() {
    for chunked in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let task = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0; 2048];
            loop {
                let count = socket.read(&mut buffer).unwrap();
                assert!(count > 0, "request ended before headers completed");
                bytes.extend_from_slice(&buffer[..count]);
                assert!(
                    bytes.len() <= 16 * 1024,
                    "request headers exceeded fixture limit"
                );
                if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            if chunked {
                socket.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").unwrap();
                // Valid chunked response, over the budget on the first chunk.
                socket
                    .write_all(format!("{:X}\r\n", MAX_BODY + 1).as_bytes())
                    .unwrap();
                socket.write_all(&vec![b'x'; MAX_BODY + 1]).unwrap();
                let _ = socket.write_all(b"\r\n0\r\n\r\n");
            } else {
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            MAX_BODY + 1
                        )
                        .as_bytes(),
                    )
                    .unwrap();
                // Headers alone must suffice: do not wait for the advertised body.
            }
        });
        let mut response = client().unwrap().get(url).send().await.unwrap();
        assert_eq!(
            read_bounded(&mut response, MAX_BODY, "interrupted", "oversized")
                .await
                .unwrap_err(),
            "oversized"
        );
        task.join().unwrap();
    }
}

#[tokio::test]
async fn sidebar_ipc_only_decodes_verified_self_coordinates_and_signs_valid_payloads() {
    let host = IdentityHost::fixture();
    let payload =
        serde_json::json!({"version":1,"channels":{"channel":{"starred":true,"updatedAt":1}}});
    let event = host
        .sign_sidebar("channel-stars".into(), payload.clone(), 1)
        .await
        .unwrap();
    verify(&event);
    assert_eq!(
        host.decode_sidebar(vec![event.clone()]).await.unwrap()["channel-stars"],
        payload
    );
    assert!(host
        .decode_sidebar(vec![event.clone(), event.clone()])
        .await
        .is_err());
    assert!(host.decode_sidebar(vec![event.clone(); 5]).await.is_err());
    let mut tampered = event.clone();
    tampered["content"] = serde_json::json!("changed");
    assert!(host.decode_sidebar(vec![tampered]).await.is_err());
    let mut wrong_coordinate = event.clone();
    wrong_coordinate["tags"][0][1] = serde_json::json!("unknown");
    assert!(host.decode_sidebar(vec![wrong_coordinate]).await.is_err());
    assert!(host
        .sign_sidebar("other".into(), payload.clone(), 1)
        .await
        .is_err());
    assert!(host.sign_sidebar("channel-stars".into(), serde_json::json!({"version":1,"channels":{"c":{"starred":"not boolean","updatedAt":1}}}), 1).await.is_err());
    let other = IdentityHost::fixture()
        .sign_sidebar(
            "channel-sort".into(),
            serde_json::json!({"version":1,"groups":{}}),
            1,
        )
        .await
        .unwrap();
    assert_eq!(
        host.decode_sidebar(vec![other]).await.unwrap()["channel-sort"]["version"],
        1
    );
}

#[tokio::test]
async fn sidebar_decoder_interoperates_with_nostr_tools_nip44_v2() {
    // Produced with nostr-tools 2.25.2, private key [1; 32].
    let event: serde_json::Value = serde_json::from_str(r#"{"kind":30078,"created_at":1700000000,"tags":[["d","channel-mutes"],["t","channel-mutes"]],"content":"Ajhdtq+PsGhpLGhyo0hAN55quGVmOE8/p0id4UVmJPz/Aki5aZUHWBymErqORblF9uPjX6XD5DjFJDR18qIHIIullzAvPKE5z336CV5caxsevvNkXoeRk7U0xVpk+piVfM9z2+cgyuJoG3cGMzFp78/53XHDvsEUgtE9Wv8kgvj5vQc=","pubkey":"1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f","id":"e4471969b8f1b27fad968343db8deb4346c3e530c69b548f68a6adb31f99628c","sig":"14064569d6085363f32865b2204037c4a5769a09f116209fda3790feef12e6672d1806c7626c6857d0696cfe43f39ed4a8dc13d965989300ec757fb3a2fd44cd"}"#).unwrap();
    assert_eq!(
        IdentityHost::fixture()
            .decode_sidebar(vec![event])
            .await
            .unwrap()["channel-mutes"],
        serde_json::json!({"version":1,"channels":{"cross":{"muted":true,"updatedAt":1}}})
    );
}

#[tokio::test]
async fn sidebar_signer_matches_projection_lengths_and_preserves_unknown_sort_entries() {
    let host = IdentityHost::fixture();
    let unicode = "界".repeat(120);
    let groups = serde_json::json!({"version":1,"sections":[{"id":"group","name":unicode,"order":0}],"assignments":{"c":"group"}});
    let event = host
        .sign_sidebar("channel-sections".into(), groups.clone(), 1)
        .await
        .unwrap();
    assert_eq!(
        host.decode_sidebar(vec![event]).await.unwrap()["channel-sections"],
        groups
    );
    // A valid head from another client must remain writable after a native move.
    let mut existing = groups.clone();
    existing["assignments"]["other"] = serde_json::json!("group");
    let event = host
        .sign_sidebar("channel-sections".into(), existing.clone(), 2)
        .await
        .unwrap();
    assert_eq!(
        host.decode_sidebar(vec![event]).await.unwrap()["channel-sections"],
        existing
    );
    // Same preservation vector as dev/sidebar-sort.test.mjs: unrelated modes,
    // section keys and top-level metadata survive an override update.
    let sort = serde_json::json!({"version":1,"future":{"x":1},"groups":{
        "channels":"recent","section:elsewhere":"recent","future":"next-mode","section:work":"recent"
    }});
    let event = host
        .sign_sidebar("channel-sort".into(), sort.clone(), 1)
        .await
        .unwrap();
    assert_eq!(
        host.decode_sidebar(vec![event]).await.unwrap()["channel-sort"],
        sort
    );
    assert!(host.sign_sidebar("channel-sections".into(), serde_json::json!({"version":1,"sections":[{"id":"group","name":"界".repeat(257),"order":0}],"assignments":{}}), 1).await.is_err());
}

#[tokio::test]
async fn sidebar_signer_supports_large_records_without_expanding_general_signing() {
    let host = IdentityHost::fixture();
    let channels: serde_json::Map<String, serde_json::Value> = (0..500)
        .map(|i| {
            (
                format!("{i:08x}-1234-1234-1234-123456789abc"),
                serde_json::json!({"starred":true,"updatedAt":1700000000000_u64}),
            )
        })
        .collect();
    let event = host
        .sign_sidebar(
            "channel-stars".into(),
            serde_json::json!({"version":1,"channels":channels}),
            1,
        )
        .await
        .unwrap();
    verify(&event);
    assert!(event["content"].as_str().unwrap().len() > 64 * 1024);
    assert_eq!(
        host.decode_sidebar(vec![event]).await.unwrap()["channel-stars"]["channels"]
            .as_object()
            .unwrap()
            .len(),
        500
    );
    let muted: serde_json::Map<String, serde_json::Value> = (0..500)
        .map(|i| {
            (
                format!("{i:08x}-1234-1234-1234-123456789abc"),
                serde_json::json!({"muted":i % 2 == 0,"updatedAt":1700000000000_u64}),
            )
        })
        .collect();
    let event = host
        .sign_sidebar(
            "channel-mutes".into(),
            serde_json::json!({"version":1,"channels":muted}),
            1,
        )
        .await
        .unwrap();
    verify(&event);
    assert_eq!(
        host.decode_sidebar(vec![event]).await.unwrap()["channel-mutes"]["channels"]
            .as_object()
            .unwrap()
            .len(),
        500
    );
    let assignments: serde_json::Map<String, serde_json::Value> = (0..1000)
        .map(|i| {
            (
                format!("{i:08x}-1234-1234-1234-123456789abc"),
                serde_json::json!("group"),
            )
        })
        .collect();
    let event = host.sign_sidebar("channel-sections".into(), serde_json::json!({
        "version":1,"sections":[{"id":"group","name":"Work","order":0}],"assignments":assignments
    }), 1).await.unwrap();
    verify(&event);
    assert_eq!(
        host.decode_sidebar(vec![event]).await.unwrap()["channel-sections"]["assignments"]
            .as_object()
            .unwrap()
            .len(),
        1000
    );
    assert!(host
        .sign(EventTemplate {
            kind: 9,
            created_at: 1,
            tags: vec![],
            content: "x".repeat(65_536)
        })
        .await
        .is_err());
}

#[tokio::test]
async fn sidebar_signer_and_decoder_match_broker_plaintext_boundaries() {
    let host = IdentityHost::fixture();
    // Unknown string sort modes are preserved by both clients; use one to place
    // actual JSON exactly on each wire-format and application budget boundary.
    let prefix = r#"{"groups":{"future":""#;
    let suffix = r#""},"version":1}"#;
    for size in [65_408, 65_409, 65_535, 65_536, 128 * 1024] {
        let filler = "x".repeat(size - prefix.len() - suffix.len());
        let payload = serde_json::json!({"version":1,"groups":{"future":filler}});
        assert_eq!(serde_json::to_string(&payload).unwrap().len(), size);
        let event = host
            .sign_sidebar("channel-sort".into(), payload.clone(), 1)
            .await
            .unwrap();
        verify(&event);
        assert_eq!(
            host.decode_sidebar(vec![event]).await.unwrap()["channel-sort"],
            payload
        );
    }
    let oversized = serde_json::json!({
        "version":1,"groups":{"future":"x".repeat(128 * 1024 - prefix.len() - suffix.len() + 1)}
    });
    assert_eq!(
        serde_json::to_string(&oversized).unwrap().len(),
        128 * 1024 + 1
    );
    assert_eq!(
        host.sign_sidebar("channel-sort".into(), oversized, 1)
            .await
            .unwrap_err(),
        "Sidebar plaintext budget exceeded"
    );
}

#[tokio::test]
async fn sidebar_decoder_accepts_broker_extended_length_sections_alongside_other_preferences() {
    let host = IdentityHost::fixture();
    let section = "12345678-1234-1234-1234-123456789abc";
    let assignments: serde_json::Map<String, serde_json::Value> = (0..1000)
        .map(|i| {
            (
                format!("{i:08x}-1234-1234-1234-123456789abc"),
                serde_json::json!(section),
            )
        })
        .collect();
    let sections = serde_json::json!({"version":1,"sections":[{"id":section,"name":"Work","order":0}],"assignments":assignments});
    assert!(serde_json::to_vec(&sections).unwrap().len() > 65_535);
    let mut events = vec![host
        .sign_sidebar("channel-sections".into(), sections.clone(), 1)
        .await
        .unwrap()];
    for coordinate in ["channel-stars", "channel-mutes", "channel-sort"] {
        let payload = if coordinate == "channel-sort" {
            serde_json::json!({"version":1,"groups":{}})
        } else {
            serde_json::json!({"version":1,"channels":{}})
        };
        events.push(
            host.sign_sidebar(coordinate.into(), payload, 1)
                .await
                .unwrap(),
        );
    }
    let decoded = host.decode_sidebar(events).await.unwrap();
    assert_eq!(decoded["channel-sections"], sections);
    assert_eq!(decoded["channel-stars"]["version"], 1);
    assert_eq!(decoded["channel-mutes"]["version"], 1);
    assert_eq!(decoded["channel-sort"]["version"], 1);
}

#[tokio::test]
async fn sidebar_decoder_accepts_four_maximum_plaintext_records_and_bounds_total_upload() {
    let host = IdentityHost::fixture();
    let mut events = Vec::new();
    for coordinate in [
        "channel-sort",
        "channel-sections",
        "channel-stars",
        "channel-mutes",
    ] {
        // Preserved top-level data can fill the plaintext budget without
        // bypassing each coordinate's validated schema or the signer boundary.
        let mut value = match coordinate {
            "channel-sort" => serde_json::json!({"version":1,"groups":{},"future":""}),
            "channel-sections" => {
                serde_json::json!({"version":1,"sections":[],"assignments":{},"future":""})
            }
            _ => serde_json::json!({"version":1,"channels":{},"future":""}),
        };
        let overhead = serde_json::to_vec(&value).unwrap().len();
        value["future"] = serde_json::json!("x".repeat(128 * 1024 - overhead));
        assert_eq!(serde_json::to_vec(&value).unwrap().len(), 128 * 1024);
        events.push(
            host.sign_sidebar(coordinate.into(), value, 1)
                .await
                .unwrap(),
        );
    }
    let request_len = serde_json::to_vec(&events).unwrap().len();
    assert!(request_len > 512 * 1024 && request_len < 768 * 1024);
    assert_eq!(
        host.decode_sidebar(events)
            .await
            .unwrap()
            .as_object()
            .unwrap()
            .len(),
        4
    );
}

#[tokio::test]
async fn sidebar_decoder_loads_four_populated_bounded_coordinates() {
    let host = IdentityHost::fixture();
    let section = "00000000-1234-1234-1234-123456789abc";
    let assignments: serde_json::Map<String, serde_json::Value> = (0..1000)
        .map(|i| {
            (
                format!("{i:08x}-1234-1234-1234-123456789abc"),
                serde_json::json!(section),
            )
        })
        .collect();
    let sections: serde_json::Value =
        serde_json::json!({"version":1,"sections":[],"assignments":assignments});
    let named_sections: Vec<_> = (0..100)
        .map(|i| serde_json::json!({"id":format!("{i:08x}-1234-1234-1234-123456789abc"),"name":"N".repeat(198),"order":i}))
        .collect();
    let mut sections = sections;
    sections["sections"] = serde_json::json!(named_sections);
    let mut events = vec![host
        .sign_sidebar("channel-sections".into(), sections.clone(), 1)
        .await
        .unwrap()];
    for (coordinate, field) in [("channel-stars", "starred"), ("channel-mutes", "muted")] {
        let channels: serde_json::Map<String, serde_json::Value> = (0..500)
            .map(|i| {
                (
                    format!("{i:08x}-5678-1234-1234-123456789abc"),
                    serde_json::json!({field: true, "updatedAt": 1_700_000_000_000_u64}),
                )
            })
            .collect();
        let event = host
            .sign_sidebar(
                coordinate.into(),
                serde_json::json!({"version":1,"channels":channels}),
                1,
            )
            .await
            .unwrap();
        assert_eq!(
            host.decode_sidebar(vec![event.clone()]).await.unwrap()[coordinate]["channels"]
                .as_object()
                .unwrap()
                .len(),
            500
        );
        events.push(event);
    }
    let sort = serde_json::json!({"version":1,"groups":{"channels":"recent"}});
    events.push(
        host.sign_sidebar("channel-sort".into(), sort.clone(), 1)
            .await
            .unwrap(),
    );
    let request_bytes = serde_json::to_vec(&events).unwrap().len();
    assert!(
        request_bytes > 256 * 1024,
        "fixture must cross old aggregate budget: {request_bytes}"
    );
    let decoded = host.decode_sidebar(events).await.unwrap();
    assert_eq!(decoded["channel-sections"], sections);
    assert_eq!(
        decoded["channel-stars"]["channels"]
            .as_object()
            .unwrap()
            .len(),
        500
    );
    assert_eq!(
        decoded["channel-mutes"]["channels"]
            .as_object()
            .unwrap()
            .len(),
        500
    );
    assert_eq!(decoded["channel-sort"], sort);
}

#[test]
fn js_signs_emoji_sets_but_never_blossom_tokens() {
    let template = |kind| EventTemplate {
        kind,
        created_at: 1,
        content: "Upload attachment".into(),
        tags: vec![vec!["t".into(), "upload".into()]],
    };
    assert!(validate_event("https://relay.test", &template(30030)).is_ok());
    assert!(validate_event("https://relay.test", &template(24242)).is_err());
}

#[test]
fn media_proxy_only_reaches_relay_blobs() {
    let hash = "a".repeat(64);
    for target in [
        format!("https://relay.test/media/{hash}"),
        format!("https://relay.test/media/{hash}.png"),
        format!("https://relay.test:8443/media/{hash}.thumb.jpg"),
    ] {
        assert!(media_url(&target).is_some(), "{target}");
    }
    for target in [
        format!("http://relay.test/media/{hash}"),
        format!("https://u:p@relay.test/media/{hash}"),
        format!("https://relay.test/media/{hash}?x=1"),
        format!("https://relay.test/media/{hash}#x"),
        format!("https://relay.test/upload/{hash}"),
        format!("https://relay.test/media/{}", "A".repeat(64)),
        format!("https://relay.test/media/{hash}/../../query"),
        format!("https://relay.test/media/{hash}.PNG"),
        "https://relay.test/media/abc".into(),
        "file:///etc/passwd".into(),
    ] {
        assert!(media_url(&target).is_none(), "{target}");
    }
}

#[test]
fn native_downloads_only_accept_authenticated_media_urls() {
    let hash = "a".repeat(64);
    let target = format!("https://relay.test/media/{hash}.pdf");
    let encoded: String =
        percent_encoding::utf8_percent_encode(&target, percent_encoding::NON_ALPHANUMERIC)
            .to_string();
    for url in [
        format!("buzz-media://localhost/{encoded}"),
        format!("http://buzz-media.localhost/{encoded}"),
    ] {
        assert!(download_target(&url).is_some(), "{url}");
    }
    for url in [
        format!("buzz-media://evil.test/{encoded}"),
        format!("http://buzz-media.localhost.evil.test/{encoded}"),
        format!("https://buzz-media.localhost/{encoded}"),
        format!("buzz-media://localhost:123/{encoded}"),
        format!("buzz-media://localhost/{encoded}?q=1"),
        format!("buzz-media://localhost/{encoded}#fragment"),
        format!("buzz-media://u:p@localhost/{encoded}"),
        format!(
            "buzz-media://localhost/{}",
            percent_encoding::utf8_percent_encode(
                "https://relay.test/query",
                percent_encoding::NON_ALPHANUMERIC
            )
        ),
    ] {
        assert!(download_target(&url).is_none(), "{url}");
    }
}

#[test]
fn download_names_are_safe_and_collisions_do_not_overwrite() {
    let url = Url::parse(&format!("https://relay.test/media/{}.pdf", "a".repeat(64))).unwrap();
    for invalid in [
        "",
        ".",
        "..",
        "../secret",
        "a/b",
        "a\\b",
        "a:b",
        "a\n.txt",
        "a?.pdf",
        "a*.pdf",
        "a\".pdf",
        "a<.pdf",
        "a>.pdf",
        "a|.pdf",
        "CON",
        "con.txt",
        "NUL.pdf",
        "COM1.txt",
        "LPT9",
        "report.",
        "report ",
        "invoice\u{202e}fdp.command",
        "\u{2066}file\u{2069}.pdf",
    ] {
        assert_eq!(
            download_name(invalid, &url),
            url.path().rsplit('/').next().unwrap()
        );
    }
    assert_eq!(
        download_name("Annual report.pdf", &url),
        "Annual report.pdf"
    );
    let dir = std::env::temp_dir().join(format!("buzz-download-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let first = save_download(&dir, "report.pdf", b"first").unwrap();
    let second = save_download(&dir, "report.pdf", b"second").unwrap();
    assert_eq!(first.file_name().unwrap(), "report.pdf");
    assert_eq!(second.file_name().unwrap(), "report (1).pdf");
    assert_eq!(std::fs::read(&first).unwrap(), b"first");
    assert_eq!(std::fs::read(&second).unwrap(), b"second");
    #[cfg(target_os = "macos")]
    {
        use std::os::fd::AsRawFd;
        let mut value = [0u8; 128];
        let length = unsafe {
            libc::fgetxattr(
                std::fs::File::open(&first).unwrap().as_raw_fd(),
                c"com.apple.quarantine".as_ptr(),
                value.as_mut_ptr().cast(),
                value.len(),
                0,
                0,
            )
        };
        assert!(length > 0, "missing quarantine mark");
        assert!(std::str::from_utf8(&value[..length as usize])
            .unwrap()
            .starts_with("0081;"));
    }
    #[cfg(target_os = "windows")]
    {
        let stream = format!("{}:Zone.Identifier", first.display());
        assert_eq!(
            std::fs::read(stream).unwrap(),
            b"[ZoneTransfer]\r\nZoneId=3\r\n"
        );
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn media_ranges_are_single_and_bounded() {
    assert_eq!(media_range("bytes=0-").as_deref(), Some("bytes=0-4194303"));
    assert_eq!(media_range("bytes=10-20").as_deref(), Some("bytes=10-20"));
    assert_eq!(
        media_range("bytes=100-999999999").as_deref(),
        Some("bytes=100-4194403")
    );
    assert!(media_range(&format!("bytes={}-", u64::MAX)).is_none());
    for value in [
        "bytes=-500",
        "bytes=5-1",
        "bytes=0-1,4-5",
        "items=0-1",
        "bytes=x-",
    ] {
        assert!(media_range(value).is_none(), "{value}");
    }
}

#[test]
fn media_types_render_only_images_video_and_audio() {
    assert_eq!(
        media_type(Some("image/PNG; x=1")),
        ("image/png".into(), false)
    );
    assert_eq!(media_type(Some("video/mp4")), ("video/mp4".into(), false));
    assert_eq!(media_type(Some("audio/mpeg")), ("audio/mpeg".into(), false));
    for value in [
        Some("image/svg+xml"),
        Some("text/html"),
        Some("image/"),
        None,
    ] {
        assert_eq!(
            media_type(value),
            ("application/octet-stream".into(), true),
            "{value:?}"
        );
    }
}

fn blossom_event(headers: &str) -> serde_json::Value {
    let encoded = headers
        .lines()
        .find_map(|line| line.strip_prefix("authorization: Nostr "))
        .unwrap();
    let event: serde_json::Value =
        serde_json::from_slice(&STANDARD.decode(encoded).unwrap()).unwrap();
    verify(&event);
    event
}

fn tag<'a>(event: &'a serde_json::Value, name: &str) -> Vec<&'a str> {
    event["tags"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|tag| tag[0] == name)
        .map(|tag| tag[1].as_str().unwrap())
        .collect()
}

/// The relay's strict NIP-FI rules: one each of `t`, `server`, `expiration`,
/// expiry within 60 s of creation, non-empty content.
fn assert_strict(event: &serde_json::Value, verb: &str, server: &str) {
    assert_eq!(event["kind"], 24242);
    assert_ne!(event["content"], "");
    assert_eq!(tag(event, "t"), [verb]);
    assert_eq!(tag(event, "server"), [server]);
    let expiration: u64 = tag(event, "expiration")[0].parse().unwrap();
    assert_eq!(tag(event, "expiration").len(), 1);
    assert_eq!(expiration, event["created_at"].as_u64().unwrap() + 60);
}

#[tokio::test]
async fn media_proxy_signs_a_fresh_get_and_forwards_only_the_range() {
    let (base, task) = fixture_server(
        "HTTP/1.1 206 Partial Content\r\nContent-Type: text/html\r\nContent-Range: bytes 0-3/10\r\nContent-Length: 4\r\nConnection: close\r\n\r\n<b>x".into(),
    );
    let url = base.join(&format!("/media/{}", "a".repeat(64))).unwrap();
    let response = fetch_media(
        &IdentityHost::fixture(),
        url.clone(),
        Some("bytes=0-3".into()),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), 206);
    assert_eq!(response.body(), b"<b>x");
    let header = |name| response.headers().get(name).unwrap().to_str().unwrap();
    assert_eq!(header("content-type"), "application/octet-stream");
    assert_eq!(header("content-disposition"), "attachment");
    assert_eq!(header("x-content-type-options"), "nosniff");
    assert_eq!(header("content-range"), "bytes 0-3/10");
    let (headers, _) = task.join().unwrap();
    assert!(headers.starts_with(&format!("GET {} ", url.path())));
    assert!(headers.lines().any(|line| line == "range: bytes=0-3"));
    assert!(!headers.contains("cookie"));
    let server = &url[url::Position::BeforeHost..url::Position::AfterPort];
    assert_strict(&blossom_event(&headers), "get", server);
}

#[tokio::test]
async fn media_proxy_passes_relay_denials_through_without_a_body() {
    let (base, task) = fixture_server(
        "HTTP/1.1 401 Unauthorized\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".into(),
    );
    let url = base.join(&format!("/media/{}", "b".repeat(64))).unwrap();
    assert_eq!(
        fetch_media(&IdentityHost::fixture(), url, None)
            .await
            .unwrap_err(),
        401
    );
    task.join().unwrap();
}

#[tokio::test]
async fn upload_signs_the_exact_bytes_it_sends() {
    let (base, task) = fixture_server(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".into(),
    );
    let url = base.join("/upload").unwrap();
    // ASCII: the fixture server compares lengths on decoded text.
    let body = b"PNG fixture bytes".to_vec();
    let hash = format!("{:x}", Sha256::digest(&body));
    let result = upload(
        &IdentityHost::fixture(),
        url.clone(),
        Some("image/png"),
        body.clone(),
    )
    .await
    .unwrap();
    assert_eq!((result.status, result.body.as_str()), (200, "{}"));
    let (headers, sent) = task.join().unwrap();
    assert_eq!(sent.as_bytes(), body);
    assert!(headers.starts_with("PUT /upload "));
    assert!(headers
        .lines()
        .any(|line| line == format!("x-sha-256: {hash}")));
    assert!(headers
        .lines()
        .any(|line| line == "content-type: image/png"));
    let event = blossom_event(&headers);
    let server = &url[url::Position::BeforeHost..url::Position::AfterPort];
    assert_strict(&event, "upload", server);
    assert_eq!(tag(&event, "x"), [hash.as_str()]);
    assert!(upload(&IdentityHost::fixture(), url, None, Vec::new())
        .await
        .is_err());
}

#[test]
fn uploads_cancel_before_or_during_and_reject_duplicates() {
    let uploads = Uploads::default();
    let mut running = uploads.start("a").unwrap().unwrap();
    assert!(uploads.start("a").is_err());
    uploads.cancel("a");
    assert!(running.try_recv().is_ok());
    uploads.finish("a");
    // A cancel that overtakes its upload stops it from starting, once.
    uploads.cancel("b");
    assert!(uploads.start("b").unwrap().is_none());
    assert!(uploads.start("b").unwrap().is_some());
    for id in ["", "a/b", &"x".repeat(65)] {
        assert!(upload_id(Some(id)).is_err(), "{id}");
    }
    assert!(upload_id(None).is_err());
}

#[test]
fn late_cancels_cannot_exhaust_upload_admission() {
    let uploads = Uploads::default();
    for n in 0..128 {
        let id = n.to_string();
        let _running = uploads.start(&id).unwrap().unwrap();
        uploads.finish(&id);
        uploads.cancel(&id); // Renderer received completion after native finished.
    }
    assert!(uploads.start("fresh").unwrap().is_some());
    assert_eq!(uploads.lock().pending.len(), 64);
    // Early rejection before `start` has the same late-cancel path.
    uploads.cancel("rejected-before-start");
    assert!(uploads.start("another").unwrap().is_some());
    // Even when active admission is full, a pre-cancelled ID never starts.
    let mut held = Vec::new();
    for n in 0..62 {
        held.push(uploads.start(&format!("active-{n}")).unwrap().unwrap());
    }
    uploads.cancel("queued");
    assert!(uploads.start("queued").unwrap().is_none());
    assert!(uploads.start("overflow").is_err());
    uploads.finish("active-0");
    assert!(uploads.start("overflow").unwrap().is_some());
    uploads.finish("active-1");
    let mut active = uploads.start("active").unwrap().unwrap();
    uploads.cancel("active");
    assert!(active.try_recv().is_ok());
}
