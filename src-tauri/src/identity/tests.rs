use super::*;
use dto::LegacySource;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Condvar,
    },
    time::Duration,
};
use zeroize::Zeroizing;

const PIN: &str = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const TWO: &str = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
fn key(n: u8) -> IdentityKey {
    let mut bytes = Zeroizing::new([0; 32]);
    bytes[31] = n;
    IdentityKey::from_bytes(bytes).unwrap()
}
fn legacy(n: u8) -> Vec<u8> {
    format!("{{\"identity\":\"{n:064x}\",\"agent\":\"do-not-copy\"}}").into_bytes()
}
fn import_request(identity: &Identity, generation: &str) -> ImportRequest {
    ImportRequest {
        expected_pubkey: PIN.into(),
        generation: generation.into(),
        revocation: identity.status().unwrap().revocation,
        source: LegacySource::BuzzDesktopBlob,
        consent: true,
    }
}
fn unlock_request(identity: &Identity, generation: &str) -> UnlockRequest {
    UnlockRequest {
        expected_pubkey: PIN.into(),
        generation: generation.into(),
        revocation: identity.status().unwrap().revocation,
    }
}
#[derive(Default)]
struct Pause {
    entered: Mutex<bool>,
    released: Mutex<bool>,
    signal: Condvar,
    release_signal: Condvar,
}
impl Pause {
    fn stop(&self) {
        *self.entered.lock().unwrap() = true;
        self.signal.notify_all();
        let mut released = self.released.lock().unwrap();
        while !*released {
            released = self.release_signal.wait(released).unwrap();
        }
    }
    fn wait(&self) {
        let entered = self.entered.lock().unwrap();
        assert!(
            *self
                .signal
                .wait_timeout_while(entered, Duration::from_secs(5), |v| !*v)
                .unwrap()
                .0,
            "operation did not reach store"
        );
    }
    fn release(&self) {
        *self.released.lock().unwrap() = true;
        self.release_signal.notify_all();
    }
}
#[derive(Default)]
struct FakeStore {
    saved: Mutex<HashMap<(String, String), Vec<u8>>>,
    source: Mutex<Vec<u8>>,
    reads: AtomicUsize,
    legacy_reads: Mutex<Vec<LegacySource>>,
    writes: AtomicUsize,
    error: Mutex<Option<ErrorCode>>,
    tamper_write: Mutex<Option<Vec<u8>>>,
    pause_at: Mutex<Option<(&'static str, Arc<Pause>)>>,
}
impl FakeStore {
    fn check(&self) -> Result<()> {
        match *self.error.lock().unwrap() {
            Some(e) => Err(e.into()),
            None => Ok(()),
        }
    }
    fn pause(&self, stage: &str) {
        let pause = self
            .pause_at
            .lock()
            .unwrap()
            .as_ref()
            .filter(|(s, _)| *s == stage)
            .map(|(_, p)| p.clone());
        if let Some(pause) = pause {
            pause.stop();
        }
    }
    fn paused(&self, stage: &'static str) -> Arc<Pause> {
        let pause = Arc::new(Pause::default());
        *self.pause_at.lock().unwrap() = Some((stage, pause.clone()));
        pause
    }
}
impl CredentialStore for FakeStore {
    fn read_legacy(&self, source: LegacySource) -> Result<Zeroizing<Vec<u8>>> {
        self.legacy_reads.lock().unwrap().push(source);
        self.pause("legacy");
        self.check()?;
        Ok(Zeroizing::new(self.source.lock().unwrap().clone()))
    }
    fn read_saved(&self, service: &str, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.pause("read");
        self.check()?;
        Ok(self
            .saved
            .lock()
            .unwrap()
            .get(&(service.into(), account.into()))
            .cloned()
            .map(Zeroizing::new))
    }
    fn add_saved(&self, service: &str, account: &str, value: &[u8]) -> Result<()> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        self.pause("write");
        self.check()?;
        let mut saved = self.saved.lock().unwrap();
        let entry = saved.entry((service.into(), account.into()));
        match entry {
            std::collections::hash_map::Entry::Occupied(_) => Err(ErrorCode::Occupied.into()),
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(
                    self.tamper_write
                        .lock()
                        .unwrap()
                        .clone()
                        .unwrap_or_else(|| value.to_vec()),
                );
                Ok(())
            }
        }
    }
}
fn fixture() -> (Identity, Arc<FakeStore>) {
    let store = Arc::new(FakeStore::default());
    *store.source.lock().unwrap() = legacy(1);
    (Identity::new(Ok("fixture".into()), store.clone()), store)
}
fn do_sign_out(identity: &Identity) -> Result<IdentityStatus> {
    identity.sign_out(SignOutRequest {
        revocation: identity.status()?.revocation,
    })
}
fn do_import(identity: &Identity) -> Result<IdentityStatus> {
    let request = import_request(identity, &identity.status()?.generation);
    let generation = identity.begin(
        &request.expected_pubkey,
        &request.generation,
        &request.revocation,
    )?;
    identity.import(request, generation)
}
fn do_unlock(identity: &Identity) -> Result<IdentityStatus> {
    let request = unlock_request(identity, &identity.status()?.generation);
    let generation = identity.begin(
        &request.expected_pubkey,
        &request.generation,
        &request.revocation,
    )?;
    identity.unlock(request, generation)
}
#[test]
fn lifecycle_never_discovers_or_resurrects_and_preserves_source() {
    let (identity, store) = fixture();
    assert_eq!(identity.status().unwrap().state, StatusState::SignedOut);
    do_sign_out(&identity).unwrap();
    assert_eq!(store.reads.load(Ordering::SeqCst), 0);
    assert_eq!(do_import(&identity).unwrap().pubkey.as_deref(), Some(PIN));
    assert_eq!(
        store.reads.load(Ordering::SeqCst),
        2,
        "fresh read-back required"
    );
    assert_eq!(*store.source.lock().unwrap(), legacy(1));
    assert_eq!(
        store.saved.lock().unwrap().values().next().unwrap().len(),
        33
    );
    assert_eq!(
        do_sign_out(&identity).unwrap().state,
        StatusState::SignedOut
    );
    let restarted = Identity::new(Ok("fixture".into()), store.clone());
    assert_eq!(restarted.status().unwrap().state, StatusState::SignedOut);
    assert_eq!(do_unlock(&restarted).unwrap().pubkey.as_deref(), Some(PIN));
    assert_eq!(store.writes.load(Ordering::SeqCst), 1);
}
#[test]
fn storage_failures_are_distinct_and_never_activate() {
    for code in [
        ErrorCode::Absent,
        ErrorCode::Denied,
        ErrorCode::Unavailable,
        ErrorCode::Corrupt,
    ] {
        let (identity, store) = fixture();
        *store.error.lock().unwrap() = Some(code);
        assert_eq!(do_import(&identity).err().unwrap().code, code);
        let status = identity.status().unwrap();
        assert_eq!(status.state, StatusState::SignedOut);
        assert_eq!(status.reason, Some(code));
        assert_eq!(store.writes.load(Ordering::SeqCst), 0);
    }
}
#[test]
fn mismatched_source_and_destination_are_not_replaced() {
    let (identity, store) = fixture();
    *store.source.lock().unwrap() = legacy(2);
    assert_eq!(
        do_import(&identity).err().unwrap().code,
        ErrorCode::Mismatch
    );
    assert_eq!(store.writes.load(Ordering::SeqCst), 0);
    store.saved.lock().unwrap().insert(
        ("fixture".into(), PIN.into()),
        encode_saved(&key(2)).to_vec(),
    );
    assert_eq!(
        do_unlock(&identity).err().unwrap().code,
        ErrorCode::Mismatch
    );
    assert_eq!(
        do_import(&identity).err().unwrap().code,
        ErrorCode::Mismatch
    );
    assert_eq!(store.writes.load(Ordering::SeqCst), 0);
}
#[test]
fn occupied_even_identical_requires_explicit_unlock() {
    let (identity, store) = fixture();
    do_import(&identity).unwrap();
    do_sign_out(&identity).unwrap();
    assert_eq!(
        do_import(&identity).err().unwrap().code,
        ErrorCode::Occupied
    );
    assert_eq!(store.legacy_reads.lock().unwrap().len(), 1);
    assert_eq!(store.writes.load(Ordering::SeqCst), 1);
    assert_eq!(do_unlock(&identity).unwrap().state, StatusState::Ready);
}
#[test]
fn uncached_tampered_or_missing_readback_cannot_activate() {
    for value in [vec![], encode_saved(&key(2)).to_vec()] {
        let (identity, store) = fixture();
        *store.tamper_write.lock().unwrap() = Some(value);
        assert_eq!(
            do_import(&identity).err().unwrap().code,
            ErrorCode::VerificationFailed
        );
        assert_eq!(identity.status().unwrap().state, StatusState::SignedOut);
    }
}
#[test]
fn cancelled_legacy_read_never_writes_and_cancelled_write_never_activates() {
    for stage in ["legacy", "write"] {
        let (identity, store) = fixture();
        let pause = store.paused(stage);
        let worker = identity.clone();
        let task = std::thread::spawn(move || do_import(&worker));
        pause.wait();
        let signed_out = do_sign_out(&identity).unwrap();
        assert_eq!(signed_out.state, StatusState::SignedOut);
        pause.release();
        assert_eq!(
            task.join().unwrap().err().unwrap().code,
            ErrorCode::Cancelled
        );
        assert_eq!(identity.status().unwrap().state, StatusState::SignedOut);
        assert_eq!(
            store.writes.load(Ordering::SeqCst),
            usize::from(stage == "write")
        );
        assert_eq!(*store.source.lock().unwrap(), legacy(1));
    }
}
#[test]
fn cancelled_unlock_cannot_resurrect_and_stale_request_does_no_io() {
    let (identity, store) = fixture();
    do_import(&identity).unwrap();
    do_sign_out(&identity).unwrap();
    let stale = identity.status().unwrap().generation;
    let pause = store.paused("read");
    let worker = identity.clone();
    let task = std::thread::spawn(move || do_unlock(&worker));
    pause.wait();
    do_sign_out(&identity).unwrap();
    pause.release();
    assert_eq!(
        task.join().unwrap().err().unwrap().code,
        ErrorCode::Cancelled
    );
    let reads = store.reads.load(Ordering::SeqCst);
    assert_eq!(
        identity
            .begin(PIN, &stale, &identity.status().unwrap().revocation)
            .err()
            .unwrap()
            .code,
        ErrorCode::Cancelled
    );
    assert_eq!(store.reads.load(Ordering::SeqCst), reads);
    assert_eq!(identity.status().unwrap().state, StatusState::SignedOut);
}
#[test]
fn concurrent_requests_claim_one_generation_and_do_not_replace_active_identity() {
    let (identity, store) = fixture();
    let request = import_request(&identity, "0");
    let epoch = identity
        .begin(PIN, "0", &identity.status().unwrap().revocation)
        .unwrap();
    assert_eq!(
        identity
            .begin(TWO, "0", &identity.status().unwrap().revocation)
            .err()
            .unwrap()
            .code,
        ErrorCode::Cancelled
    );
    identity.import(request, epoch).unwrap();
    assert_eq!(
        identity
            .begin(
                TWO,
                &identity.status().unwrap().generation,
                &identity.status().unwrap().revocation
            )
            .err()
            .unwrap()
            .code,
        ErrorCode::Busy
    );
    assert_eq!(store.writes.load(Ordering::SeqCst), 1);
}
#[test]
fn strict_legacy_parser_and_nip19_vectors() {
    for raw in [
        b"{\"identity\":\"\"}".as_slice(),
        b"{\"identity\":4}",
        b"{",
        b"{\"identity\":\"x\",\"identity\":\"y\"}",
    ] {
        assert_eq!(
            store::decode_legacy(LegacySource::BuzzDesktopBlob, raw)
                .err()
                .unwrap()
                .code,
            ErrorCode::Corrupt
        );
    }
    assert_eq!(
        store::decode_legacy(LegacySource::BuzzDesktopBlob, b"{}")
            .err()
            .unwrap()
            .code,
        ErrorCode::Absent
    );
    assert_eq!(
        IdentityKey::parse(&format!("{:064x}", 0))
            .err()
            .unwrap()
            .code,
        ErrorCode::Corrupt
    );
    assert_eq!(key(1).pubkey(), PIN);
    assert_eq!(key(2).pubkey(), TWO);
    let nsec =
        bech32::encode::<bech32::Bech32>(bech32::Hrp::parse("nsec").unwrap(), key(1).bytes())
            .unwrap();
    assert_eq!(IdentityKey::parse(&nsec).unwrap().pubkey(), PIN);
    let bad =
        bech32::encode::<bech32::Bech32m>(bech32::Hrp::parse("nsec").unwrap(), key(1).bytes())
            .unwrap();
    assert!(IdentityKey::parse(&bad).is_err());
    for pin in ["nsec1no", "", &PIN.to_uppercase(), &"f".repeat(64)] {
        assert!(validate_pin(pin).is_err());
    }
}
#[test]
fn profile_isolation_and_invalid_configuration_never_fall_back() {
    let default = config::namespace(None, None).unwrap();
    let alternate = config::namespace(Some("test-profile".into()), None).unwrap();
    assert_ne!(default, alternate);
    for profile in ["", "../default", "Default", "a--b", "a/b"] {
        assert!(config::namespace(Some(profile.into()), None).is_err());
    }
    assert!(config::namespace(None, Some("/tmp/isolated".into())).is_err());
    assert!(config::namespace(Some("default".into()), Some("/tmp/isolated".into())).is_err());
    assert!(config::namespace(Some("test".into()), Some("relative".into())).is_err());
    assert!(config::namespace(Some("test".into()), Some("/tmp/isolated".into())).is_ok());
    let (_, store) = fixture();
    let identity = Identity::new(Err(ErrorCode::InvalidConfiguration.into()), store.clone());
    assert_eq!(identity.status().unwrap().state, StatusState::Unavailable);
    assert_eq!(
        do_import(&identity).err().unwrap().code,
        ErrorCode::InvalidConfiguration
    );
    assert_eq!(store.reads.load(Ordering::SeqCst), 0);
    let a = Identity::new(Ok(default), store.clone());
    do_import(&a).unwrap();
    let b = Identity::new(Ok(alternate), store);
    assert_eq!(do_unlock(&b).err().unwrap().code, ErrorCode::Absent);
}

