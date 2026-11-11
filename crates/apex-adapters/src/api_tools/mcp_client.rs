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
use super::ToolImage;

const PROTOCOL: &str = "2025-06-18";
const START_TIMEOUT: Duration = Duration::from_secs(60);
const LIST_TIMEOUT: Duration = Duration::from_secs(30);
/// Characters of a server's error output kept for messages.
const STDERR_KEEP: usize = 4_000;

/// How to reach one server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Transport {
    Stdio { command: String, args: Vec<String>, env: Vec<(String, String)> },
    Http { url: String, headers: Vec<(String, String)> },
    /// Something Deck can't speak to, with why.
    Unsupported(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerSpec {
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
        "sse" => Transport::Unsupported("it uses the older SSE transport, which Apex Deck's API agents don't speak".into()),
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
pub struct CallResult {
    pub text: String,
    pub is_error: bool,
    pub images: Vec<ToolImage>,
}

/// The text projection of a tool result. Pictures and sounds keep their
/// existing stubs; validated computer images travel separately.
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

/// Collect only the configured computer server's raster input. Validate the
/// encoded bound before decoding so an oversized payload cannot allocate a
/// second unbounded buffer. Text keeps the existing stubs for all consumers.
fn call_result(result: &Value, computer: bool) -> CallResult {
    use base64::Engine;
    const MAX_BYTES: usize = 5 * 1024 * 1024;
    const MAX_ENCODED: usize = ((MAX_BYTES + 2) / 3) * 4;
    let mut text = content_text(result);
    let mut images = Vec::new();
    if computer {
        for item in result["content"].as_array().into_iter().flatten().filter(|item| item["type"] == "image") {
            let mime = item["mimeType"].as_str().unwrap_or("");
            let data = item["data"].as_str().unwrap_or("");
            let note = if !matches!(mime, "image/png" | "image/jpeg" | "image/webp" | "image/gif") {
                Some("[image omitted: unsupported raster MIME type]")
            } else if data.len() > MAX_ENCODED {
                Some("[image omitted: exceeds 5 MiB limit]")
            } else {
                match base64::engine::general_purpose::STANDARD.decode(data) {
                    Ok(bytes) if bytes.len() > MAX_BYTES => Some("[image omitted: exceeds 5 MiB limit]"),
                    Ok(bytes) if !bytes.is_empty() => {
                        images.push(ToolImage { mime: mime.into(), data: data.into() });
                        None
                    },
                    _ => Some("[image omitted: invalid base64 data]"),
                }
            };
            if let Some(note) = note {
                if !text.is_empty() { text.push('\n'); }
                text.push_str(note);
            }
        }
    }
    CallResult { text, is_error: result["isError"] == true, images }
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
pub struct Connection {
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
    async fn start(
        spec: &ServerSpec,
        registry: &Registry,
        cwd: Option<&Path>,
        path: Option<&str>,
        access: Option<apex_core::Access>,
        data_dir: Option<&Path>,
    ) -> Result<Self, String> {
        let _ = data_dir;
        let link = match &spec.transport {
            Transport::Unsupported(why) => return Err(format!("The MCP server `{}` can't be used: {why}.", spec.name)),
            Transport::Http { url, headers } => {
                if access != Some(apex_core::Access::Full) {
                    return Err("HTTP MCP servers are unavailable below Full access".into());
                }
                Link::Http(HttpLink {
                    client: reqwest::Client::builder()
                        .connect_timeout(Duration::from_secs(15))
                        .build()
                        .map_err(|e| e.to_string())?,
                    url: url.clone(),
                    headers: headers.clone(),
                    session: Mutex::new(None),
                    version: Mutex::new(None),
                })
            }
            Transport::Stdio { command, args, env } => {
                // The bot jail is Linux-only; Windows never takes this branch.
                #[cfg(unix)]
                let jail = access.map(crate::linux_jail::should_jail).unwrap_or(false);
                #[cfg(not(unix))]
                let jail = false;
                let child = if jail {
                    #[cfg(not(unix))]
                    unreachable!("no bot jail on Windows");
                    #[cfg(unix)]
                    let executable_path = env.iter().rev().find(|(key, _)| key.eq_ignore_ascii_case("PATH"))
                        .map(|(_, value)| value.as_str()).or(path);
                    #[cfg(unix)]
                    let bwrap = crate::gateway_sandbox::find_bwrap(executable_path);
                    #[cfg(unix)]
                    match crate::linux_jail::state(bwrap.as_deref()) {
                        crate::linux_jail::JailState::Fails(reason) => {
                            return Err(format!("The MCP server `{}` couldn't start: {reason}", spec.name));
                        }
                        crate::linux_jail::JailState::Works => {}
                    }
                    #[cfg(unix)]
                    let _bwrap = bwrap.ok_or_else(|| {
                        format!("The MCP server `{}` couldn't start: {}: it isn't installed", spec.name, crate::linux_jail::probe::NEEDS_ADMIN)
                    })?;
                    #[cfg(target_os = "linux")]
                    {
                        let cwd_path = cwd.map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("/tmp"));
                        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/tmp"));
                        let data_dir_buf = data_dir.map(Path::to_path_buf).unwrap_or_else(|| home.join(".local/share/apex-deck"));
                        let path_os = executable_path.map(std::ffi::OsString::from).unwrap_or_else(|| std::env::var_os("PATH").unwrap_or_default());
                        let program = crate::executable::program(command, executable_path);
                        let mut jail_spec = crate::linux_jail::build_spec(
                            Path::new(&program),
                            args,
                            &cwd_path,
                            access.unwrap(),
                            None,
                            &home,
                            &data_dir_buf,
                            "mcp",
                            &spec.name,
                            &path_os,
                            &[],
                            &[],
                            &[],
                        ).map_err(|e| format!("The MCP server `{}` couldn't start: {e}", spec.name))?;
                        for (k, v) in env {
                            jail_spec.provider_env.push((k.clone(), v.clone().into()));
                        }
                        let mut jailed = crate::linux_jail::launch::jailed_command(&jail_spec, &_bwrap)
                            .map_err(|e| format!("The MCP server `{}` couldn't start: {e}", spec.name))?;
                        jailed.command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
                        let (child, control) = jailed.spawn(registry)
                            .map_err(|e| format!("The MCP server `{}` couldn't start: {e}", spec.name))?;
                        let net = std::sync::Arc::new(crate::linux_jail::proxy::Internet::default());
                        let purposes = std::sync::Arc::new(crate::linux_jail::DaemonPurposes::new(net));
                        tokio::spawn(crate::linux_jail::channel::serve(control, purposes));
                        child
                    }
                    #[cfg(all(unix, not(target_os = "linux")))]
                    return Err(format!("The MCP server `{}` couldn't start: Linux agent jail is only available on Linux", spec.name));
                } else {
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
                    registry.spawn(&mut cmd).map_err(|e| match e.kind() {
                        std::io::ErrorKind::NotFound => format!("The MCP server `{}` couldn't start: `{command}` wasn't found.", spec.name),
                        _ => format!("The MCP server `{}` couldn't start: {e}", spec.name),
                    })?
                };
                let mut child = child;
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

    pub fn alive(&self) -> bool {
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
                "The MCP server `{name}` needs a sign-in. API agents can only use remote servers whose entry gives the access token in its headers; a Claude Code agent can use this one."
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
        Ok(call_result(&result, crate::mcp::is_computer_server(&self.spec.name)))
    }

    pub async fn clear_cached_tools(&self) {
        *self.tools.lock().await = None;
    }
}

#[derive(Debug, Clone, PartialEq)]
struct Stamp {
    cwds: Vec<String>,
    user: Option<SystemTime>,
    project: Option<SystemTime>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct PoolKey {
    pub bot: String,
    pub server: String,
    pub level: Option<apex_core::Access>,
}

/// The servers of one bot: what its settings name, and the ones started.
#[derive(Default)]
pub struct Pool {
    live: tokio::sync::Mutex<HashMap<PoolKey, Arc<Connection>>>,
    registry: Registry,
    known: Mutex<Option<(Stamp, Vec<ServerSpec>)>>,
    #[cfg(test)]
    fixture_servers: Option<Vec<ServerSpec>>,
}

impl Pool {
    /// The servers a chat in `cwd` may use. Read again only when a
    /// settings file has changed. When access is below Full, HTTP MCP servers
    /// are omitted.
    pub fn servers(&self, cwd: Option<&Path>, access: Option<apex_core::Access>) -> Vec<ServerSpec> {
        #[cfg(test)]
        if let Some(servers) = &self.fixture_servers {
            return servers.iter().filter(|s| access == Some(apex_core::Access::Full) || !matches!(s.transport, Transport::Http { .. })).cloned().collect();
        }
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
        let servers = if let Some((seen, servers)) = known.as_ref() {
            if *seen == stamp {
                servers.clone()
            } else {
                let user = user_path.as_deref().and_then(read_json);
                let project = project_path.as_deref().and_then(read_json);
                // Resolve `${NAME}` from Deck's saved keys first (Keychain or file),
                // then the environment, so a key saved in Settings reaches MCP servers
                // exactly like it reaches HTTP backends.
                let lookup = |name: &str| crate::keys::lookup(name);
                let servers = from_config(user.as_ref(), project.as_ref(), &cwds, &lookup);
                *known = Some((stamp, servers.clone()));
                servers
            }
        } else {
            let user = user_path.as_deref().and_then(read_json);
            let project = project_path.as_deref().and_then(read_json);
            let lookup = |name: &str| crate::keys::lookup(name);
            let servers = from_config(user.as_ref(), project.as_ref(), &cwds, &lookup);
            *known = Some((stamp, servers.clone()));
            servers
        };
        if access != Some(apex_core::Access::Full) {
            servers.into_iter().filter(|s| !matches!(s.transport, Transport::Http { .. })).collect()
        } else {
            servers
        }
    }

    /// The running server for `spec`, started if it isn't running.
    pub async fn connect(
        &self,
        bot: &str,
        spec: &ServerSpec,
        cwd: Option<&Path>,
        path: Option<&str>,
        access: Option<apex_core::Access>,
        data_dir: Option<&Path>,
    ) -> Result<Arc<Connection>, String> {
        let key = PoolKey {
            bot: bot.to_string(),
            server: spec.name.clone(),
            level: access,
        };
        let mut live = self.live.lock().await;
        if let Some(connection) = live.get(&key) {
            if connection.spec == *spec && connection.alive() {
                return Ok(connection.clone());
            }
        }
        live.remove(&key);
        let connection = Arc::new(Connection::start(spec, &self.registry, cwd, path, access, data_dir).await?);
        live.insert(key, connection.clone());
        Ok(connection)
    }

    /// Drop all cached connections and clear their cached tool lists for `bot`.
    pub async fn drop_bot(&self, bot: &str) {
        let mut live = self.live.lock().await;
        let keys: Vec<PoolKey> = live.keys().filter(|k| k.bot == bot).cloned().collect();
        for key in keys {
            if let Some(conn) = live.remove(&key) {
                conn.clear_cached_tools().await;
            }
        }
        *self.known.lock().unwrap() = None;
    }

    /// Drop all connections and clear their cached tool lists.
    pub async fn drop_all(&self) {
        let mut live = self.live.lock().await;
        for (_, conn) in live.drain() {
            conn.clear_cached_tools().await;
        }
        *self.known.lock().unwrap() = None;
    }

    /// Terminate all owned process groups and drop all cached connections.
    pub async fn terminate_all(&self) -> Result<bool, String> {
        let res = self.registry.terminate_all().await;
        self.drop_all().await;
        res
    }
}

/// Fixed configuration for HTTP/stdio boundary tests. Never consult live user
/// settings: a concurrent CLI can rewrite them between fixture creation and use.
#[cfg(test)]
pub(crate) fn fixture_pool(servers: Vec<ServerSpec>) -> Pool {
    Pool { fixture_servers: Some(servers), ..Pool::default() }
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
    fn a_saved_key_reaches_the_spawned_server_when_the_environment_lacks_it() {
        // A key Deck saved (Keychain/file) must expand into a server's env
        // even when the process environment has nothing, like HTTP backends.
        let dir = std::env::temp_dir().join(format!("apx-mcp-keys-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        crate::keys::use_file(&dir);
        crate::keys::save("APEX_MCP_TEST_KEY", "sk-saved").unwrap();

        let config = json!({ "mcpServers": {
            "key-server": { "command": "key-server", "args": ["serve"], "env": { "OPENAI_API_KEY": "${APEX_MCP_TEST_KEY}" } }
        }});
        let servers = from_config(Some(&config), None, &[], &|name: &str| crate::keys::lookup(name));
        let server = servers.iter().find(|s| s.name == "key-server").expect("key-server is configured");
        match &server.transport {
            Transport::Stdio { env: envs, .. } => {
                assert!(envs.contains(&("OPENAI_API_KEY".into(), "sk-saved".into())), "saved key reaches the server: {envs:?}");
            }
            other => panic!("expected stdio transport, got {other:?}"),
        }

        let _ = std::fs::remove_dir_all(&dir);
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
    fn image_blocks_are_kept_with_the_text() {
        let result = call_result(&json!({"content":[
            {"type":"text","text":"snapshot 12"},
            {"type":"image","mimeType":"image/png","data":"AQ=="}
        ]}), true);
        assert_eq!(result.text,"snapshot 12\n[image (image/png, 3 bytes) not shown]");
        assert_eq!(result.images.len(),1);
        assert_eq!(result.images[0].mime,"image/png");
        assert_eq!(result.images[0].data,"AQ==");
        assert!(!format!("{result:?}").contains("AQ=="),"image data must stay out of diagnostics");
        let other = call_result(&json!({"content":[{"type":"image","mimeType":"image/png","data":"AQ=="}]}),false);
        assert!(other.images.is_empty());
    }

    #[test]
    fn oversized_image_is_dropped_with_a_note() {
        use base64::Engine;
        for size in [5 * 1024 * 1024, 5 * 1024 * 1024 + 1, 5 * 1024 * 1024 + 3] {
            let data = base64::engine::general_purpose::STANDARD.encode(vec![0;size]);
            let result = call_result(&json!({"content":[{"type":"image","mimeType":"image/png","data":data}]}),true);
            if size == 5 * 1024 * 1024 { assert_eq!(result.images.len(),1); }
            else { assert!(result.images.is_empty()); assert!(result.text.contains("5 MiB")); }
        }
    }

    #[test]
    fn invalid_mime_and_base64_are_dropped_with_safe_notes() {
        for (mime,data) in [("image/svg+xml","AQ=="),("text/plain","AQ=="),("image/png","INVALID_SECRET"),("image/png","AB==")] {
            let result = call_result(&json!({"content":[{"type":"image","mimeType":mime,"data":data}]}),true);
            assert!(result.images.is_empty());
            assert!(result.text.contains("image omitted"));
            assert!(!result.text.contains("INVALID_SECRET"));
        }
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
        let connection = pool.connect("bot", &spec, None, None, None, None).await.unwrap();
        let tools = connection.tools().await.unwrap();
        assert_eq!(tools[0]["name"], "get_weather");
        let result = connection.call("get_weather", json!({}), Duration::from_secs(10)).await.unwrap();
        assert_eq!(result, CallResult { text: "sunny".into(), is_error: false, images: Vec::new() });
        let again = pool.connect("bot", &spec, None, None, None, None).await.unwrap();
        assert!(Arc::ptr_eq(&connection, &again), "a running server is reused for the same bot and level");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cached_link_not_reused_across_levels_or_after_drop() {
        let script = r#"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"initialize"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"t","version":"1"}}}\n' "$id" ;;
    *'"tools/list"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"test","description":"test","inputSchema":{"type":"object"}}]}}\n' "$id" ;;
  esac
done
"#;
        let spec = ServerSpec { name: "test_server".into(), transport: Transport::Stdio { command: "sh".into(), args: vec!["-c".into(), script.into()], env: vec![] } };
        let pool = Pool::default();

        let full_conn = pool.connect("bot1", &spec, None, None, Some(apex_core::Access::Full), None).await.unwrap();
        let read_conn = pool.connect("bot1", &spec, None, None, Some(apex_core::Access::Read), None).await.unwrap();
        assert!(!Arc::ptr_eq(&full_conn, &read_conn), "different access level must NOT reuse cached link");

        let bot2_conn = pool.connect("bot2", &spec, None, None, Some(apex_core::Access::Full), None).await.unwrap();
        assert!(!Arc::ptr_eq(&full_conn, &bot2_conn), "different bot must NOT reuse cached link");

        pool.drop_bot("bot1").await;
        let after_drop = pool.connect("bot1", &spec, None, None, Some(apex_core::Access::Full), None).await.unwrap();
        assert!(!Arc::ptr_eq(&full_conn, &after_drop), "link must NOT be reused after drop_bot");
    }

    #[test]
    fn api_bots_below_full_get_no_http_mcp_in_servers_list() {
        let user = json!({
            "mcpServers": {
                "local_tool": {"command": "sh", "args": ["-c", "exit 0"]},
                "remote_tool": {"type": "http", "url": "https://mcp.example.com", "headers": {}}
            }
        });
        let pool = Pool::default();
        let user_path = claude_config_path();
        let stamp = Stamp { cwds: vec![], user: user_path.as_deref().and_then(modified), project: None };
        let lookup = |_: &str| None;
        let parsed = from_config(Some(&user), None, &[], &lookup);
        *pool.known.lock().unwrap() = Some((stamp, parsed));

        let full_servers = pool.servers(None, Some(apex_core::Access::Full));
        assert_eq!(full_servers.len(), 2, "Full access gets both Stdio and Http");
        assert!(full_servers.iter().any(|s| matches!(s.transport, Transport::Http { .. })));

        for below_full in [apex_core::Access::Read, apex_core::Access::Ask, apex_core::Access::Edits] {
            let servers = pool.servers(None, Some(below_full));
            assert_eq!(servers.len(), 1, "below-Full access gets no HTTP MCP");
            assert!(!servers.iter().any(|s| matches!(s.transport, Transport::Http { .. })));
            assert_eq!(servers[0].name, "local_tool");
        }

        let none_access = pool.servers(None, None);
        assert_eq!(none_access.len(), 1);
        assert!(!none_access.iter().any(|s| matches!(s.transport, Transport::Http { .. })));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn jailed_mcp_refuses_when_jail_fails_or_http_below_full() {
        let _lock = crate::linux_jail::TEST_LOCK.lock().unwrap();
        crate::linux_jail::set_forced_for_test(true);
        crate::linux_jail::set_state_for_test(Some(crate::linux_jail::JailState::Fails("mcp jail fail".into())));

        let pool = Pool::default();
        let spec = ServerSpec { name: "weather".into(), transport: Transport::Stdio { command: "sh".into(), args: vec![], env: vec![] } };
        let err = match pool.connect("bot", &spec, None, None, Some(apex_core::Access::Read), None).await {
            Err(e) => e,
            Ok(_) => panic!("expected error"),
        };
        assert!(err.contains("The MCP server `weather` couldn't start: mcp jail fail"), "{err}");

        let http = ServerSpec { name: "remote".into(), transport: Transport::Http { url: "http://127.0.0.1:9090".into(), headers: vec![] } };
        let err = match pool.connect("bot", &http, None, None, Some(apex_core::Access::Read), None).await {
            Err(e) => e,
            Ok(_) => panic!("expected error"),
        };
        assert_eq!(err, "HTTP MCP servers are unavailable below Full access");

        crate::linux_jail::set_forced_for_test(false);
        crate::linux_jail::set_state_for_test(None);
    }
}
