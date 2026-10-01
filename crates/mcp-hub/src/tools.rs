//! The hub's own tools and the app tools it exposes beside `buzz-dev-mcp`'s.
//!
//! Apps connected when a session starts appear as first-class tools named
//! `<app>_<tool>`. An app connected mid-session is reachable at once through
//! `call_app_tool`, because a session's tool list is fixed when it starts.
use crate::remote::Client;
use buzz_agent_controller::apps::{self, AddedBy, App};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::Path;

pub const CONNECT: &str = "connect_app";
pub const LIST: &str = "list_apps";
pub const CALL: &str = "call_app_tool";
pub const DISCONNECT: &str = "disconnect_app";
const MAX_NAME: usize = 48;
const MAX_DESCRIPTION: usize = 1000;

/// One app tool exposed under the hub's name for it.
#[derive(Clone, Debug, PartialEq)]
pub struct Exposed {
    pub name: String,
    pub url: String,
    pub tool: String,
}

pub fn hub_tools() -> Vec<Value> {
    let app = json!({ "type": "string", "description": "App name from list_apps" });
    vec![
        json!({
            "name": CONNECT,
            "title": "Connect an app",
            "description": "Connect a run402 app's MCP endpoint (https://<app>.run402.com/... or .run402.app) so you can use its tools. Requests are signed as you, with your owner's attestation, so the app treats you as acting for your owner. After you deploy an app with an MCP endpoint, connect it here. Its tools are callable at once with call_app_tool, and appear as <name>_<tool> tools from your next conversation.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "The app's MCP endpoint URL" },
                    "name": { "type": "string", "description": "Short name: a-z, 0-9, -, at most 24 characters. Defaults to the app's host label." }
                },
                "required": ["url"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": LIST,
            "title": "List connected apps",
            "description": "List the apps you are connected to, each with its tools and their input schemas, or the error that kept them unavailable.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": CALL,
            "title": "Call an app tool",
            "description": "Call one tool of a connected app by app name and tool name (as list_apps shows them).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "app": app,
                    "tool": { "type": "string", "description": "Tool name within the app" },
                    "arguments": { "type": "object", "description": "The tool's arguments" }
                },
                "required": ["app", "tool"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": DISCONNECT,
            "title": "Disconnect an app",
            "description": "Disconnect an app so its tools are no longer offered.",
            "inputSchema": {
                "type": "object",
                "properties": { "name": app },
                "required": ["name"],
                "additionalProperties": false
            },
            "annotations": { "destructiveHint": true, "idempotentHint": true }
        }),
    ]
}

fn valid_tool_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The app's tools as hub tool definitions, skipping names that are invalid or taken.
pub fn expose(app: &App, tools: &[Value], taken: &mut HashSet<String>) -> Vec<(Exposed, Value)> {
    let mut out = Vec::new();
    for tool in tools {
        let Some(remote) = tool["name"].as_str().filter(|n| valid_tool_name(n)) else {
            continue;
        };
        let name = format!("{}_{}", app.name, remote);
        if name.len() > MAX_NAME || !taken.insert(name.clone()) {
            continue;
        }
        let description: String = format!(
            "[{} app] {}",
            app.name,
            tool["description"].as_str().unwrap_or("")
        )
        .chars()
        .take(MAX_DESCRIPTION)
        .collect();
        let schema = match &tool["inputSchema"] {
            schema if schema["type"] == "object" => schema.clone(),
            _ => json!({ "type": "object" }),
        };
        let mut definition =
            json!({ "name": name, "description": description, "inputSchema": schema });
        if tool["annotations"].is_object() {
            definition["annotations"] = tool["annotations"].clone();
        }
        out.push((
            Exposed {
                name,
                url: app.url.clone(),
                tool: remote.to_owned(),
            },
            definition,
        ));
    }
    out
}

