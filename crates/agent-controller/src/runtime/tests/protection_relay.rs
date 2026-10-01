//! Disposable protocol fixture for real ACP listeners; no external services.
use super::*;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Mutex,
};
use tungstenite::Message;

const CHANNEL: &str = "e1becfb2-7e7f-441d-b079-bcb4f06ed39b";
pub(super) fn public_key(secret: u8) -> String {
    pair(secret).x_only_public_key().0.to_string()
}
fn pair(secret: u8) -> secp256k1::Keypair {
    let mut bytes = [0; 32];
    bytes[31] = secret;
    secp256k1::Keypair::from_secret_key(
        &secp256k1::Secp256k1::new(),
        &secp256k1::SecretKey::from_byte_array(bytes).unwrap(),
    )
}
fn event(kind: u64, tags: serde_json::Value, content: &str) -> serde_json::Value {
    use sha2::{Digest, Sha256};
    let pair = pair(2); // owner used by test_attestation
    let public = pair.x_only_public_key().0.to_string();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let digest =
        Sha256::digest(serde_json::to_vec(&json!([0, public, now, kind, tags, content])).unwrap());
    let id: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    let sig = secp256k1::Secp256k1::new()
        .sign_schnorr_no_aux_rand(&digest, &pair)
        .to_string();
    json!({"id":id,"pubkey":public,"created_at":now,"kind":kind,"tags":tags,"content":content,"sig":sig})
}

pub(super) struct Relay {
    pub url: String,
    clients: Arc<Mutex<Vec<mpsc::Sender<serde_json::Value>>>>,
    published: mpsc::Receiver<serde_json::Value>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Relay {
    pub fn new(agents: &[String]) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let clients = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (send, published) = mpsc::channel();
        let mut members = vec![json!(["d", CHANNEL])];
        members.extend(agents.iter().map(|agent| json!(["p", agent])));
        let membership = event(39002, json!(members), "");
        let metadata = event(
            39000,
            json!([
                ["d", CHANNEL],
                ["name", "Protection fixture"],
                ["t", "stream"]
            ]),
            "",
        );
        let thread = {
            let clients = clients.clone();
            let stop = stop.clone();
            std::thread::spawn(move || {
                let mut connections = Vec::new();
                while !stop.load(Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            let (tx, rx) = mpsc::channel();
                            clients.lock().unwrap().push(tx);
                            let (stop, send, membership, metadata) = (
                                stop.clone(),
                                send.clone(),
                                membership.clone(),
                                metadata.clone(),
                            );
                            connections.push(std::thread::spawn(move || {
                                connection(stream, rx, send, stop, membership, metadata)
                            }));
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(10))
                        }
                        Err(e) => panic!("fixture accept: {e}"),
                    }
                }
                for connection in connections {
                    connection.join().unwrap();
                }
            })
        };
        Self {
            url,
            clients,
            published,
            stop,
            thread: Some(thread),
        }
    }
    pub fn mention(&self, target: &str, content: &str) {
        let event = event(9, json!([["h", CHANNEL], ["p", target]]), content);
        self.clients
            .lock()
            .unwrap()
            .retain(|client| client.send(event.clone()).is_ok());
    }
    pub fn online(&self, agent: &str) {
        let deadline = Instant::now() + Duration::from_secs(30);
        let (mut online, mut subscribed) = (false, false);
        loop {
            let event = self
                .published
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .expect("listener did not publish online presence");
            online |=
                event["kind"] == 20001 && event["content"] == "online" && event["pubkey"] == agent;
            subscribed |= event["subscribed"] == agent;
            if online && subscribed {
                return;
            }
        }
    }
}
impl Drop for Relay {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.thread.take().unwrap().join().unwrap();
    }
}
fn connection(
    mut stream: TcpStream,
    incoming: mpsc::Receiver<serde_json::Value>,
    published: mpsc::Sender<serde_json::Value>,
    stop: Arc<AtomicBool>,
    membership: serde_json::Value,
    metadata: serde_json::Value,
) {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    // Peek headers without consuming a WebSocket handshake.
    let mut peek = [0; 8192];
    let header = loop {
        let Ok(n) = stream.peek(&mut peek) else {
            return;
        };
        if n == 0 {
            return;
        }
        if let Some(end) = peek[..n].windows(4).position(|w| w == b"\r\n\r\n") {
            break String::from_utf8_lossy(&peek[..end + 4]).into_owned();
        }
        if stop.load(Ordering::SeqCst) {
            return;
        }
        std::thread::sleep(Duration::from_millis(1));
    };
    if !header.to_ascii_lowercase().contains("upgrade: websocket") {
        let mut reader = BufReader::new(&mut stream);
        let mut line = String::new();
        let mut length = 0;
        loop {
            line.clear();
            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                return;
            }
            if line == "\r\n" {
                break;
            }
            if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                length = value.trim().parse().unwrap();
            }
        }
        let mut body = vec![0; length];
        if reader.read_exact(&mut body).is_err() {
            return;
        }
        let response = if header.starts_with("POST /query ") {
            let filters: serde_json::Value = serde_json::from_slice(&body).unwrap();
            if filters.as_array().unwrap().iter().any(|f| {
                f["kinds"]
                    .as_array()
                    .is_some_and(|k| k.contains(&json!(39002)))
            }) {
                json!([membership])
            } else if filters.as_array().unwrap().iter().any(|f| {
                f["kinds"]
                    .as_array()
                    .is_some_and(|k| k.contains(&json!(39000)))
            }) {
                json!([metadata])
            } else {
                json!([])
            }
        } else if header.starts_with("POST /events ") {
            let _ = published.send(serde_json::from_slice(&body).unwrap());
            json!({})
        } else if header.starts_with("GET / ") {
            json!({"self":public_key(2)})
        } else {
            json!({"count":0})
        };
        let body = response.to_string();
        let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
        return;
    }
    let Ok(mut ws) = tungstenite::accept(stream) else {
        return;
    };
    ws.get_mut()
        .set_read_timeout(Some(Duration::from_millis(30)))
        .unwrap();
    let mut subscriptions = Vec::<(String, String)>::new();
    if ws
        .send(Message::text(json!(["AUTH", "fixture"]).to_string()))
        .is_err()
    {
        return;
    }
    while !stop.load(Ordering::SeqCst) {
        for event in incoming.try_iter() {
            for (id, target) in &subscriptions {
                if event["tags"]
                    .as_array()
                    .unwrap()
                    .contains(&json!(["p", target]))
                    && ws
                        .send(Message::text(json!(["EVENT", id, event]).to_string()))
                        .is_err()
                {
                    return;
                }
            }
        }
        let text = match ws.read() {
            Ok(Message::Text(text)) => text,
            Ok(_) => continue,
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue
            }
            Err(_) => return,
        };
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        let response = match value[0].as_str() {
            Some("AUTH" | "EVENT") => {
                let _ = published.send(value[1].clone());
                json!(["OK", value[1]["id"], true, ""])
            }
            Some("REQ") => {
                for filter in value.as_array().unwrap().iter().skip(2) {
                    if filter["#h"]
                        .as_array()
                        .is_some_and(|h| h.contains(&json!(CHANNEL)))
                    {
                        for target in filter["#p"].as_array().into_iter().flatten() {
                            let _ = published.send(json!({"subscribed":target}));
                            subscriptions.push((
                                value[1].as_str().unwrap().into(),
                                target.as_str().unwrap().into(),
                            ));
                        }
                    }
                }
                json!(["EOSE", value[1]])
            }
            _ => continue,
        };
        if ws.send(Message::text(response.to_string())).is_err() {
            return;
        }
    }
}
