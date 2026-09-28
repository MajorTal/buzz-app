use super::*;
use crate::{config::agent_id, Imports, Store};
use serde_json::json;
use std::sync::Mutex;
const KEY: &str = "0000000000000000000000000000000000000000000000000000000000000001";
const PUB: &str = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

#[derive(Default)]
struct Fake {
    entries: Mutex<BTreeMap<(String, String), Vec<u8>>>,
    failure: Mutex<Option<Failure>>,
    calls: Mutex<Vec<(String, String, String)>>,
}
impl Fake {
    fn put(&self, service: &str, account: &str, bytes: Vec<u8>) {
        self.entries
            .lock()
            .unwrap()
            .insert((service.into(), account.into()), bytes);
    }
    fn get(
        &self,
        operation: &str,
        service: &str,
        account: &str,
    ) -> std::result::Result<Zeroizing<Vec<u8>>, Failure> {
        self.calls
            .lock()
            .unwrap()
            .push((operation.into(), service.into(), account.into()));
        if let Some(error) = *self.failure.lock().unwrap() {
            return Err(error);
        }
        self.entries
            .lock()
            .unwrap()
            .get(&(service.into(), account.into()))
            .cloned()
            .map(Zeroizing::new)
            .ok_or(Failure::Absent)
    }
}
impl Keychain for Fake {
    fn delete(&self, service: &str, account: &str) -> std::result::Result<(), Failure> {
        self.calls
            .lock()
            .unwrap()
            .push(("delete".into(), service.into(), account.into()));
        if let Some(error) = *self.failure.lock().unwrap() {
            return Err(error);
        }
        self.entries
            .lock()
            .unwrap()
            .remove(&(service.into(), account.into()))
            .map(|_| ())
            .ok_or(Failure::Absent)
    }
    fn legacy(
        &self,
        service: &str,
        account: &str,
    ) -> std::result::Result<Zeroizing<Vec<u8>>, Failure> {
        self.get("legacy", service, account)
    }
    fn saved(
        &self,
        service: &str,
        account: &str,
    ) -> std::result::Result<Zeroizing<Vec<u8>>, Failure> {
        self.get("saved", service, account)
    }
    fn add(&self, service: &str, account: &str, bytes: &[u8]) -> std::result::Result<(), Failure> {
        self.calls
            .lock()
            .unwrap()
            .push(("add".into(), service.into(), account.into()));
        if let Some(error) = *self.failure.lock().unwrap() {
            return Err(error);
        }
        let mut entries = self.entries.lock().unwrap();
        match entries.entry((service.into(), account.into())) {
            std::collections::btree_map::Entry::Occupied(_) => Err(Failure::Occupied),
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(bytes.into());
                Ok(())
            }
        }
    }
}
fn fixture() -> (PlatformCredentials, Arc<Fake>) {
    let keychain = Arc::new(Fake::default());
    (
        PlatformCredentials {
            keychain: keychain.clone(),
        },
        keychain,
    )
}
#[test]
fn deletion_is_bound_to_this_apps_exact_credential_and_can_be_retried() {
    let (credentials, fake) = fixture();
    let id = agent_id(PUB, "wss://relay.example");
    let account = format!("agent:{id}");
    fake.put(SERVICE, &account, KEY.as_bytes().to_vec());
    fake.put("buzz-desktop", "secrets", blob());
    assert!(credentials.delete(&id, &"ab".repeat(32)).is_err());
    assert!(fake
        .entries
        .lock()
        .unwrap()
        .contains_key(&(SERVICE.into(), account.clone())));
    credentials.delete(&id, PUB).unwrap();
    credentials.delete(&id, PUB).unwrap();
    assert!(!fake
        .entries
        .lock()
        .unwrap()
        .contains_key(&(SERVICE.into(), account)));
    assert!(fake
        .entries
        .lock()
        .unwrap()
        .contains_key(&("buzz-desktop".into(), "secrets".into())));
}
fn blob() -> Vec<u8> {
    serde_json::to_vec(&json!({format!("agent:{PUB}"):KEY, "identity":"not-the-agent-key"}))
        .unwrap()
}

#[test]
fn production_credential_adapter_selects_exact_legacy_service_and_account() {
    for (source, service, other) in [
        (LegacySource::Installed, "buzz-desktop", "buzz-desktop-dev"),
        (
            LegacySource::Development,
            "buzz-desktop-dev",
            "buzz-desktop",
        ),
    ] {
        let (credentials, fake) = fixture();
        fake.put(service, "secrets", blob());
        fake.put(other, "secrets", b"malformed-other-source".to_vec());
        assert_eq!(credentials.read_legacy(source, PUB).unwrap().pubkey(), PUB);
        assert_eq!(
            *fake.calls.lock().unwrap(),
            vec![("legacy".into(), service.into(), "secrets".into())]
        );
    }
}

#[test]
fn missing_denied_and_malformed_legacy_never_fall_back_or_write() {
    for selected in [LegacySource::Installed, LegacySource::Development] {
        for failure in [
            Some(Failure::Absent),
            Some(Failure::Denied),
            Some(Failure::Busy),
            Some(Failure::Corrupt),
            None,
        ] {
            let (credentials, fake) = fixture();
            *fake.failure.lock().unwrap() = failure;
            fake.put("buzz-desktop", "secrets", blob());
            fake.put("buzz-desktop-dev", "secrets", blob());
            if failure.is_none() {
                fake.put(
                    selected.keyring_service(),
                    "secrets",
                    b"RAW_SECRET_MALFORMED_JSON".to_vec(),
                );
            }
            let error = credentials.read_legacy(selected, PUB).err().unwrap();
            assert!(!error.contains("RAW_SECRET"));
            assert_eq!(
                *fake.calls.lock().unwrap(),
                vec![(
                    "legacy".into(),
                    selected.keyring_service().into(),
                    "secrets".into()
                )]
            );
        }
    }
}

