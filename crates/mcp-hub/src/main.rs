//! `buzz-mcp-hub`: the one stdio MCP server a local agent gets.
//!
//! It runs the verified `buzz-dev-mcp` as a child and passes its traffic through
//! unchanged, adding the hub's app tools to `tools/list` and answering calls to
//! them itself. Everything it needs comes from the launch file the controller
//! put in this run's private temporary directory, plus the agent key and owner
//! attestation the harness already gives every MCP server.
mod remote;
mod tools;

use buzz_agent_controller::apps::{self, Launch};
use buzz_agent_controller::Secret;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

type Out = Arc<Mutex<std::io::Stdout>>;

struct Hub {
    launch: Launch,
    client: Result<remote::Client, String>,
    /// App tools fixed at the session's first `tools/list`.
    exposed: OnceLock<(Vec<tools::Exposed>, Vec<Value>)>,
}

impl Hub {
    fn new(launch: Launch) -> Self {
        let client = signer(&launch.pubkey).and_then(remote::Client::new);
        if let Err(reason) = &client {
            eprintln!("buzz-mcp-hub: apps unavailable: {reason}");
        }
        Self {
            launch,
            client,
            exposed: OnceLock::new(),
        }
    }

    fn client(&self) -> Result<&remote::Client, &str> {
        self.client.as_ref().map_err(String::as_str)
    }

    /// Connected apps' tools, read once per session; failures are logged and skipped.
    fn exposed(&self, child_tools: &[Value]) -> &(Vec<tools::Exposed>, Vec<Value>) {
        self.exposed.get_or_init(|| {
            let mut taken: HashSet<String> = child_tools
                .iter()
                .chain(tools::hub_tools().iter())
                .filter_map(|t| t["name"].as_str().map(str::to_owned))
                .collect();
            let (Ok(client), Ok(apps)) = (self.client(), apps::read(&self.launch.apps)) else {
                return (Vec::new(), Vec::new());
            };
            let mut routes = Vec::new();
            let mut definitions = Vec::new();
            for (app, listed) in tools::probe_all(client, &apps) {
                match listed {
                    Ok(listed) => {
                        for (route, definition) in tools::expose(&app, &listed, &mut taken) {
                            routes.push(route);
                            definitions.push(definition);
                        }
                    }
                    Err(e) => eprintln!("buzz-mcp-hub: {} unavailable: {e}", app.name),
                }
            }
            (routes, definitions)
        })
    }

    fn is_own_tool(&self, name: &str) -> bool {
        tools::hub_tools().iter().any(|t| t["name"] == name)
            || self
                .exposed
                .get()
                .is_some_and(|(routes, _)| routes.iter().any(|r| r.name == name))
    }

    fn call(&self, name: &str, args: &Value) -> Value {
        if let Some(route) = self
            .exposed
            .get()
            .and_then(|(routes, _)| routes.iter().find(|r| r.name == name))
        {
            return match self.client() {
                Ok(client) => match client.call_tool(&route.url, &route.tool, args.clone()) {
                    Ok(result) => tools::remote_result(result),
                    Err(e) => tools::error(e),
                },
                Err(reason) => {
                    tools::error(format!("Apps are unavailable for this agent: {reason}"))
                }
            };
        }
        tools::call(name, args, &self.launch.apps, self.client())
    }
}

/// The agent's signing identity from the harness environment.
fn signer(pubkey: &str) -> Result<remote::Signer, String> {
    let key = std::env::var("BUZZ_PRIVATE_KEY").map_err(|_| "BUZZ_PRIVATE_KEY is not set")?;
    let secret = Secret::parse(key.trim(), pubkey)?;
    let attestation = std::env::var("BUZZ_AUTH_TAG")
        .ok()
        .filter(|tag| !tag.trim().is_empty());
    Ok(remote::Signer {
        secret,
        attestation,
    })
}

fn write(out: &Out, message: &str) {
    let mut out = out.lock().unwrap_or_else(|e| e.into_inner());
    // A closed stdout means the agent is gone; stdin EOF ends the process.
    let _ = writeln!(out, "{message}").and_then(|()| out.flush());
}

/// Requests forwarded to the child, by the id the hub gave them.
#[derive(Default)]
struct Pending {
    next: AtomicU64,
    waiting: Mutex<HashMap<String, (Value, bool)>>,
}

