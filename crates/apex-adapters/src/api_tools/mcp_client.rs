//! The person's MCP servers, for bots reached through an API.
//!
//! The servers are the ones Claude Code is set up with: user-wide and
//! per-project entries in `~/.claude.json`, and a project's `.mcp.json`
//! only for servers the person has approved there, exactly as Claude Code
//! itself would start them. A server starts the first time a bot uses it
//! and keeps running while the chat is open, so later calls are quick.
//!
//! Local servers (a command, spoken to over its standard input and output)
//! and remote ones (an HTTP address, with any headers the entry gives) are
//! both supported. A remote server that wants an OAuth sign-in is reported
//! as needing one.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use futures::StreamExt;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::oneshot;

use crate::owned_process::{OwnedChild, Registry};

const PROTOCOL: &str = "2025-06-18";
const START_TIMEOUT: Duration = Duration::from_secs(60);
const LIST_TIMEOUT: Duration = Duration::from_secs(30);
/// Characters of a server's error output kept for messages.
const STDERR_KEEP: usize = 4_000;

/// How to reach one server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Transport {
    Stdio { command: String, args: Vec<String>, env: Vec<(String, String)> },
    Http { url: String, headers: Vec<(String, String)> },
    /// Something Deck can't speak to, with why.
    Unsupported(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ServerSpec {
    pub name: String,
    pub transport: Transport,
}

/// `${NAME}` and `${NAME:-fallback}` replaced from the environment, as
/// Claude Code does in its MCP settings.
fn expand(text: &str, lookup: &dyn Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else {
            out.push_str(&rest[start..]);
            return out;
        };
        let inner = &after[..end];
        let (name, fallback) = match inner.split_once(":-") {
            Some((name, fallback)) => (name, Some(fallback)),
            None => (inner, None),
        };
        match lookup(name).filter(|v| !v.is_empty()).or_else(|| fallback.map(str::to_string)) {
            Some(value) => out.push_str(&value),
            None => out.push_str(&rest[start..start + 2 + end + 1]),
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

fn pairs(value: &Value, lookup: &dyn Fn(&str) -> Option<String>) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = value
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), expand(v, lookup))))
        .collect();
    out.sort();
    out
}

fn spec(name: &str, entry: &Value, lookup: &dyn Fn(&str) -> Option<String>) -> ServerSpec {
    let kind = entry["type"].as_str().unwrap_or(if entry["url"].is_string() { "http" } else { "stdio" });
    let transport = match kind {
        "stdio" => match entry["command"].as_str().filter(|c| !c.trim().is_empty()) {
            Some(command) => Transport::Stdio {
                command: expand(command, lookup),
                args: entry["args"].as_array().into_iter().flatten().filter_map(Value::as_str).map(|a| expand(a, lookup)).collect(),
                env: pairs(&entry["env"], lookup),
            },
            None => Transport::Unsupported("its entry has no command".into()),
        },
        "http" | "streamable-http" | "streamableHttp" => match entry["url"].as_str() {
            Some(url) => Transport::Http { url: expand(url, lookup), headers: pairs(&entry["headers"], lookup) },
            None => Transport::Unsupported("its entry has no url".into()),
        },
        "sse" => Transport::Unsupported("it uses the older SSE transport, which Apex Deck's API bots don't speak".into()),
        other => Transport::Unsupported(format!("its type `{other}` isn't known")),
    };
    ServerSpec { name: name.to_string(), transport }
}

/// The servers a chat in `cwd` may use, from Claude Code's settings
/// (`user`, the parsed `~/.claude.json`) and the project's `.mcp.json`.
pub(crate) fn from_config(user: Option<&Value>, project_file: Option<&Value>, cwds: &[String], lookup: &dyn Fn(&str) -> Option<String>) -> Vec<ServerSpec> {
    let mut found: HashMap<String, ServerSpec> = HashMap::new();
    let mut add = |servers: &Value, allowed: &dyn Fn(&str) -> bool| {
        for (name, entry) in servers.as_object().into_iter().flatten() {
            if allowed(name) && entry.is_object() {
                found.insert(name.clone(), spec(name, entry, lookup));
            }
        }
    };
    let project = user.and_then(|u| cwds.iter().find_map(|cwd| u["projects"].get(cwd.as_str()))).cloned().unwrap_or(Value::Null);
    if let Some(user) = user {
        add(&user["mcpServers"], &|_| true);
    }
    // A project's own file can name any command, so only servers the
    // person approved for this project in Claude Code are started.
    if let Some(file) = project_file {
        let all = project["enableAllProjectMcpServers"] == true;
        let listed = |key: &str, name: &str| project[key].as_array().is_some_and(|names| names.iter().any(|n| n == name));
        add(&file["mcpServers"], &|name| (all || listed("enabledMcpjsonServers", name)) && !listed("disabledMcpjsonServers", name));
    }
    add(&project["mcpServers"], &|_| true);
    let mut servers: Vec<ServerSpec> = found.into_values().collect();
    servers.sort_by(|a, b| a.name.cmp(&b.name));
    servers
}