#[test]
fn legacy_blob_rejects_wrong_keys_duplicates_and_unbounded_data() {
    for bytes in [
        b"{}".to_vec(),
        serde_json::to_vec(&json!({"identity":KEY})).unwrap(),
        serde_json::to_vec(&json!({format!("agent:{PUB}"):"0000000000000000000000000000000000000000000000000000000000000002"})).unwrap(),
        format!("{{\"agent:{PUB}\":\"{KEY}\",\"agent:{PUB}\":\"{KEY}\"}}").into_bytes(),
        serde_json::to_vec(&json!({format!("agent:{PUB}"):KEY, "other":12})).unwrap(),
        [blob(), vec![b' '; MAX_BLOB]].concat(),
    ] {
        let (credentials, fake) = fixture();
        fake.put("buzz-desktop", "secrets", bytes);
        assert!(credentials.read_legacy(LegacySource::Installed, PUB).is_err());
        assert_eq!(fake.calls.lock().unwrap().len(), 1);
    }
}

#[test]
fn destination_is_separate_exact_bound_create_only_and_verified() {
    let (credentials, fake) = fixture();
    let id = agent_id(PUB, "wss://relay.example");
    let account = format!("agent:{id}");
    assert!(credentials.read(&id, PUB).unwrap().is_none());
    credentials
        .add(&id, &Secret::parse(KEY, PUB).unwrap())
        .unwrap();
    assert_eq!(*credentials.read(&id, PUB).unwrap().unwrap().hex(), KEY);
    assert!(credentials
        .add(&id, &Secret::parse(KEY, PUB).unwrap())
        .unwrap_err()
        .contains("already exists"));
    assert_eq!(
        *fake.calls.lock().unwrap(),
        ["saved", "add", "saved", "add"].map(|op| (
            op.into(),
            "dev.local.buzz.foundation.agents".into(),
            account.clone()
        ))
    );
    assert_eq!(fake.entries.lock().unwrap().len(), 1);
    *fake.failure.lock().unwrap() = Some(Failure::Denied);
    assert!(credentials.read(&id, PUB).is_err()); // denied != absent
    *fake.failure.lock().unwrap() = None;
    fake.put(
        "dev.local.buzz.foundation.agents",
        &account,
        b"0000000000000000000000000000000000000000000000000000000000000002".to_vec(),
    );
    assert!(credentials.read(&id, PUB).is_err()); // never substitute identity
    fake.calls.lock().unwrap().clear();
    assert!(credentials.read("identity", PUB).is_err());
    assert!(credentials.read(&id, &"ab".repeat(32)).is_err());
    assert!(credentials
        .add(
            &agent_id(&"ab".repeat(32), "wss://relay.example"),
            &Secret::parse(KEY, PUB).unwrap()
        )
        .is_err());
    assert!(fake.calls.lock().unwrap().is_empty());
}

#[test]
fn preview_commit_uses_production_adapter_and_reads_back_create_only_destination() {
    let legacy = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    let root = legacy
        .path()
        .join(LegacySource::Development.app_directory())
        .join("agents");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
        root.join("managed-agents.json"),
        serde_json::to_vec(&json!([
            {"pubkey":PUB, "relay_url":"wss://relay.example", "name":"Fixture"}
        ]))
        .unwrap(),
    )
    .unwrap();
    let (credentials, fake) = fixture();
    fake.put("buzz-desktop-dev", "secrets", blob());
    let mut imports = Imports::default();
    let preview = imports
        .preview(
            LegacySource::Development,
            legacy.path().into(),
            dest.path().into(),
            "wss://relay.example",
        )
        .unwrap();
    assert!(fake.calls.lock().unwrap().is_empty());
    let id = preview.candidates[0].id.clone();
    let mut store = Store::open(dest.path().into()).unwrap();
    imports
        .commit(
            &preview.token,
            std::slice::from_ref(&id),
            &mut store,
            &credentials,
        )
        .unwrap();
    let account = format!("agent:{id}");
    assert_eq!(
        *fake.calls.lock().unwrap(),
        vec![
            ("legacy".into(), "buzz-desktop-dev".into(), "secrets".into()),
            (
                "saved".into(),
                "dev.local.buzz.foundation.agents".into(),
                account.clone()
            ),
            (
                "add".into(),
                "dev.local.buzz.foundation.agents".into(),
                account.clone()
            ),
            (
                "saved".into(),
                "dev.local.buzz.foundation.agents".into(),
                account
            ),
        ]
    );
    let snapshot = store.snapshot().unwrap();
    assert!(!snapshot.agents[0].enabled);
    assert!(!serde_json::to_string(&snapshot).unwrap().contains(KEY));
}

#[test]
fn default_platform_cannot_access_keychain_in_unit_tests() {
    let credentials = PlatformCredentials::default();
    assert!(credentials
        .read_legacy(LegacySource::Installed, PUB)
        .is_err());
    let id = agent_id(PUB, "wss://relay.example");
    assert!(credentials.read(&id, PUB).is_err());
    assert!(credentials
        .add(&id, &Secret::parse(KEY, PUB).unwrap())
        .is_err());
}
