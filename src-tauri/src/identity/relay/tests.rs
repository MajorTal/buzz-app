use super::*;
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::Duration,
};
use zeroize::Zeroizing;

const PIN: &str = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const ORIGIN: &str = "https://relay.example";
const CHANNEL: &str = "b4d5a9c0-2c51-44d0-9f4e-b8ef1a2eb960";

struct NoCredentials;
impl crate::identity::store::CredentialStore for NoCredentials {
    fn read_legacy(
        &self,
        _: crate::identity::dto::LegacySource,
    ) -> crate::identity::dto::Result<Zeroizing<Vec<u8>>> {
        panic!("live credential access forbidden")
    }
    fn read_saved(
        &self,
        _: &str,
        _: &str,
    ) -> crate::identity::dto::Result<Option<Zeroizing<Vec<u8>>>> {
        panic!("live credential access forbidden")
    }
    fn add_saved(&self, _: &str, _: &str, _: &[u8]) -> crate::identity::dto::Result<()> {
        panic!("live credential access forbidden")
    }
}
fn identity() -> Identity {
    let identity = Identity::new(Ok("native-relay-test".into()), Arc::new(NoCredentials));
    let mut bytes = Zeroizing::new([0; 32]);
    bytes[31] = 1;
    identity.authority().unwrap().key = Some(IdentityKey::from_bytes(bytes).unwrap());
    identity
}
fn scope(identity: &Identity) -> Value {
    let status = identity.status().unwrap();
    json!({"origin": ORIGIN,"expectedPubkey":PIN,"generation":status.generation,"revocation":status.revocation})
}
fn message() -> Value {
    json!({"kind":9,"created_at":1_789_300_000_u64,"content":"Narf 🐭","tags":[["h",CHANNEL],["client-id","8a5b8068-f2a5-4f70-aec4-ccbf61e9386a"]]})
}
fn profile() -> Value {
    json!({"kind":0,"created_at":1_789_300_000_u64,"content":json!({"name":"Pinky","display_name":"Pinky","picture":"https://example.com/avatar.png","about":"Preserved","unknown":{"ok":true}}).to_string(),"tags":[["client-id","8a5b8068-f2a5-4f70-aec4-ccbf61e9386a"]]})
}
fn invoke(identity: Identity, command: &str, request: Value) -> std::result::Result<Value, Value> {
    let app = tauri::test::mock_builder()
        .manage(identity)
        .invoke_handler(crate::commands())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
        .build()
        .unwrap();
    tauri::test::get_ipc_response(
        &window,
        tauri::webview::InvokeRequest {
            cmd: command.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: if cfg!(any(windows, target_os = "android")) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
            .parse()
            .unwrap(),
            body: tauri::ipc::InvokeBody::Json(json!({"request":request})),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
    )
    .map(|b| b.deserialize().unwrap())
}
fn sign_event(identity: &Identity, kind: u16) -> Value {
    invoke(
        identity.clone(),
        if kind == 9 {
            "community_sign_message"
        } else {
            "community_sign_profile"
        },
        json!({"scope":scope(identity),"template":if kind == 9 {message()} else {profile()}}),
    )
    .unwrap()["value"]
        .clone()
}
#[derive(Clone, Debug)]
struct Request {
    method: String,
    path: String,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}
fn read_request(stream: &mut TcpStream) -> Request {
    stream.set_nonblocking(false).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut raw = Vec::new();
    let end = loop {
        let mut bytes = [0; 4096];
        let n = stream.read(&mut bytes).unwrap();
        assert!(n > 0);
        raw.extend_from_slice(&bytes[..n]);
        if let Some(i) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        assert!(raw.len() < 100_000);
    };
    let header = String::from_utf8(raw[..end].to_vec()).unwrap();
    let mut lines = header.lines();
    let first: Vec<_> = lines.next().unwrap().split_whitespace().collect();
    let headers: BTreeMap<_, _> = lines
        .filter_map(|l| {
            l.split_once(':')
                .map(|(k, v)| (k.to_lowercase(), v.trim().to_owned()))
        })
        .collect();
    let size: usize = headers
        .get("content-length")
        .map(|s| s.parse().unwrap())
        .unwrap_or(0);
    while raw.len() < end + size {
        let mut bytes = [0; 4096];
        let n = stream.read(&mut bytes).unwrap();
        assert!(n > 0);
        raw.extend_from_slice(&bytes[..n]);
    }
    Request {
        method: first[0].into(),
        path: first[1].into(),
        headers,
        body: raw[end..end + size].to_vec(),
    }
}
struct Server {
    url: url::Url,
    requests: Arc<Mutex<Vec<Request>>>,
    stop: Arc<AtomicBool>,
    task: Option<thread::JoinHandle<()>>,
}
impl Server {
    fn start(
        handler: impl Fn(&Request) -> Option<(u16, String, String)> + Send + Sync + 'static,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap())
            .parse()
            .unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let flag = stop.clone();
        let captured = requests.clone();
        let handler = Arc::new(handler);
        let task = thread::spawn(move || {
            let mut workers = Vec::new();
            while !flag.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let handler = handler.clone();
                        let captured = captured.clone();
                        workers.push(thread::spawn(move || {
                            let request=read_request(&mut stream);
                            captured.lock().unwrap().push(request.clone());
                            if let Some((status,headers,body))=handler(&request) {
                                let _=write!(stream,"HTTP/1.1 {status} Reply\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",body.len());
                            }
                        }));
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(e) => panic!("fixture listener failed: {e}"),
                }
            }
            for worker in workers {
                worker.join().unwrap();
            }
        });
        Self {
            url,
            requests,
            stop,
            task: Some(task),
        }
    }
    fn install(&self, identity: &Identity, timeout: Duration) {
        assert!(identity
            .0
            .relay_http
            .set(Ok(http::Http::fixture(self.url.clone(), timeout)))
            .is_ok());
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(task) = self.task.take() {
            if let Err(panic) = task.join() {
                if !thread::panicking() {
                    std::panic::resume_unwind(panic);
                }
            }
        }
    }
}
fn response(value: Value) -> Option<(u16, String, String)> {
    Some((200, String::new(), value.to_string()))
}
fn auth(request: &Request) -> Event {
    let header = request
        .headers
        .get("authorization")
        .expect("authenticated request");
    let event: Event = serde_json::from_slice(
        &STANDARD
            .decode(header.strip_prefix("Nostr ").unwrap())
            .unwrap(),
    )
    .unwrap();
    events::verify(&event).unwrap();
    assert_eq!(event.pubkey, PIN);
    assert_eq!(event.kind, 27235);
    assert_eq!(request.method, "POST");
    assert!(event
        .tags
        .contains(&vec!["u".into(), format!("{ORIGIN}{}", request.path)]));
    assert!(event.tags.contains(&vec!["method".into(), "POST".into()]));
    assert!(event.tags.contains(&vec![
        "payload".into(),
        events::hex(&events::hash(&request.body))
    ]));
    event
}

