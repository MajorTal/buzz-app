use super::*;
use serde_json::json;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const KEY: &str = "0000000000000000000000000000000000000000000000000000000000000001";
const PUB: &str = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
struct Request {
    path: String,
    headers: String,
    body: Vec<u8>,
}
struct Reply {
    status: u16,
    body: Vec<u8>,
}
fn json_reply(value: Value) -> Reply {
    Reply {
        status: 200,
        body: serde_json::to_vec(&value).unwrap(),
    }
}
// Loopback HTTP is test-only. Production destinations are canonical WSS -> HTTPS.
fn server(
    count: usize,
    mut reply: impl FnMut(usize, Request) -> Reply + Send + 'static,
) -> (String, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let worker = std::thread::spawn(move || {
        for index in 0..count {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let header_end = loop {
                let mut chunk = [0; 4096];
                let n = stream.read(&mut chunk).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&chunk[..n]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    break end + 4;
                }
            };
            let headers = String::from_utf8(bytes[..header_end].to_vec()).unwrap();
            let length: usize = headers
                .lines()
                .find_map(|l| {
                    l.to_lowercase()
                        .strip_prefix("content-length: ")
                        .map(str::to_owned)
                })
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            while bytes.len() < header_end + length {
                let mut chunk = [0; 4096];
                let n = stream.read(&mut chunk).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&chunk[..n]);
            }
            let path = headers.split_whitespace().nth(1).unwrap().to_owned();
            let response = reply(
                index,
                Request {
                    path,
                    headers,
                    body: bytes[header_end..].to_vec(),
                },
            );
            let header = format!("HTTP/1.1 {} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", response.status, response.body.len());
            // A response-size refusal can close the client socket before all bytes arrive.
            let _ = stream
                .write_all(header.as_bytes())
                .and_then(|_| stream.write_all(&response.body));
        }
    });
    (origin, worker)
}
fn profile(origin: &str) -> CreationProfile {
    CreationProfile {
        credential_id: "fixture".into(),
        pubkey: PUB.into(),
        url: format!("{origin}/events"),
        auth: json!(["auth", "owner", "", "signature"]).to_string(),
        name: "Fixture".into(),
        picture: Some("https://images.example/a.png".into()),
        revision: 1,
    }
}
fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap()
}
fn auth(request: &Request, origin: &str) {
    let encoded = request
        .headers
        .lines()
        .find_map(|l| l.strip_prefix("authorization: Nostr "))
        .unwrap();
    let event: Value = serde_json::from_slice(
        &base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(event["pubkey"], PUB);
    assert_eq!(event["kind"], 27235);
    let tags = event["tags"].as_array().unwrap();
    assert!(tags.contains(&json!(["u", format!("{origin}{}", request.path)])));
    assert!(tags.contains(&json!(["method", "POST"])));
    use sha2::{Digest, Sha256};
    assert!(tags.contains(&json!([
        "payload",
        format!("{:x}", Sha256::digest(&request.body))
    ])));
    assert!(request.headers.contains("x-auth-tag:"));
}
#[tokio::test]
async fn actual_http_query_publish_and_verified_readback() {
    let saved = Arc::new(Mutex::new(Value::Null));
    let seen = saved.clone();
    let origin_ref = Arc::new(Mutex::new(String::new()));
    let expected = origin_ref.clone();
    let (origin, worker) = server(3, move |index, request| {
        auth(&request, &expected.lock().unwrap());
        match index {
            0 => {
                assert_eq!(request.path, "/query");
                assert_eq!(
                    serde_json::from_slice::<Value>(&request.body).unwrap(),
                    json!([{"kinds":[0],"authors":[PUB],"limit":5}])
                );
                json_reply(json!([]))
            }
            1 => {
                assert_eq!(request.path, "/events");
                let event: Value = serde_json::from_slice(&request.body).unwrap();
                *seen.lock().unwrap() = event.clone();
                json_reply(json!({"accepted":true,"event_id":event["id"]}))
            }
            _ => {
                assert_eq!(request.path, "/query");
                json_reply(json!([seen.lock().unwrap().clone()]))
            }
        }
    });
    *origin_ref.lock().unwrap() = origin.clone();
    publish(
        &client(),
        &profile(&origin),
        &Secret::parse(KEY, PUB).unwrap(),
        || async { Ok(()) },
    )
    .await
    .unwrap();
    worker.join().unwrap();
}
#[tokio::test]
async fn refused_malformed_or_unbounded_reads_and_wrong_receipts_do_not_succeed() {
    for mode in [
        "refused",
        "malformed",
        "oversized",
        "unverified",
        "wrong-id",
        "rejected",
        "superseded",
        "revision",
    ] {
        let count = match mode {
            "wrong-id" | "rejected" => 2,
            "superseded" => 3,
            _ => 1,
        };
        let (origin, worker) = server(count, move |index, request| {
            if index == 0 {
                return match mode {
                    "refused" => Reply {
                        status: 403,
                        body: vec![],
                    },
                    "malformed" => Reply {
                        status: 200,
                        body: b"invalid".to_vec(),
                    },
                    "oversized" => Reply {
                        status: 200,
                        body: vec![b' '; 1024 * 1024 + 1],
                    },
                    "unverified" => json_reply(json!([{"kind":0,"pubkey":PUB}])),
                    _ => json_reply(json!([])),
                };
            }
            if index == 2 {
                return json_reply(json!([]));
            }
            let event: Value = serde_json::from_slice(&request.body).unwrap();
            json_reply(
                json!({"accepted":mode!="rejected", "event_id":if mode=="wrong-id" { json!("00".repeat(32)) } else { event["id"].clone() }}),
            )
        });
        let outcome = publish(
            &client(),
            &profile(&origin),
            &Secret::parse(KEY, PUB).unwrap(),
            || async {
                if mode == "revision" {
                    Err("revision changed".into())
                } else {
                    Ok(())
                }
            },
        )
        .await;
        assert!(outcome.is_err(), "{mode}");
        worker.join().unwrap();
    }
}

#[tokio::test]
async fn native_owner_blocks_overlap_during_held_post_and_keeps_newer_save_pending() {
    use crate::agents::{publish_acquired, tests::fixture};
    let (dir, owner, _app, _view) = fixture();
    let key = Secret::parse(KEY, PUB).unwrap();
    let source = profile("https://relay.example");
    let auth = test_attestation();
    let id = format!("{PUB}-733db93c5a38b650794422a480fab67f1dd8f6f40112c360f9814dfaec3bfcbb");
    std::fs::write(dir.path().join("store/agents.json"), serde_json::to_vec(&json!({"version":1,"agents":[{
        "id":id,"pubkey":PUB,"relayUrl":"wss://relay.example","name":"Fixture","picture":source.picture,"systemPrompt":"test","workspace":dir.path().to_str().unwrap(),
        "harness":{"command":"buzz-agent","args":[],"model":"test","provider":"test"},"environment":{},"revision":1,"enabled":false,"credentialId":"fixture","authTag":auth,"imported":{},"profilePending":true
    }]})).unwrap()).unwrap();
    let (posted, posted_rx) = tokio::sync::oneshot::channel();
    let mut posted = Some(posted);
    let (release, released) = std::sync::mpsc::channel();
    let mut saved = Value::Null;
    let (origin, worker) = server(3, move |index, request| match index {
        0 => json_reply(json!([])),
        1 => {
            saved = serde_json::from_slice(&request.body).unwrap();
            posted.take().unwrap().send(()).unwrap();
            released.recv_timeout(Duration::from_secs(5)).unwrap();
            json_reply(json!({"accepted":true,"event_id":saved["id"]}))
        }
        _ => json_reply(json!([saved.clone()])),
    });
    let (guard, mut profile, _) = owner.begin_profile(&id).await.unwrap();
    profile.url = format!("{origin}/events");
    let copy = owner.clone();
    let target = id.clone();
    let task = tokio::spawn(async move {
        publish_acquired(&copy, &target, &profile, &key, &client(), guard).await
    });
    posted_rx.await.unwrap();
    assert!(owner
        .begin_profile(&id)
        .await
        .err()
        .unwrap()
        .contains("already in progress"));
    let edit = serde_json::from_value(json!({"name":"Fixture","picture":"https://images.example/b.png","systemPrompt":"test","workspace":dir.path().to_str().unwrap(),"harness":{"command":"buzz-agent","args":[],"model":"test","provider":"test"},"environment":{}})).unwrap();
    owner
        .with(|host| host.controller.save(&id, 1, edit).map(|_| ()))
        .unwrap();
    assert!(owner.begin_profile(&id).await.is_err());
    release.send(()).unwrap();
    assert!(task.await.unwrap().err().unwrap().contains("changed"));
    worker.join().unwrap();
    let (guard, profile, _) = owner.begin_profile(&id).await.unwrap();
    assert_eq!(profile.revision, 2);
    assert_eq!(
        profile.picture.as_deref(),
        Some("https://images.example/b.png")
    );
    drop(guard);
    assert!(owner
        .with(|host| Ok(host.controller.snapshot()?.agents[0].profile_pending))
        .unwrap());
}
fn test_attestation() -> String {
    // Public test owner key 2 signs authorization for public test agent key 1.
    json!(["auth", "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5", "", "84b950c7e85f31970af2891d7660a938eab65681a1c1603f93efa99184a3766c86e506a34be52aec64d73f9375311729a44c2841f7b0873643d24dee4d8f361e"]).to_string()
}