#[test]
fn terminal_generation_revokes_pending_work_even_at_overflow() {
    let (identity, _) = fixture();
    identity.authority().unwrap().generation = u64::MAX - 3;
    let activation = identity
        .begin(
            PIN,
            &(u64::MAX - 3).to_string(),
            &identity.status().unwrap().revocation,
        )
        .unwrap();
    do_sign_out(&identity).unwrap();
    assert_eq!(
        activation.finish(Ok(key(1))).unwrap_err().code,
        ErrorCode::Cancelled
    );
    assert_eq!(identity.status().unwrap().state, StatusState::Unavailable);
    assert_eq!(
        do_sign_out(&identity).unwrap().generation,
        u64::MAX.to_string()
    );
    assert_eq!(
        identity.current(u64::MAX).unwrap_err().code,
        ErrorCode::Cancelled
    );
    assert_eq!(
        identity
            .begin(
                PIN,
                &u64::MAX.to_string(),
                &identity.status().unwrap().revocation
            )
            .err()
            .unwrap()
            .code,
        ErrorCode::Unavailable
    );
    assert!(identity.status().unwrap().pubkey.is_none());
}

#[test]
fn independent_process_models_race_at_create_only_and_never_rollback() {
    let (one, store) = fixture();
    let two = Identity::new(Ok("fixture".into()), store.clone());
    let pause = store.paused("write");
    let a = one.clone();
    let task = std::thread::spawn(move || do_import(&a));
    pause.wait();
    // Another process adds an occupied record after A's preflight read.
    store.saved.lock().unwrap().insert(
        ("fixture".into(), PIN.into()),
        encode_saved(&key(1)).to_vec(),
    );
    assert_eq!(do_unlock(&two).unwrap().pubkey.as_deref(), Some(PIN));
    pause.release();
    assert_eq!(
        task.join().unwrap().err().unwrap().code,
        ErrorCode::Occupied
    );
    assert_eq!(
        store
            .saved
            .lock()
            .unwrap()
            .get(&("fixture".into(), PIN.into()))
            .unwrap(),
        &encode_saved(&key(1)).to_vec()
    );
    assert_eq!(one.status().unwrap().state, StatusState::SignedOut);
}

