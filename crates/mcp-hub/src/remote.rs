//! MCP over streamable HTTP to a connected app. Every POST carries a fresh
//! NIP-98 event signed by the agent's key, with the owner's NIP-OA attestation
//! when the agent has one, so the app knows which agent is calling and for whom.
use base64::Engine;
use buzz_agent_controller::Secret;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

pub type Result<T> = std::result::Result<T, String>;

const PROTOCOL_VERSION: &str = "2025-06-18";
const MAX_RESPONSE_BYTES: u64 = 1024 * 1024;
const MAX_TOOLS: usize = 64;

/// The agent's identity for signing app requests.
pub struct Signer {
    pub secret: Secret,
    pub attestation: Option<String>,
}

impl Signer {
    fn authorization(&self, url: &str, body: &[u8]) -> Result<String> {
        let event = self
            .secret
            .app_request_auth(url, body, self.attestation.as_deref())?;
        Ok(format!(
            "Nostr {}",
            base64::engine::general_purpose::STANDARD.encode(event.to_string())
        ))
    }
}

#[derive(Clone)]
struct Session {
    id: Option<String>,
    protocol: String,
}

pub struct Client {
    http: reqwest::blocking::Client,
    signer: Signer,
    sessions: Mutex<HashMap<String, Session>>,
    next_id: AtomicU64,
}

/// A transport answer: no body (202) or one JSON-RPC message.
type Answer = (Option<String>, Option<Value>);