#[test]
fn production_signers_are_purpose_bound_preserve_hash_and_do_not_contact_http() {
    let identity = identity();
    let before = identity.status().unwrap();
    for (kind, template) in [(9, message()), (0, profile())] {
        let command = if kind == 9 {
            "community_sign_message"
        } else {
            "community_sign_profile"
        };
        let request = json!({"scope":scope(&identity),"template":template});
        let one = invoke(identity.clone(), command, request.clone()).unwrap();
        let two = invoke(identity.clone(), command, request).unwrap();
        assert_eq!(
            one, two,
            "duplicate invocation cannot change the data event"
        );
        let event: Event = serde_json::from_value(one["value"].clone()).unwrap();
        events::verify(&event).unwrap();
        assert_eq!(serde_json::to_value(event.template()).unwrap(), template);
        assert_eq!(one["scope"], scope(&identity));
        let wrong = if kind == 9 {
            "community_sign_profile"
        } else {
            "community_sign_message"
        };
        assert_eq!(
            invoke(
                identity.clone(),
                wrong,
                json!({"scope":scope(&identity),"template":template})
            )
            .unwrap_err(),
            json!({"code":"invalidInput"})
        );
    }
    assert_eq!(identity.status().unwrap().generation, before.generation);
    assert!(identity.0.relay_http.get().is_none());
}
#[test]
fn handlers_reject_arbitrary_signing_tampering_and_secret_echoes_before_dispatch() {
    let identity = identity();
    for template in [
        json!({"kind":27235,"created_at":1,"content":"secret-do-not-echo","tags":[]}),
        json!({"kind":9,"created_at":1,"content":"secret-do-not-echo","tags":[]}),
        json!({"kind":9,"created_at":-1,"content":"secret-do-not-echo","tags":[["h",CHANNEL]]}),
    ] {
        assert_eq!(
            invoke(
                identity.clone(),
                "community_sign_message",
                json!({"scope":scope(&identity),"template":template})
            )
            .unwrap_err(),
            json!({"code":"invalidInput"})
        );
    }
    let signed = sign_event(&identity, 9);
    for field in ["content", "id", "sig", "pubkey"] {
        let mut event = signed.clone();
        event[field] = "secret-do-not-echo".into();
        let error = invoke(
            identity.clone(),
            "community_publish",
            json!({"scope":scope(&identity),"event":event}),
        )
        .unwrap_err();
        assert_eq!(error["outcome"], "notSent");
        assert!(!error.to_string().contains("secret-do-not-echo"));
    }
    assert!(identity.0.relay_http.get().is_none());
}
#[test]
fn real_handler_http_auth_and_exact_event_retry_are_correlated() {
    let server = Server::start(|request| {
        auth(request);
        match request.path.as_str() {
            "/query" => response(json!([])),
            "/events" => {
                let event: Value = serde_json::from_slice(&request.body).unwrap();
                response(
                    json!({"event_id":event["id"],"accepted":true,"message":"duplicate: already processed"}),
                )
            }
            _ => panic!("unexpected path"),
        }
    });
    let identity = identity();
    server.install(&identity, Duration::from_secs(2));
    let result=invoke(identity.clone(),"community_query",json!({"scope":scope(&identity),"filters":[{"kinds":[9],"limit":5,"#h":[CHANNEL],"top_level":true,"include_aux":true,"before_id":"ab".repeat(32),"search":"mouse","search_mode":"prefix","page":0,"feed_types":["stream"],"depth_limit":2,"thread_cursor":2,"thread_cursor_id":"cd".repeat(32)}]})).unwrap();
    assert_eq!(result["value"], json!([]));
    for kind in [9, 0] {
        let event = sign_event(&identity, kind);
        for _ in 0..2 {
            let reply = invoke(
                identity.clone(),
                "community_publish",
                json!({"scope":scope(&identity),"event":event}),
            )
            .unwrap();
            assert_eq!(
                reply["value"],
                json!({"event_id":event["id"],"accepted":true,"duplicate":true})
            );
        }
    }
    let requests = server.requests.lock().unwrap();
    for pair in [&requests[1..3], &requests[3..5]] {
        assert_eq!(pair[0].body, pair[1].body);
        assert_ne!(
            auth(&pair[0]).id,
            auth(&pair[1]).id,
            "fresh auth for replay guard"
        );
    }
}
#[test]
fn discovery_policy_and_v1_v2_claims_use_only_their_fixed_authentication() {
    let server = Server::start(|request| match request.path.as_str() {
        "/" => {
            assert!(!request.headers.contains_key("authorization"));
            response(json!({"self":PIN,"name":"Mice","icon":"https://example.com/icon"}))
        }
        "/api/join-policy" => {
            assert!(!request.headers.contains_key("authorization"));
            response(
                json!({"policy":{"version":"v1","age_attestation_required":true,"terms_markdown":"Read these"}}),
            )
        }
        "/api/invites/accept-policy" => {
            assert!(!request.headers.contains_key("authorization"));
            response(json!({"receipt":"receipt-fixture"}))
        }
        "/api/invites/claim" => {
            auth(request);
            response(
                json!({"status":"already_member","host":"relay.example","community_id":CHANNEL,"role":"member"}),
            )
        }
        _ => panic!("unexpected path"),
    });
    let identity = identity();
    server.install(&identity, Duration::from_secs(2));
    let info = invoke(
        identity.clone(),
        "community_discover",
        json!({"scope":scope(&identity)}),
    )
    .unwrap();
    assert_eq!(info["value"]["archiveAuthority"], PIN);
    assert_eq!(info["value"]["policy"]["version"], "v1");
    let v2 = format!("v2.{}", URL_SAFE_NO_PAD.encode([7; 32]));
    let v1 = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(b"{\"c\":\"fixture\"}"),
        URL_SAFE_NO_PAD.encode([8; 32])
    );
    for code in [v1, v2] {
        let policy=invoke(identity.clone(),"community_accept_policy",json!({"scope":scope(&identity),"code":code,"policy_version":"v1","age_confirmed":true})).unwrap();
        invoke(identity.clone(),"community_claim",json!({"scope":scope(&identity),"code":code,"policy_receipt":policy["value"]["receipt"]})).unwrap();
    }
    assert_eq!(server.requests.lock().unwrap().len(), 6);
}
#[test]
fn no_contact_key_archive_authority_and_404_policy_is_absent() {
    let server = Server::start(|r| {
        if r.path == "/" {
            response(json!({"pubkey":PIN}))
        } else {
            Some((404, String::new(), "{}".into()))
        }
    });
    let identity = identity();
    server.install(&identity, Duration::from_secs(2));
    let info = invoke(
        identity.clone(),
        "community_discover",
        json!({"scope":scope(&identity)}),
    )
    .unwrap();
    assert_eq!(info["value"]["relayAuthor"], PIN);
    assert!(info["value"].get("archiveAuthority").is_none());
    assert!(info["value"]["policy"].is_null());
}
#[test]
fn lost_publish_reply_and_bad_receipts_are_unknown_not_rejected_or_retried() {
    for mode in [
        "drop",
        "mismatch",
        "missing-accepted",
        "malformed",
        "redirect",
        "unavailable",
        "large",
    ] {
        let server = Server::start(move |_| match mode {
            "drop" => None,
            "mismatch" => response(json!({"event_id":"00".repeat(32),"accepted":true})),
            "missing-accepted" => response(json!({"event_id":"00".repeat(32)})),
            "malformed" => Some((200, String::new(), "not JSON".into())),
            "redirect" => Some((
                307,
                "Location: https://must-not-contact.invalid/events\r\n".into(),
                "{}".into(),
            )),
            "large" => Some((200, String::new(), "x".repeat(4097))),
            _ => Some((
                503,
                String::new(),
                "{\"error\":\"secret-do-not-echo\"}".into(),
            )),
        });
        let identity = identity();
        server.install(&identity, Duration::from_secs(2));
        let event = sign_event(&identity, 9);
        let error = invoke(
            identity.clone(),
            "community_publish",
            json!({"scope":scope(&identity),"event":event}),
        )
        .unwrap_err();
        assert_eq!(error["outcome"], "unknown", "{mode}: {error}");
        assert!(!error.to_string().contains("secret-do-not-echo"));
        assert_eq!(
            server.requests.lock().unwrap().len(),
            1,
            "no HTTP automatic retry"
        );
    }
}
#[test]
fn explicit_rejection_and_only_correlated_quota_are_definitive() {
    for (status, body, outcome, code) in [
        (403, json!({"error":"secret"}), "rejected", "denied"),
        (
            429,
            json!({"error":"arbitrary rate limit","sent":false}),
            "unknown",
            "unavailable",
        ),
        (
            429,
            json!({"error":"rate-limited: quota exceeded; retry in 3s"}),
            "rejected",
            "rateLimited",
        ),
    ] {
        let server = Server::start(move |_| Some((status, String::new(), body.to_string())));
        let identity = identity();
        server.install(&identity, Duration::from_secs(2));
        let event = sign_event(&identity, 9);
        let error = invoke(
            identity.clone(),
            "community_publish",
            json!({"scope":scope(&identity),"event":event}),
        )
        .unwrap_err();
        assert_eq!(error["outcome"], outcome);
        assert_eq!(error["code"], code);
        assert_eq!(
            error.get("retryAfterMs").and_then(Value::as_u64),
            if code == "rateLimited" {
                Some(4000)
            } else {
                None
            }
        );
    }
    let server = Server::start(|r| {
        let event: Value = serde_json::from_slice(&r.body).unwrap();
        response(json!({"event_id":event["id"],"accepted":false,"message":"secret"}))
    });
    let identity = identity();
    server.install(&identity, Duration::from_secs(2));
    let event = sign_event(&identity, 0);
    assert_eq!(
        invoke(
            identity.clone(),
            "community_publish",
            json!({"scope":scope(&identity),"event":event})
        )
        .unwrap()["value"]["accepted"],
        false
    );
}
#[test]
fn invite_expiry_and_policy_expiry_remain_explicit_without_auto_accept_or_claim() {
    for (reason, code) in [
        ("invite_expired", "inviteExpired"),
        ("join_policy_required", "policyRequired"),
    ] {
        let server = Server::start(move |r| {
            assert_eq!(r.path, "/api/invites/claim");
            auth(r);
            Some((403, String::new(), json!({"error":reason}).to_string()))
        });
        let identity = identity();
        server.install(&identity, Duration::from_secs(2));
        let request = json!({"scope":scope(&identity),"code":format!("v2.{}",URL_SAFE_NO_PAD.encode([7;32])),"policy_receipt":"old-receipt"});
        let error = invoke(identity.clone(), "community_claim", request).unwrap_err();
        assert_eq!(error["code"], code);
        assert_eq!(error["outcome"], "rejected");
        assert_eq!(server.requests.lock().unwrap().len(), 1);
    }
}
#[test]
fn production_signers_reject_a_different_valid_pin_without_http() {
    let identity = identity();
    let captured = scope(&identity);
    let mut wrong_pin = captured.clone();
    // Scalar 2: syntactically and cryptographically valid, but not the active key.
    wrong_pin["expectedPubkey"] =
        "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5".into();
    for (command, template) in [
        ("community_sign_message", message()),
        ("community_sign_profile", profile()),
    ] {
        let accepted = invoke(
            identity.clone(),
            command,
            json!({"scope":captured,"template":template}),
        )
        .unwrap();
        assert_eq!(accepted["value"]["pubkey"], PIN);
        assert_eq!(
            invoke(
                identity.clone(),
                command,
                json!({"scope":wrong_pin,"template":template}),
            )
            .unwrap_err(),
            json!({"code":"cancelled"}),
        );
    }
    assert_eq!(scope(&identity), captured);
    assert!(identity.0.relay_http.get().is_none());
}
#[test]
fn scope_validation_and_generation_revocation_pin_fences_precede_http() {
    let identity = identity();
    for (field, value) in [
        ("expectedPubkey", json!("00".repeat(32))),
        ("generation", json!("1")),
        ("revocation", json!(uuid::Uuid::new_v4().to_string())),
        ("origin", json!("http://127.0.0.1")),
    ] {
        let mut captured = scope(&identity);
        captured[field] = value;
        assert!(invoke(
            identity.clone(),
            "community_query",
            json!({"scope":captured,"filters":[{"kinds":[0],"limit":1}]})
        )
        .is_err());
    }
    let old = scope(&identity);
    let event = sign_event(&identity, 9);
    identity
        .sign_out(crate::identity::SignOutRequest {
            revocation: identity.status().unwrap().revocation,
        })
        .unwrap();
    assert_eq!(
        invoke(
            identity.clone(),
            "community_publish",
            json!({"scope":old,"event":event})
        )
        .unwrap_err(),
        json!({"code":"cancelled","outcome":"notSent"})
    );
    assert!(identity.0.relay_http.get().is_none());
}
#[test]
fn signout_during_blocked_http_is_immediate_and_late_result_is_unknown() {
    let (entered, received) = mpsc::channel();
    let released = Arc::new(AtomicBool::new(false));
    let wait = released.clone();
    let server = Server::start(move |r| {
        entered.send(()).unwrap();
        while !wait.load(Ordering::Acquire) {
            thread::sleep(Duration::from_millis(2));
        }
        let event: Value = serde_json::from_slice(&r.body).unwrap();
        response(json!({"event_id":event["id"],"accepted":true}))
    });
    let identity = identity();
    server.install(&identity, Duration::from_secs(3));
    let event = sign_event(&identity, 9);
    let request = json!({"scope":scope(&identity),"event":event});
    let owner = identity.clone();
    let publish = thread::spawn(move || invoke(owner, "community_publish", request));
    received.recv_timeout(Duration::from_secs(2)).unwrap();
    let (sent, done) = mpsc::channel();
    let owner = identity.clone();
    let signout = thread::spawn(move || {
        sent.send(owner.sign_out(crate::identity::SignOutRequest {
            revocation: owner.status().unwrap().revocation,
        }))
        .unwrap()
    });
    let result = done.recv_timeout(Duration::from_millis(500));
    released.store(true, Ordering::Release);
    signout.join().unwrap();
    assert!(result.unwrap().is_ok(), "sign-out cannot wait on HTTP");
    assert_eq!(
        publish.join().unwrap().unwrap_err(),
        json!({"code":"cancelled","outcome":"unknown"})
    );
    assert!(identity.status().unwrap().pubkey.is_none());
}
#[test]
fn native_capacity_survives_missing_reply_and_deadline_releases_slots() {
    let (entered, received) = mpsc::channel();
    let server = Server::start(move |_| {
        entered.send(()).unwrap();
        thread::sleep(Duration::from_millis(450));
        response(json!([]))
    });
    let identity = identity();
    server.install(&identity, Duration::from_millis(200));
    let mut tasks = Vec::new();
    for _ in 0..http::MAX_INFLIGHT {
        let owner = identity.clone();
        let request = json!({"scope":scope(&identity),"filters":[{"kinds":[0],"limit":1}]});
        tasks.push(thread::spawn(move || {
            invoke(owner, "community_query", request)
        }));
    }
    for _ in 0..http::MAX_INFLIGHT {
        received.recv_timeout(Duration::from_secs(2)).unwrap();
    }
    assert_eq!(
        invoke(
            identity.clone(),
            "community_query",
            json!({"scope":scope(&identity),"filters":[{"kinds":[0],"limit":1}]})
        )
        .unwrap_err(),
        json!({"code":"busy"})
    );
    for task in tasks {
        assert_eq!(task.join().unwrap().unwrap_err()["code"], "unavailable");
    }
    assert!(identity.relay_http().unwrap().admit().is_ok());
}
#[test]
fn bounds_and_canonical_origins_reject_repaired_urls_and_unsupported_queries() {
    for input in [
        "https://relay.example/path",
        "https://user@relay.example",
        "https://relay.example?",
        "https://relay.example/#x",
        "https://relay.example\\evil",
        "https://relay.example\n.evil",
        "https://relay.example//",
    ] {
        assert!(http::origin(input).is_err(), "{input}");
    }
    for (input, expected) in [
        (" WSS://Relay.Example.:443/ ", ORIGIN),
        ("https://relay.example:8443", "https://relay.example:8443"),
        ("https://relay.example../", "https://relay.example."),
        ("https://[::1]:443/", "https://[::1]"),
    ] {
        assert_eq!(http::origin(input).unwrap(), expected);
    }
    let identity = identity();
    for filters in [
        json!([]),
        json!([{"kinds":[0],"limit":501}]),
        json!([{"kinds":[0],"limit":1,"read_state_snapshot":true}]),
        json!([{"limit":1}]),
        json!([{"ids":["x"],"limit":1}]),
    ] {
        assert_eq!(
            invoke(
                identity.clone(),
                "community_query",
                json!({"scope":scope(&identity),"filters":filters})
            )
            .unwrap_err(),
            json!({"code":"invalidInput"})
        );
    }
    for code in ["dotless", "v2.invalid", "v2.____", &"x".repeat(1025)] {
        assert!(events::validate_invite(code).is_err());
    }
    let mut event = message();
    event["content"] = "x".repeat(32001).into();
    assert!(invoke(
        identity.clone(),
        "community_sign_message",
        json!({"scope":scope(&identity),"template":event})
    )
    .is_err());
    assert!(identity.0.relay_http.get().is_none());
}