// Uses the same handler factory as run(), not a duplicate test registration.
fn invoke(
    identity: Identity,
    command: &str,
    body: serde_json::Value,
) -> std::result::Result<serde_json::Value, serde_json::Value> {
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
            body: tauri::ipc::InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
    )
    .map(|body| body.deserialize().unwrap())
}
fn request(identity: &Identity) -> serde_json::Value {
    let status = identity.status().unwrap();
    serde_json::json!({"expectedPubkey": PIN, "generation": status.generation, "revocation": status.revocation})
}
fn import_body(identity: &Identity) -> serde_json::Value {
    let mut request = request(identity);
    request["source"] = "buzzDesktopBlob".into();
    request["consent"] = true.into();
    serde_json::json!({"request": request})
}
fn sign_out_body(identity: &Identity) -> serde_json::Value {
    serde_json::json!({"request":{"revocation": identity.status().unwrap().revocation}})
}

#[test]
fn production_ipc_registration_consent_pin_and_public_projection() {
    use serde_json::json;
    let (identity, store) = fixture();
    let status = invoke(identity.clone(), "identity_status", json!({})).unwrap();
    assert_eq!(
        status,
        serde_json::to_value(identity.status().unwrap()).unwrap()
    );
    assert_eq!(status["state"], "signedOut");
    assert_eq!(status["busy"], false);
    let mut body = import_body(&identity);
    body["request"]["consent"] = false.into();
    assert_eq!(
        invoke(identity.clone(), "identity_import_legacy", body).unwrap_err(),
        json!({"code":"invalidInput"})
    );
    assert_eq!(store.reads.load(Ordering::SeqCst), 0);
    let ready = invoke(
        identity.clone(),
        "identity_import_legacy",
        import_body(&identity),
    )
    .unwrap();
    assert_eq!(
        ready,
        json!({"state":"ready","pubkey":PIN,"generation":"2","revocation":status["revocation"],"busy":false,"reason":null})
    );
    assert_eq!(
        *store.legacy_reads.lock().unwrap(),
        vec![LegacySource::BuzzDesktopBlob]
    );
    assert_eq!(
        invoke(
            identity.clone(),
            "identity_sign_out",
            sign_out_body(&identity)
        )
        .unwrap()["generation"],
        "3"
    );
    let ready = invoke(
        identity.clone(),
        "identity_unlock_saved",
        json!({"request":request(&identity)}),
    )
    .unwrap();
    assert_eq!(ready["pubkey"], PIN);
    for command in [
        "identity_generate",
        "identity_sign",
        "sign_event",
        "identity_decrypt",
        "identity_export",
        "identity_shutdown",
    ] {
        assert!(invoke(identity.clone(), command, json!({})).is_err());
    }
}