/// Claude Code's settings file.
fn claude_config_path() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir).join(".claude.json"));
    }
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(|home| PathBuf::from(home).join(".claude.json"))
}

fn modified(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// What a server said in answer to a call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CallResult {
    pub text: String,
    pub is_error: bool,
}

/// A tool result's content as text. Pictures and sounds are named, not
/// sent on, since the model gets text back.
pub(crate) fn content_text(result: &Value) -> String {
    let mut parts = Vec::new();
    for item in result["content"].as_array().into_iter().flatten() {
        match item["type"].as_str() {
            Some("text") => parts.push(item["text"].as_str().unwrap_or("").to_string()),
            Some(kind @ ("image" | "audio")) => parts.push(format!(
                "[{kind} ({}, {} bytes) not shown]",
                item["mimeType"].as_str().unwrap_or("unknown type"),
                item["data"].as_str().map_or(0, |d| d.len() * 3 / 4)
            )),
            Some("resource") => {
                let resource = &item["resource"];
                parts.push(match resource["text"].as_str() {
                    Some(text) => text.to_string(),
                    None => format!("[resource {}]", resource["uri"].as_str().unwrap_or("")),
                });
            }
            Some("resource_link") => parts.push(format!("[link {}]", item["uri"].as_str().unwrap_or(""))),
            _ => parts.push(item.to_string()),
        }
    }
    if parts.iter().all(|p| p.trim().is_empty()) {
        if let Some(structured) = result.get("structuredContent").filter(|v| !v.is_null()) {
            return serde_json::to_string_pretty(structured).unwrap_or_default();
        }
    }
    parts.join("\n")
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

struct StdioLink {
    child: Mutex<OwnedChild>,
    stdin: Arc<tokio::sync::Mutex<ChildStdin>>,
    pending: Pending,
    alive: Arc<AtomicBool>,
    stderr: Arc<Mutex<String>>,
}

struct HttpLink {
    client: reqwest::Client,
    url: String,
    headers: Vec<(String, String)>,
    session: Mutex<Option<String>>,
    version: Mutex<Option<String>>,
}

enum Link {
    Stdio(StdioLink),
    Http(HttpLink),
}

/// One running server.
pub(crate) struct Connection {
    pub spec: ServerSpec,
    link: Link,
    next: AtomicU64,
    tools: tokio::sync::Mutex<Option<Vec<Value>>>,
}

async fn write_line(stdin: &tokio::sync::Mutex<ChildStdin>, message: &Value) -> Result<(), String> {
    let mut line = message.to_string();
    line.push('\n');
    let mut stdin = stdin.lock().await;
    stdin.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
    stdin.flush().await.map_err(|e| e.to_string())
}

impl Connection {
    async fn start(spec: &ServerSpec, registry: &Registry, cwd: Option<&Path>, path: Option<&str>) -> Result<Self, String> {
        let link = match &spec.transport {
            Transport::Unsupported(why) => return Err(format!("The MCP server `{}` can't be used: {why}.", spec.name)),
            Transport::Stdio { command, args, env } => {
                let executable_path = env.iter().rev().find(|(key, _)| key.eq_ignore_ascii_case("PATH"))
                    .map(|(_, value)| value.as_str()).or(path);
                let mut cmd = Command::new(crate::executable::program(command, executable_path));
                cmd.args(args);
                if let Some(path) = path {
                    cmd.env("PATH", path);
                }
                cmd.envs(env.iter().map(|(k, v)| (k, v)));
                if let Some(cwd) = cwd.filter(|c| c.is_dir()) {
                    cmd.current_dir(cwd);
                }
                cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
                let mut child = registry.spawn(&mut cmd).map_err(|e| match e.kind() {
                    std::io::ErrorKind::NotFound => format!("The MCP server `{}` couldn't start: `{command}` wasn't found.", spec.name),
                    _ => format!("The MCP server `{}` couldn't start: {e}", spec.name),
                })?;
                let stdin = Arc::new(tokio::sync::Mutex::new(child.stdin.take().ok_or("no stdin")?));
                let stdout = child.stdout.take().ok_or("no stdout")?;
                let pending: Pending = Arc::default();
                let alive = Arc::new(AtomicBool::new(true));
                let stderr = Arc::new(Mutex::new(String::new()));
                if let Some(mut err) = child.stderr.take() {
                    let keep = stderr.clone();
                    tokio::spawn(async move {
                        let mut buffer = [0u8; 4096];
                        while let Ok(n) = err.read(&mut buffer).await {
                            if n == 0 {
                                break;
                            }
                            let mut kept = keep.lock().unwrap();
                            kept.push_str(&String::from_utf8_lossy(&buffer[..n]));
                            if kept.len() > STDERR_KEEP {
                                let mut cut = kept.len() - STDERR_KEEP;
                                while !kept.is_char_boundary(cut) {
                                    cut += 1;
                                }
                                kept.drain(..cut);
                            }
                        }
                    });
                }
                {
                    let (pending, alive, stdin, root) = (pending.clone(), alive.clone(), stdin.clone(), cwd.map(Path::to_path_buf));
                    tokio::spawn(async move {
                        let mut lines = BufReader::new(stdout).lines();
                        while let Ok(Some(line)) = lines.next_line().await {
                            let Ok(message) = serde_json::from_str::<Value>(line.trim()) else { continue };
                            if let Some(method) = message["method"].as_str() {
                                // A request from the server; notifications need no answer.
                                if message.get("id").is_some_and(|id| !id.is_null()) {
                                    let answer = match method {
                                        "ping" => json!({"jsonrpc":"2.0","id":message["id"],"result":{}}),
                                        "roots/list" => json!({"jsonrpc":"2.0","id":message["id"],"result":{"roots": root.iter().map(|r| json!({"uri": format!("file://{}", r.display()), "name": "project"})).collect::<Vec<_>>()}}),
                                        _ => json!({"jsonrpc":"2.0","id":message["id"],"error":{"code":-32601,"message":"Apex Deck doesn't support this request"}}),
                                    };
                                    let _ = write_line(&stdin, &answer).await;
                                }
                                continue;
                            }
                            let Some(id) = message["id"].as_u64() else { continue };
                            let Some(waiter) = pending.lock().unwrap().remove(&id) else { continue };
                            let outcome = match message.get("error").filter(|e| !e.is_null()) {
                                Some(error) => Err(error["message"].as_str().map(str::to_string).unwrap_or_else(|| error.to_string())),
                                None => Ok(message["result"].clone()),
                            };
                            let _ = waiter.send(outcome);
                        }
                        alive.store(false, Ordering::SeqCst);
                        // Everyone still waiting hears the server is gone.
                        pending.lock().unwrap().clear();
                    });
                }
                Link::Stdio(StdioLink { child: Mutex::new(child), stdin, pending, alive, stderr })
            }
            Transport::Http { url, headers } => Link::Http(HttpLink {
                client: reqwest::Client::builder()
                    .connect_timeout(Duration::from_secs(15))
                    .build()
                    .map_err(|e| e.to_string())?,
                url: url.clone(),
                headers: headers.clone(),
                session: Mutex::new(None),
                version: Mutex::new(None),
            }),
        };
        let connection = Connection { spec: spec.clone(), link, next: AtomicU64::new(1), tools: tokio::sync::Mutex::new(None) };
        let init = connection
            .request(
                "initialize",
                json!({"protocolVersion": PROTOCOL, "capabilities": {}, "clientInfo": {"name": "apex-deck", "title": "Apex Deck", "version": env!("CARGO_PKG_VERSION")}}),
                START_TIMEOUT,
            )
            .await?;
        if let Link::Http(http) = &connection.link {
            *http.version.lock().unwrap() = init["protocolVersion"].as_str().map(str::to_string);
        }
        connection.notify("notifications/initialized").await;
        Ok(connection)
    }

    fn alive(&self) -> bool {
        match &self.link {
            Link::Stdio(link) => link.alive.load(Ordering::SeqCst) && link.child.lock().unwrap().try_wait().ok().flatten().is_none(),
            Link::Http(_) => true,
        }
    }

    fn failure(&self, what: &str) -> String {
        let name = &self.spec.name;
        match &self.link {
            Link::Stdio(link) => {
                let said = link.stderr.lock().unwrap().trim().to_string();
                if said.is_empty() {
                    format!("The MCP server `{name}` {what}.")
                } else {
                    format!("The MCP server `{name}` {what}. It said:\n{said}")
                }
            }
            Link::Http(_) => format!("The MCP server `{name}` {what}."),
        }
    }

    async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let message = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        match &self.link {
            Link::Stdio(link) => {
                let (tx, rx) = oneshot::channel();
                link.pending.lock().unwrap().insert(id, tx);
                if write_line(&link.stdin, &message).await.is_err() {
                    link.pending.lock().unwrap().remove(&id);
                    return Err(self.failure("has stopped"));
                }
                match tokio::time::timeout(timeout, rx).await {
                    Ok(Ok(outcome)) => outcome.map_err(|e| format!("The MCP server `{}` answered with an error: {e}", self.spec.name)),
                    Ok(Err(_)) => Err(self.failure("stopped before answering")),
                    Err(_) => {
                        link.pending.lock().unwrap().remove(&id);
                        let _ = write_line(&link.stdin, &json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId": id, "reason": "timed out"}})).await;
                        Err(format!("The MCP server `{}` didn't answer within {} seconds.", self.spec.name, timeout.as_secs()))
                    }
                }
            }
            Link::Http(link) => tokio::time::timeout(timeout, self.http(link, &message, Some(id)))
                .await
                .map_err(|_| format!("The MCP server `{}` didn't answer within {} seconds.", self.spec.name, timeout.as_secs()))?,
        }
    }

    async fn notify(&self, method: &str) {
        let message = json!({"jsonrpc": "2.0", "method": method});
        match &self.link {
            Link::Stdio(link) => {
                let _ = write_line(&link.stdin, &message).await;
            }
            Link::Http(link) => {
                let _ = tokio::time::timeout(Duration::from_secs(15), self.http(link, &message, None)).await;
            }
        }
    }

    async fn http(&self, link: &HttpLink, message: &Value, id: Option<u64>) -> Result<Value, String> {
        let name = &self.spec.name;
        let mut call = link
            .client
            .post(&link.url)
            .header(reqwest::header::ACCEPT, "application/json, text/event-stream")
            .json(message);
        for (key, value) in &link.headers {
            call = call.header(key.as_str(), value.as_str());
        }
        if let Some(session) = link.session.lock().unwrap().clone() {
            call = call.header("Mcp-Session-Id", session);
        }
        if let Some(version) = link.version.lock().unwrap().clone() {
            call = call.header("MCP-Protocol-Version", version);
        }
        let response = call.send().await.map_err(|e| format!("Couldn't reach the MCP server `{name}`: {e}"))?;
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err(format!(
                "The MCP server `{name}` needs a sign-in. API bots can only use remote servers whose entry gives the access token in its headers; a Claude Code bot can use this one."
            ));
        }
        if let Some(session) = response.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()) {
            *link.session.lock().unwrap() = Some(session.to_string());
        }
        let Some(id) = id else { return Ok(Value::Null) };
        if !status.is_success() {
            let body: String = response.text().await.unwrap_or_default().chars().take(300).collect();
            return Err(format!("The MCP server `{name}` returned {status}: {body}"));
        }
        let kind = response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_ascii_lowercase();
        let answer = |message: &Value| -> Option<Result<Value, String>> {
            if message["id"].as_u64() != Some(id) {
                return None;
            }
            Some(match message.get("error").filter(|e| !e.is_null()) {
                Some(error) => Err(format!(
                    "The MCP server `{name}` answered with an error: {}",
                    error["message"].as_str().map(str::to_string).unwrap_or_else(|| error.to_string())
                )),
                None => Ok(message["result"].clone()),
            })
        };
        if kind.contains("text/event-stream") {
            let mut stream = response.bytes_stream();
            let mut buffer = String::new();
            let mut data = String::new();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| format!("The MCP server `{name}` stopped answering: {e}"))?;
                buffer.push_str(&String::from_utf8_lossy(&chunk));
                while let Some(end) = buffer.find('\n') {
                    let line: String = buffer.drain(..=end).collect();
                    let line = line.trim_end_matches(['\r', '\n']);
                    if let Some(more) = line.strip_prefix("data:") {
                        data.push_str(more.trim_start());
                    } else if line.is_empty() && !data.is_empty() {
                        if let Ok(message) = serde_json::from_str::<Value>(&data) {
                            if let Some(result) = answer(&message) {
                                return result;
                            }
                        }
                        data.clear();
                    }
                }
            }
            if let Ok(message) = serde_json::from_str::<Value>(&data) {
                if let Some(result) = answer(&message) {
                    return result;
                }
            }
            Err(format!("The MCP server `{name}` ended its answer without a result."))
        } else {
            let body: Value = response.json().await.map_err(|e| format!("The MCP server `{name}` sent something unreadable: {e}"))?;
            let messages = if body.is_array() { body.as_array().cloned().unwrap_or_default() } else { vec![body] };
            messages.iter().find_map(answer).unwrap_or_else(|| Err(format!("The MCP server `{name}` sent no answer to the request.")))
        }
    }

    /// The server's tools, listed once and then remembered.
    pub async fn tools(&self) -> Result<Vec<Value>, String> {
        let mut cached = self.tools.lock().await;
        if let Some(tools) = cached.as_ref() {
            return Ok(tools.clone());
        }
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..20 {
            let params = match &cursor {
                Some(cursor) => json!({"cursor": cursor}),
                None => json!({}),
            };
            let page = self.request("tools/list", params, LIST_TIMEOUT).await?;
            tools.extend(page["tools"].as_array().cloned().unwrap_or_default());
            cursor = page["nextCursor"].as_str().filter(|c| !c.is_empty()).map(str::to_string);
            if cursor.is_none() {
                break;
            }
        }
        *cached = Some(tools.clone());
        Ok(tools)
    }

    pub async fn call(&self, tool: &str, arguments: Value, timeout: Duration) -> Result<CallResult, String> {
        let result = self.request("tools/call", json!({"name": tool, "arguments": arguments}), timeout).await?;
        Ok(CallResult { text: content_text(&result), is_error: result["isError"] == true })
    }
}