pub fn text_result(value: &Value, is_error: bool) -> Value {
    let text = match value {
        Value::String(s) => s.clone(),
        other => serde_json::to_string_pretty(other).unwrap_or_default(),
    };
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

pub fn error(message: impl Into<String>) -> Value {
    text_result(&Value::String(message.into()), true)
}

/// A remote `CallToolResult`, passed through when it has the right shape.
pub fn remote_result(value: Value) -> Value {
    if value["content"].is_array() {
        value
    } else {
        error("The app returned a malformed tool result")
    }
}

/// Each connected app with its tools, or the reason it is unavailable.
pub fn probe_all(client: &Client, apps: &[App]) -> Vec<(App, Result<Vec<Value>, String>)> {
    std::thread::scope(|scope| {
        let handles: Vec<_> = apps
            .iter()
            .map(|app| scope.spawn(move || client.list_tools(&app.url)))
            .collect();
        apps.iter()
            .zip(handles)
            .map(|(app, handle)| {
                let tools = handle
                    .join()
                    .unwrap_or_else(|_| Err("Reading the app's tools failed".into()));
                (app.clone(), tools)
            })
            .collect()
    })
}

fn string_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

fn summary(tools: &[Value]) -> Value {
    Value::Array(
        tools
            .iter()
            .map(|t| json!({ "name": t["name"], "description": t["description"], "inputSchema": t["inputSchema"] }))
            .collect(),
    )
}

/// Run one hub tool. `client` is None when this agent cannot sign app requests.
pub fn call(name: &str, args: &Value, apps_path: &Path, client: Result<&Client, &str>) -> Value {
    if name == DISCONNECT {
        let Some(app) = string_arg(args, "name") else {
            return error("name is required");
        };
        return match apps::remove(apps_path, app) {
            Ok(_) => text_result(&json!({ "disconnected": app }), false),
            Err(e) => error(e),
        };
    }
    let client = match client {
        Ok(client) => client,
        Err(reason) => return error(format!("Apps are unavailable for this agent: {reason}")),
    };
    match name {
        CONNECT => {
            let Some(raw) = string_arg(args, "url") else {
                return error("url is required");
            };
            let url = match apps::validate_url(raw) {
                Ok(url) => url,
                Err(e) => return error(e),
            };
            let app_name =
                string_arg(args, "name").map_or_else(|| apps::default_name(&url), str::to_owned);
            if let Err(e) = apps::validate_name(&app_name) {
                return error(e);
            }
            // Prove the app accepts this agent before saving it.
            let tools = match client.list_tools(&url) {
                Ok(tools) => tools,
                Err(e) => return error(format!("Could not connect to {url}: {e}")),
            };
            match apps::add(apps_path, &app_name, &url, AddedBy::Agent) {
                Ok(_) => text_result(
                    &json!({
                        "connected": { "name": app_name, "url": url },
                        "tools": summary(&tools),
                        "next": format!("Call these now with {CALL} (app \"{app_name}\"). From your next conversation they also appear as {app_name}_<tool>.")
                    }),
                    false,
                ),
                Err(e) => error(e),
            }
        }
        LIST => match apps::read(apps_path) {
            Ok(apps) => {
                let listed: Vec<Value> = probe_all(client, &apps)
                    .into_iter()
                    .map(|(app, tools)| match tools {
                        Ok(tools) => json!({ "name": app.name, "url": app.url, "added_by": app.added_by, "tools": summary(&tools) }),
                        Err(e) => json!({ "name": app.name, "url": app.url, "added_by": app.added_by, "error": e }),
                    })
                    .collect();
                text_result(&json!({ "apps": listed }), false)
            }
            Err(e) => error(e),
        },
        CALL => {
            let (Some(app), Some(tool)) = (string_arg(args, "app"), string_arg(args, "tool"))
            else {
                return error("app and tool are required");
            };
            let arguments = args.get("arguments").cloned().unwrap_or_else(|| json!({}));
            if !arguments.is_object() {
                return error("arguments must be an object");
            }
            let apps = match apps::read(apps_path) {
                Ok(apps) => apps,
                Err(e) => return error(e),
            };
            let Some(found) = apps.iter().find(|a| a.name == app) else {
                return error(format!("No connected app is named {app}; see {LIST}"));
            };
            match client.call_tool(&found.url, tool, arguments) {
                Ok(result) => remote_result(result),
                Err(e) => error(e),
            }
        }
        _ => error(format!("Unknown hub tool {name}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(name: &str) -> App {
        App {
            name: name.into(),
            url: format!("https://{name}.run402.com/api/mcp"),
            added_by: AddedBy::Agent,
        }
    }

    #[test]
    fn exposes_valid_tools_under_the_app_name() {
        let tools = [
            json!({"name":"add_task","description":"Add a task","inputSchema":{"type":"object","properties":{"title":{"type":"string"}}},"annotations":{"idempotentHint":false}}),
            json!({"name":"list tasks","description":"bad name"}),
            json!({"name":"weird_schema","inputSchema":{"type":"string"}}),
            json!({"name": "x".repeat(60)}),
        ];
        let mut taken: HashSet<String> = ["todo_weird_schema".to_string()].into();
        let exposed = expose(&app("todo"), &tools, &mut taken);
        assert_eq!(exposed.len(), 1);
        let (route, definition) = &exposed[0];
        assert_eq!(
            route,
            &Exposed {
                name: "todo_add_task".into(),
                url: "https://todo.run402.com/api/mcp".into(),
                tool: "add_task".into()
            }
        );
        assert_eq!(definition["description"], "[todo app] Add a task");
        assert_eq!(definition["annotations"]["idempotentHint"], false);
        // A second app cannot shadow an exposed name.
        assert!(expose(&app("todo"), &tools[..1], &mut taken).is_empty());
        let fallback = expose(&app("other"), &tools[2..3], &mut HashSet::new());
        assert_eq!(fallback[0].1["inputSchema"], json!({"type":"object"}));
    }

    #[test]
    fn hub_tools_are_valid_and_unique() {
        let tools = hub_tools();
        let names: HashSet<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names.len(), tools.len());
        for tool in &tools {
            assert!(valid_tool_name(tool["name"].as_str().unwrap()));
            assert_eq!(tool["inputSchema"]["type"], "object");
        }
    }

    #[test]
    fn calls_without_signing_keep_working_where_they_can() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("apps.json");
        apps::add(&path, "todo", "https://todo.run402.com/mcp", AddedBy::Owner).unwrap();
        let unavailable = call(
            CALL,
            &json!({"app":"todo","tool":"x"}),
            &path,
            Err("no key"),
        );
        assert_eq!(unavailable["isError"], true);
        assert!(unavailable["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("no key"));
        // Disconnecting never needs the network.
        let out = call(DISCONNECT, &json!({"name":"todo"}), &path, Err("no key"));
        assert_eq!(out["isError"], false);
        assert!(apps::read(&path).unwrap().is_empty());
    }

    #[test]
    fn remote_results_must_have_content() {
        let ok = json!({"content":[{"type":"text","text":"hi"}],"isError":false});
        assert_eq!(remote_result(ok.clone()), ok);
        assert_eq!(remote_result(json!({"text":"hi"}))["isError"], true);
    }
}