#[test]
fn production_ipc_per_key_and_mismatched_request_fail_closed() {
    let (identity, store) = fixture();
    *store.source.lock().unwrap() = format!("{:064x}", 1).into_bytes();
    let make = |pin: &str| {
        let mut body = import_body(&identity);
        body["request"]["source"] = "buzzDesktopPerKey".into();
        body["request"]["expectedPubkey"] = pin.into();
        body
    };
    assert_eq!(
        invoke(identity.clone(), "identity_import_legacy", make(TWO)).unwrap_err(),
        serde_json::json!({"code":"mismatch"})
    );
    assert_eq!(store.writes.load(Ordering::SeqCst), 0);
    assert_eq!(
        invoke(identity.clone(), "identity_import_legacy", make(PIN)).unwrap()["pubkey"],
        PIN
    );
    assert_eq!(
        *store.legacy_reads.lock().unwrap(),
        vec![LegacySource::BuzzDesktopPerKey; 2]
    );
}

#[test]
fn malformed_ipc_is_redacted_before_serde_can_echo_untrusted_secret_text() {
    use serde_json::json;
    let (identity, store) = fixture();
    for command in [
        "identity_import_legacy",
        "identity_unlock_saved",
        "identity_sign_out",
    ] {
        for request in [
            json!("nsec1DO_NOT_ECHO"),
            json!({"nsec1DO_NOT_ECHO":1}),
            json!({"revocation":42}),
        ] {
            assert_eq!(
                invoke(identity.clone(), command, json!({"request":request})).unwrap_err(),
                json!({"code":"invalidInput"})
            );
        }
    }
    let mut body = import_body(&identity);
    body["request"]["source"] = "nsec1DO_NOT_ECHO".into();
    assert_eq!(
        invoke(identity.clone(), "identity_import_legacy", body).unwrap_err(),
        json!({"code":"invalidInput"})
    );
    assert_eq!(store.reads.load(Ordering::SeqCst), 0);
}