#[derive(Debug, Clone, PartialEq)]
struct Stamp {
    cwds: Vec<String>,
    user: Option<SystemTime>,
    project: Option<SystemTime>,
}

/// The servers of one bot: what its settings name, and the ones started.
#[derive(Default)]
pub(crate) struct Pool {
    live: tokio::sync::Mutex<HashMap<String, Arc<Connection>>>,
    registry: Registry,
    known: Mutex<Option<(Stamp, Vec<ServerSpec>)>>,
}

impl Pool {
    /// The servers a chat in `cwd` may use. Read again only when a
    /// settings file has changed.
    pub fn servers(&self, cwd: Option<&Path>) -> Vec<ServerSpec> {
        let user_path = claude_config_path();
        let project_path = cwd.map(|c| c.join(".mcp.json"));
        let mut cwds: Vec<String> = Vec::new();
        if let Some(cwd) = cwd {
            cwds.push(cwd.to_string_lossy().into_owned());
            if let Ok(real) = cwd.canonicalize() {
                let real = real.to_string_lossy().into_owned();
                if !cwds.contains(&real) {
                    cwds.push(real);
                }
            }
        }
        let stamp = Stamp { cwds: cwds.clone(), user: user_path.as_deref().and_then(modified), project: project_path.as_deref().and_then(modified) };
        let mut known = self.known.lock().unwrap();
        if let Some((seen, servers)) = known.as_ref() {
            if *seen == stamp {
                return servers.clone();
            }
        }
        let user = user_path.as_deref().and_then(read_json);
        let project = project_path.as_deref().and_then(read_json);
        let lookup = |name: &str| std::env::var(name).ok();
        let servers = from_config(user.as_ref(), project.as_ref(), &cwds, &lookup);
        *known = Some((stamp, servers.clone()));
        servers
    }