#[test]
fn dispatch_rechecks_authority_after_validated_admission() {
    let server = Server::start(|_| panic!("revoked work cannot dispatch"));
    let identity = identity();
    server.install(&identity, Duration::from_secs(2));
    let captured: Scope = serde_json::from_value(scope(&identity)).unwrap();
    let captured = identity.relay_scope(captured).unwrap();
    let permit = identity.relay_http().unwrap().admit().unwrap();
    identity
        .sign_out(crate::identity::SignOutRequest {
            revocation: captured.revocation.clone(),
        })
        .unwrap();
    let error = tauri::async_runtime::block_on(permit.request(
        &identity,
        &captured,
        http::Operation::Query,
        Some(json!([{"kinds":[0],"limit":1}])),
    ))
    .unwrap_err();
    assert_eq!(error.code, Code::Cancelled);
    assert!(server.requests.lock().unwrap().is_empty());
}

#[test]
fn request_and_response_budgets_are_enforced_at_command_boundaries() {
    let identity = identity();
    for request in [
        json!({"scope":scope(&identity),"filters":[{"kinds":[9],"limit":1,"search":"x".repeat(65536)}]}),
        json!({"scope":scope(&identity),"filters":vec![json!({"kinds":[9],"limit":1});5]}),
    ] {
        assert_eq!(
            invoke(identity.clone(), "community_query", request).unwrap_err(),
            json!({"code":"invalidInput"})
        );
    }
    assert!(identity.0.relay_http.get().is_none());
    for (command, budget) in [
        ("community_discover", http::METADATA_BYTES),
        ("community_query", http::QUERY_BYTES),
    ] {
        let server = Server::start(move |_| Some((200, String::new(), "x".repeat(budget + 1))));
        let identity = self::identity();
        server.install(&identity, Duration::from_secs(2));
        let mut request = json!({"scope":scope(&identity)});
        if command == "community_query" {
            request["filters"] = json!([{"kinds":[9],"limit":1}]);
        }
        assert_eq!(
            invoke(identity, command, request).unwrap_err(),
            json!({"code":"invalidResponse"})
        );
        assert_eq!(server.requests.lock().unwrap().len(), 1);
    }
}