#[test]
fn production_handlers_duplicate_import_unlock_and_old_signout_do_no_second_mutation() {
    use serde_json::json;
    let (identity, store) = fixture();
    let copy = import_body(&identity);
    invoke(identity.clone(), "identity_import_legacy", copy.clone()).unwrap();
    assert_eq!(
        invoke(identity.clone(), "identity_import_legacy", copy).unwrap_err(),
        json!({"code":"cancelled"})
    );
    assert_eq!(store.writes.load(Ordering::SeqCst), 1);
    let out = sign_out_body(&identity);
    invoke(identity.clone(), "identity_sign_out", out.clone()).unwrap();
    let unlock = json!({"request":request(&identity)});
    invoke(identity.clone(), "identity_unlock_saved", unlock.clone()).unwrap();
    let reads = store.reads.load(Ordering::SeqCst);
    assert_eq!(
        invoke(identity.clone(), "identity_unlock_saved", unlock).unwrap_err(),
        json!({"code":"cancelled"})
    );
    assert_eq!(
        invoke(identity.clone(), "identity_sign_out", out).unwrap_err(),
        json!({"code":"cancelled"})
    );
    assert_eq!(store.reads.load(Ordering::SeqCst), reads);
    assert_eq!(identity.status().unwrap().pubkey.as_deref(), Some(PIN));
}