impl Client {
    pub fn new(signer: Signer) -> Result<Self> {
        let http = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            // The signature names one URL; never follow it anywhere else.
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("buzz-mcp-hub/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| "Could not start the HTTP client")?;
        Ok(Self {
            http,
            signer,
            sessions: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        })
    }

    /// The app's tools (at most 64), following pagination.
    pub fn list_tools(&self, url: &str) -> Result<Vec<Value>> {
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..4 {
            let params = cursor.map_or(json!({}), |c| json!({ "cursor": c }));
            let result = self.request(url, "tools/list", params)?;
            let page = result["tools"]
                .as_array()
                .ok_or("The app returned no tool list")?;
            tools.extend(page.iter().cloned());
            cursor = result["nextCursor"].as_str().map(str::to_owned);
            if cursor.is_none() || tools.len() >= MAX_TOOLS {
                break;
            }
        }
        tools.truncate(MAX_TOOLS);
        Ok(tools)
    }

    /// The app's `CallToolResult` for one call.
    pub fn call_tool(&self, url: &str, name: &str, arguments: Value) -> Result<Value> {
        self.request(
            url,
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
        )
    }

    fn request(&self, url: &str, method: &str, params: Value) -> Result<Value> {
        let session = self.session(url)?;
        match self.rpc(url, method, params.clone(), Some(&session)) {
            // A server that forgot its session asks for a new one with 404.
            Err(e) if e.starts_with("HTTP 404") && session.id.is_some() => {
                self.lock().remove(url);
                let session = self.session(url)?;
                self.rpc(url, method, params, Some(&session))
            }
            other => other,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Session>> {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn session(&self, url: &str) -> Result<Session> {
        if let Some(session) = self.lock().get(url) {
            return Ok(session.clone());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let body = json!({
            "jsonrpc": "2.0", "id": id, "method": "initialize",
            "params": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": "buzz-mcp-hub", "version": env!("CARGO_PKG_VERSION") }
            }
        });
        let (session_id, message) = self.post(url, &body, None)?;
        let result = rpc_result(message, id)?;
        let session = Session {
            id: session_id,
            protocol: result["protocolVersion"]
                .as_str()
                .unwrap_or(PROTOCOL_VERSION)
                .to_owned(),
        };
        let initialized = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        self.post(url, &initialized, Some(&session))?;
        self.lock().insert(url.to_owned(), session.clone());
        Ok(session)
    }

    fn rpc(
        &self,
        url: &str,
        method: &str,
        params: Value,
        session: Option<&Session>,
    ) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let body = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        rpc_result(self.post(url, &body, session)?.1, id)
    }

    fn post(&self, url: &str, message: &Value, session: Option<&Session>) -> Result<Answer> {
        let body = serde_json::to_vec(message).map_err(|_| "Could not encode the request")?;
        let mut request = self
            .http
            .post(url)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .header("authorization", self.signer.authorization(url, &body)?);
        if let Some(session) = session {
            request = request.header("mcp-protocol-version", &session.protocol);
            if let Some(id) = &session.id {
                request = request.header("mcp-session-id", id);
            }
        }
        let response = request
            .body(body)
            .send()
            .map_err(|e| format!("Could not reach {url}: {}", without_url(&e)))?;
        let status = response.status();
        let session_id = response
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let event_stream = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.starts_with("text/event-stream"));
        let mut text = String::new();
        response
            .take(MAX_RESPONSE_BYTES + 1)
            .read_to_string(&mut text)
            .map_err(|_| format!("Could not read the answer from {url}"))?;
        if text.len() as u64 > MAX_RESPONSE_BYTES {
            return Err(format!("The answer from {url} is larger than 1 MiB"));
        }
        if !status.is_success() {
            return Err(format!(
                "HTTP {} from {url}: {}",
                status.as_u16(),
                refusal(&text)
            ));
        }
        if status.as_u16() == 202 || text.trim().is_empty() {
            return Ok((session_id, None));
        }
        let message = if event_stream {
            last_sse_message(&text)
        } else {
            serde_json::from_str(&text).ok()
        };
        let message = message.ok_or_else(|| format!("The answer from {url} is not JSON-RPC"))?;
        Ok((session_id, Some(message)))
    }
}

fn without_url(error: &reqwest::Error) -> String {
    let mut text = error.to_string();
    if let Some(url) = error.url() {
        text = text.replace(url.as_str(), "the app");
    }
    text
}

/// The app's own words for a refusal, shortened.
fn refusal(body: &str) -> String {
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    let message = parsed
        .as_ref()
        .and_then(|v| {
            let code = v["code"].as_str();
            let message = v["message"].as_str().or(v["error"]["message"].as_str());
            message.map(|m| code.map_or(m.to_owned(), |c| format!("{c}: {m}")))
        })
        .unwrap_or_else(|| body.trim().to_owned());
    message.chars().take(300).collect()
}

/// The last JSON `data:` payload of an event stream.
fn last_sse_message(text: &str) -> Option<Value> {
    let mut last = None;
    let mut data = String::new();
    for line in text.lines().chain(std::iter::once("")) {
        if let Some(rest) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(rest.strip_prefix(' ').unwrap_or(rest));
        } else if line.is_empty() && !data.is_empty() {
            if let Ok(value) = serde_json::from_str::<Value>(&data) {
                if value.get("id").is_some() {
                    last = Some(value);
                }
            }
            data.clear();
        }
    }
    last
}

fn rpc_result(message: Option<Value>, id: u64) -> Result<Value> {
    let message = message.ok_or("The app sent no answer")?;
    if message["id"] != json!(id) {
        return Err("The app answered a different request".into());
    }
    if let Some(error) = message.get("error") {
        return Err(format!(
            "The app refused the request ({}): {}",
            error["code"],
            error["message"].as_str().unwrap_or("no message")
        ));
    }
    message
        .get("result")
        .cloned()
        .ok_or_else(|| "The app's answer has no result".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_last_response_from_an_event_stream() {
        let stream =
            "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\n\
                      data: {\"jsonrpc\":\"2.0\",\n\
                      data: \"id\":3,\"result\":{}}\n\n";
        assert_eq!(
            last_sse_message(stream),
            Some(json!({"jsonrpc":"2.0","id":3,"result":{}}))
        );
        assert_eq!(last_sse_message("data: not json\n\n"), None);
    }

    #[test]
    fn surfaces_the_apps_own_refusal() {
        assert_eq!(
            refusal(r#"{"ok":false,"code":"NOSTR_AUTH_STALE","message":"not fresh"}"#),
            "NOSTR_AUTH_STALE: not fresh"
        );
        assert_eq!(refusal("  gateway down \n"), "gateway down");
        assert_eq!(refusal(&"x".repeat(1000)).len(), 300);
    }

    #[test]
    fn checks_the_answer_matches_the_request() {
        assert_eq!(
            rpc_result(Some(json!({"jsonrpc":"2.0","id":2,"result":{"ok":1}})), 2).unwrap(),
            json!({"ok":1})
        );
        assert!(rpc_result(Some(json!({"jsonrpc":"2.0","id":3,"result":{}})), 2).is_err());
        assert!(rpc_result(
            Some(json!({"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"no"}})),
            2
        )
        .unwrap_err()
        .contains("-32601"));
        assert!(rpc_result(None, 2).is_err());
    }
}