    /// The running server for `spec`, started if it isn't running.
    pub async fn connect(&self, spec: &ServerSpec, cwd: Option<&Path>, path: Option<&str>) -> Result<Arc<Connection>, String> {
        let mut live = self.live.lock().await;
        if let Some(connection) = live.get(&spec.name) {
            if connection.spec == *spec && connection.alive() {
                return Ok(connection.clone());
            }
        }
        live.remove(&spec.name);
        let connection = Arc::new(Connection::start(spec, &self.registry, cwd, path).await?);
        live.insert(spec.name.clone(), connection.clone());
        Ok(connection)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(name: &str) -> Option<String> {
        match name {
            "TOKEN" => Some("t0k".into()),
            _ => None,
        }
    }

    #[test]
    fn variables_are_filled_in_with_fallbacks() {
        assert_eq!(expand("Bearer ${TOKEN}", &env), "Bearer t0k");
        assert_eq!(expand("${MISSING:-x}/${TOKEN}", &env), "x/t0k");
        assert_eq!(expand("${MISSING}", &env), "${MISSING}");
        assert_eq!(expand("no vars", &env), "no vars");
    }

    #[test]
    fn servers_come_from_user_project_and_approved_project_file_entries() {
        let user = json!({
            "mcpServers": {
                "x-mcp": {"command": "node", "args": ["server.js"], "env": {"KEY": "${TOKEN}"}},
                "shared": {"command": "user-version"}
            },
            "projects": {
                "/work/app": {
                    "mcpServers": {"shared": {"command": "local-version"}},
                    "enabledMcpjsonServers": ["approved"],
                    "disabledMcpjsonServers": ["refused"]
                }
            }
        });
        let file = json!({"mcpServers": {
            "approved": {"type": "http", "url": "https://mcp.example/${TOKEN}", "headers": {"Authorization": "Bearer ${TOKEN}"}},
            "unapproved": {"command": "rm"},
            "refused": {"command": "x"},
            "old": {"type": "sse", "url": "https://old"}
        }});
        let servers = from_config(Some(&user), Some(&file), &["/work/app".into()], &env);
        let names: Vec<&str> = servers.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["approved", "shared", "x-mcp"], "unapproved project servers are never started");
        assert_eq!(servers[0].transport, Transport::Http { url: "https://mcp.example/t0k".into(), headers: vec![("Authorization".into(), "Bearer t0k".into())] });
        assert_eq!(servers[1].transport, Transport::Stdio { command: "local-version".into(), args: vec![], env: vec![] });
        assert_eq!(servers[2].transport, Transport::Stdio { command: "node".into(), args: vec!["server.js".into()], env: vec![("KEY".into(), "t0k".into())] });

        let mut everything = user.clone();
        everything["projects"]["/work/app"]["enableAllProjectMcpServers"] = json!(true);
        let all = from_config(Some(&everything), Some(&file), &["/work/app".into()], &env);
        let names: Vec<&str> = all.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["approved", "old", "shared", "unapproved", "x-mcp"], "refused stays out even when all are enabled");
        assert!(matches!(all[1].transport, Transport::Unsupported(_)));
        assert!(from_config(Some(&user), Some(&file), &["/elsewhere".into()], &env).iter().all(|s| s.name != "approved"));
    }

    #[test]
    fn tool_results_become_text() {
        let result = json!({"content": [
            {"type": "text", "text": "hello"},
            {"type": "image", "mimeType": "image/png", "data": "AAAA"},
            {"type": "resource", "resource": {"uri": "file:///a", "text": "inside"}}
        ]});
        assert_eq!(content_text(&result), "hello\n[image (image/png, 3 bytes) not shown]\ninside");
        assert_eq!(content_text(&json!({"content": [], "structuredContent": {"a": 1}})), "{\n  \"a\": 1\n}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_local_server_is_started_listed_and_called() {
        // A tiny MCP server in shell: it answers by request id.
        let script = r#"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"initialize"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"t","version":"1"}}}\n' "$id" ;;
    *'"tools/list"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"get_weather","description":"Weather","inputSchema":{"type":"object"},"annotations":{"readOnlyHint":true}}]}}\n' "$id" ;;
    *'"tools/call"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"sunny"}]}}\n' "$id" ;;
  esac
done
"#;
        let spec = ServerSpec { name: "weather".into(), transport: Transport::Stdio { command: "sh".into(), args: vec!["-c".into(), script.into()], env: vec![] } };
        let pool = Pool::default();
        let connection = pool.connect(&spec, None, None).await.unwrap();
        let tools = connection.tools().await.unwrap();
        assert_eq!(tools[0]["name"], "get_weather");
        let result = connection.call("get_weather", json!({}), Duration::from_secs(10)).await.unwrap();
        assert_eq!(result, CallResult { text: "sunny".into(), is_error: false });
        let again = pool.connect(&spec, None, None).await.unwrap();
        assert!(Arc::ptr_eq(&connection, &again), "a running server is reused");
    }
}