#[test]
fn production_handlers_blocked_os_does_not_block_signout_or_admit_more_os_work() {
    use serde_json::json;
    for stage in ["legacy", "write", "read"] {
        let (identity, store) = fixture();
        let body = import_body(&identity);
        let sign_out = sign_out_body(&identity); // captured BEFORE activation admission
        let pause = store.paused(stage);
        let worker = identity.clone();
        let task = std::thread::spawn(move || invoke(worker, "identity_import_legacy", body));
        pause.wait();
        assert_eq!(
            invoke(identity.clone(), "identity_status", json!({})).unwrap()["busy"],
            true
        );
        let out = invoke(identity.clone(), "identity_sign_out", sign_out.clone()).unwrap();
        assert_eq!(out["state"], "signedOut");
        assert_eq!(out["busy"], true);
        // Even fresh requests cannot build a worker queue behind cancelled OS work.
        for _ in 0..8 {
            let (send, receive) = std::sync::mpsc::channel();
            let worker = identity.clone();
            let body = import_body(&identity);
            let attempt = std::thread::spawn(move || {
                let _ = send.send(invoke(worker, "identity_import_legacy", body));
            });
            let response = receive.recv_timeout(Duration::from_secs(2));
            if response.is_err() {
                pause.release();
            }
            attempt.join().unwrap();
            assert_eq!(
                response
                    .expect("busy request must not enter blocked OS work")
                    .unwrap_err(),
                json!({"code":"busy"})
            );
        }
        pause.release();
        assert_eq!(
            task.join().unwrap().unwrap_err(),
            json!({"code":"cancelled"})
        );
        assert!(!identity.status().unwrap().busy);
        assert_eq!(identity.status().unwrap().state, StatusState::SignedOut);
        // A healthy action recovers; a cancelled create may have saved a copy.
        if stage == "write" {
            invoke(
                identity.clone(),
                "identity_unlock_saved",
                json!({"request":request(&identity)}),
            )
            .unwrap();
        } else {
            invoke(
                identity.clone(),
                "identity_import_legacy",
                import_body(&identity),
            )
            .unwrap();
        }
        assert_eq!(
            invoke(identity.clone(), "identity_sign_out", sign_out).unwrap_err(),
            json!({"code":"cancelled"})
        );
        assert_eq!(identity.status().unwrap().pubkey.as_deref(), Some(PIN));
    }
}