impl Pending {
    /// A fresh child id for a request from the agent; `list` marks `tools/list`.
    fn remap(&self, original: Value, list: bool) -> String {
        let id = format!("hub-{}", self.next.fetch_add(1, Ordering::Relaxed));
        self.lock().insert(id.clone(), (original, list));
        id
    }
    fn take(&self, id: &Value) -> Option<(Value, bool)> {
        id.as_str().and_then(|id| self.lock().remove(id))
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, (Value, bool)>> {
        self.waiting.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Child → agent: answers to remapped requests get their original id back;
/// `tools/list` answers gain the hub's tools. Anything else passes through.
fn child_message(hub: &Hub, pending: &Pending, line: &str) -> String {
    let Ok(mut message) = serde_json::from_str::<Value>(line) else {
        return line.to_owned();
    };
    if message.get("method").is_some() {
        return line.to_owned();
    }
    let Some((original, list)) = pending.take(&message["id"]) else {
        return line.to_owned();
    };
    message["id"] = original;
    if list && message["result"]["nextCursor"].is_null() {
        if let Some(listed) = message["result"]["tools"].as_array_mut() {
            let (_, definitions) = hub.exposed(listed);
            let definitions = definitions.clone();
            listed.extend(tools::hub_tools());
            listed.extend(definitions);
        }
    }
    message.to_string()
}

/// Agent → hub. Returns the line to send to the child, if any.
fn agent_message(hub: &Arc<Hub>, pending: &Pending, out: &Out, line: &str) -> Option<String> {
    let Ok(mut message) = serde_json::from_str::<Value>(line) else {
        return Some(line.to_owned());
    };
    let Some(method) = message["method"].as_str().map(str::to_owned) else {
        // An answer to one of the child's own requests.
        return Some(line.to_owned());
    };
    let Some(id) = message.get("id").cloned() else {
        return Some(line.to_owned());
    };
    if method == "tools/call" {
        let name = message["params"]["name"].as_str().unwrap_or("").to_owned();
        if hub.is_own_tool(&name) {
            let args = message["params"]["arguments"].clone();
            let args = if args.is_null() { json!({}) } else { args };
            let (hub, out) = (Arc::clone(hub), Arc::clone(out));
            // App calls may take seconds; never hold up the child's traffic.
            std::thread::spawn(move || {
                let result = hub.call(&name, &args);
                write(
                    &out,
                    &json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string(),
                );
            });
            return None;
        }
    }
    message["id"] = Value::String(pending.remap(id, method == "tools/list"));
    Some(message.to_string())
}

fn send(child: &mut ChildStdin, line: &str) -> std::io::Result<()> {
    writeln!(child, "{line}").and_then(|()| child.flush())
}

fn run() -> Result<(), String> {
    let launch = apps::read_launch(&std::env::temp_dir())?;
    let mut child = Command::new(&launch.dev_mcp)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Could not start buzz-dev-mcp: {e}"))?;
    let mut child_in = child.stdin.take().ok_or("buzz-dev-mcp has no stdin")?;
    let child_out = child.stdout.take().ok_or("buzz-dev-mcp has no stdout")?;
    let hub = Arc::new(Hub::new(launch));
    let pending = Arc::new(Pending::default());
    let out: Out = Arc::new(Mutex::new(std::io::stdout()));
    let closing = Arc::new(AtomicBool::new(false));
    {
        let (hub, pending, out) = (Arc::clone(&hub), Arc::clone(&pending), Arc::clone(&out));
        let closing = Arc::clone(&closing);
        std::thread::spawn(move || {
            for line in BufReader::new(child_out).lines() {
                let Ok(line) = line else { break };
                write(&out, &child_message(&hub, &pending, &line));
            }
            // After the agent hung up, the child exiting is the normal shutdown.
            if !closing.load(Ordering::SeqCst) {
                // Without its tools the hub is not a usable server; let the agent restart it.
                eprintln!("buzz-mcp-hub: buzz-dev-mcp exited");
                std::process::exit(1);
            }
        });
    }
    for line in std::io::stdin().lock().lines() {
        let line = line.map_err(|_| "Could not read from the agent")?;
        if line.trim().is_empty() {
            continue;
        }
        if let Some(forward) = agent_message(&hub, &pending, &out, &line) {
            if send(&mut child_in, &forward).is_err() {
                break;
            }
        }
    }
    closing.store(true, Ordering::SeqCst);
    drop(child_in);
    let _ = child.wait();
    Ok(())
}

fn main() {
    if let Err(e) = run() {
        eprintln!("buzz-mcp-hub: {e}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_agent_controller::apps::AddedBy;

    const KEY: &str = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";

    fn hub(dir: &std::path::Path) -> Arc<Hub> {
        Arc::new(Hub {
            launch: Launch {
                dev_mcp: dir.join("buzz-dev-mcp"),
                apps: dir.join("apps.json"),
                pubkey: KEY.into(),
            },
            client: Err("no key in tests".into()),
            exposed: OnceLock::new(),
        })
    }

    #[test]
    fn forwards_requests_under_a_fresh_id_and_restores_it() {
        let dir = tempfile::tempdir().unwrap();
        let (hub, pending) = (hub(dir.path()), Pending::default());
        let out: Out = Arc::new(Mutex::new(std::io::stdout()));
        let sent = agent_message(&hub, &pending, &out, r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"shell","arguments":{}}}"#).unwrap();
        let sent: Value = serde_json::from_str(&sent).unwrap();
        assert_eq!(sent["id"], "hub-0");
        assert_eq!(sent["params"]["name"], "shell");
        let back = child_message(
            &hub,
            &pending,
            r#"{"jsonrpc":"2.0","id":"hub-0","result":{"content":[]}}"#,
        );
        assert_eq!(serde_json::from_str::<Value>(&back).unwrap()["id"], 7);
        // Notifications and answers to the child's own requests pass through as-is.
        let note = r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
        assert_eq!(agent_message(&hub, &pending, &out, note).unwrap(), note);
        let answer = r#"{"jsonrpc":"2.0","id":3,"result":{}}"#;
        assert_eq!(agent_message(&hub, &pending, &out, answer).unwrap(), answer);
        assert_eq!(child_message(&hub, &pending, answer), answer);
    }

    #[test]
    fn tools_list_gains_the_hub_tools_on_the_last_page_only() {
        let dir = tempfile::tempdir().unwrap();
        let (hub, pending) = (hub(dir.path()), Pending::default());
        let out: Out = Arc::new(Mutex::new(std::io::stdout()));
        agent_message(
            &hub,
            &pending,
            &out,
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#,
        )
        .unwrap();
        let first = child_message(
            &hub,
            &pending,
            r#"{"jsonrpc":"2.0","id":"hub-0","result":{"tools":[{"name":"shell"}],"nextCursor":"2"}}"#,
        );
        assert_eq!(
            serde_json::from_str::<Value>(&first).unwrap()["result"]["tools"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        agent_message(
            &hub,
            &pending,
            &out,
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"cursor":"2"}}"#,
        )
        .unwrap();
        let last = child_message(
            &hub,
            &pending,
            r#"{"jsonrpc":"2.0","id":"hub-1","result":{"tools":[{"name":"read_file"}]}}"#,
        );
        let last: Value = serde_json::from_str(&last).unwrap();
        let names: Vec<&str> = last["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            [
                "read_file",
                "connect_app",
                "list_apps",
                "call_app_tool",
                "disconnect_app"
            ]
        );
        assert_eq!(last["id"], 2);
    }

    #[test]
    fn hub_tools_are_answered_by_the_hub_not_the_child() {
        let dir = tempfile::tempdir().unwrap();
        let (hub, pending) = (hub(dir.path()), Pending::default());
        apps::add(
            &hub.launch.apps,
            "todo",
            "https://todo.run402.com/mcp",
            AddedBy::Owner,
        )
        .unwrap();
        assert!(hub.is_own_tool("disconnect_app"));
        assert!(!hub.is_own_tool("shell"));
        let out: Out = Arc::new(Mutex::new(std::io::stdout()));
        let forwarded = agent_message(
            &hub,
            &pending,
            &out,
            r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"disconnect_app","arguments":{"name":"todo"}}}"#,
        );
        assert_eq!(forwarded, None);
        assert!(pending.lock().is_empty());
        let result = hub.call("disconnect_app", &json!({"name":"todo"}));
        assert_eq!(result["isError"], false);
    }
}