#[test]
fn production_handler_delayed_activation_cannot_adopt_post_signout_authority() {
    use serde_json::json;
    let (identity, store) = fixture();
    let body = import_body(&identity);
    invoke(
        identity.clone(),
        "identity_sign_out",
        sign_out_body(&identity),
    )
    .unwrap();
    // Its async handler is FIRST invoked after sign-out, not just completed late.
    assert_eq!(
        invoke(identity.clone(), "identity_import_legacy", body).unwrap_err(),
        json!({"code":"cancelled"})
    );
    assert_eq!(store.reads.load(Ordering::SeqCst), 0);
    let foreign_process = Identity::new(Ok("fixture".into()), store.clone());
    let foreign_body = import_body(&foreign_process);
    assert_eq!(
        invoke(identity.clone(), "identity_import_legacy", foreign_body).unwrap_err(),
        json!({"code":"cancelled"})
    );
    assert_eq!(store.reads.load(Ordering::SeqCst), 0);
}

#[test]
fn activation_guard_releases_unscheduled_work_and_shutdown_revokes() {
    let (identity, _) = fixture();
    let status = identity.status().unwrap();
    let activation = identity
        .begin(PIN, &status.generation, &status.revocation)
        .unwrap();
    assert!(identity.status().unwrap().busy);
    drop(activation);
    assert!(!identity.status().unwrap().busy);
    do_import(&identity).unwrap();
    identity.shutdown();
    assert_eq!(identity.status().unwrap().state, StatusState::Unavailable);
    assert!(identity.status().unwrap().pubkey.is_none());
    assert_eq!(
        invoke(
            identity.clone(),
            "identity_unlock_saved",
            serde_json::json!({"request":request(&identity)})
        )
        .unwrap_err(),
        serde_json::json!({"code":"unavailable"})
    );
}

#[test]
fn production_handler_equal_revision_different_process_rejects_activation_and_signout() {
    use serde_json::json;
    let (identity, store) = fixture();
    let foreign = Identity::new(Ok("fixture".into()), store.clone());
    assert_eq!(
        identity.status().unwrap().generation,
        foreign.status().unwrap().generation
    );
    assert_eq!(
        invoke(
            identity.clone(),
            "identity_import_legacy",
            import_body(&foreign)
        )
        .unwrap_err(),
        json!({"code":"cancelled"})
    );
    assert_eq!(
        invoke(
            identity.clone(),
            "identity_sign_out",
            sign_out_body(&foreign)
        )
        .unwrap_err(),
        json!({"code":"cancelled"})
    );
    assert_eq!(store.reads.load(Ordering::SeqCst), 0);
    assert_eq!(identity.status().unwrap().generation, "0");
}

#[test]
fn readback_same_public_key_but_different_secret_is_not_the_saved_identity() {
    let (identity, store) = fixture();
    // X-only public keys of k and -k are identical. Compare the saved scalar too.
    let opposite =
        IdentityKey::parse("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140")
            .unwrap();
    assert_eq!(opposite.pubkey(), PIN);
    *store.tamper_write.lock().unwrap() = Some(encode_saved(&opposite).to_vec());
    assert_eq!(
        invoke(
            identity.clone(),
            "identity_import_legacy",
            import_body(&identity)
        )
        .unwrap_err(),
        serde_json::json!({"code":"verificationFailed"})
    );
    assert_eq!(identity.status().unwrap().state, StatusState::SignedOut);
}

#[test]
fn production_unlock_completion_cannot_resurrect_after_signout() {
    use serde_json::json;
    let (identity, store) = fixture();
    invoke(
        identity.clone(),
        "identity_import_legacy",
        import_body(&identity),
    )
    .unwrap();
    invoke(
        identity.clone(),
        "identity_sign_out",
        sign_out_body(&identity),
    )
    .unwrap();
    let unlock = json!({"request":request(&identity)});
    let sign_out = sign_out_body(&identity);
    let pause = store.paused("read");
    let worker = identity.clone();
    let task = std::thread::spawn(move || invoke(worker, "identity_unlock_saved", unlock));
    pause.wait();
    invoke(identity.clone(), "identity_sign_out", sign_out).unwrap();
    pause.release();
    assert_eq!(
        task.join().unwrap().unwrap_err(),
        json!({"code":"cancelled"})
    );
    assert_eq!(identity.status().unwrap().state, StatusState::SignedOut);
    assert!(!identity.status().unwrap().busy);
    invoke(
        identity.clone(),
        "identity_unlock_saved",
        json!({"request":request(&identity)}),
    )
    .unwrap();
}
