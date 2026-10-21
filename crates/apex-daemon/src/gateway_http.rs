// SPDX-License-Identifier: Apache-2.0
//! OpenAI-compatible HTTP gateway (`/v1/models` and `/v1/chat/completions`).
//!
//! Authenticates bearer tokens (`apx_sk_...`) against [`GatewayKeys`], enforces
//! per-key model family scopes (`sub`, `api`, `cli`) and daily/monthly caps, and
//! routes requests through [`apex_adapters::build_without_tools`] in an isolated
//! read-only scratch folder.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use apex_adapters::{build_without_tools, installed_models, list_models, BuildContext, CliParticipant};
use apex_core::{
    Access, AgentTool, Approver, Backend, Decision, ModelChoice, ParticipantConfig,
    ParticipantError, ParticipantId, Progress, ProposedAction, Reply, Role, TurnRequest, ViewTurn,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, mpsc};

use crate::gateway_keys::{AuthError, GatewayKey, GatewayKeys, KeyScope};
use crate::identity;

/// Maximum HTTP request body size (4 MiB).
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
/// Maximum HTTP header block lines.
const MAX_HEADER_LINES: usize = 128;
/// Read timeout for the HTTP request head and body.
const READ_TIMEOUT: Duration = Duration::from_secs(30);

/// Default system prompt when the caller sends no `system` or `developer` message.
pub const DEFAULT_GATEWAY_SYSTEM: &str = "You are a helpful assistant.";

/// Well-known OpenAI-compatible API providers checked against `apex_adapters::keys`.
pub struct KnownApiProvider {
    pub prefix: &'static str,
    pub base_url: &'static str,
    pub key_env: &'static str,
}

pub const KNOWN_API_PROVIDERS: &[KnownApiProvider] = &[
    KnownApiProvider {
        prefix: "openai",
        base_url: "https://api.openai.com/v1",
        key_env: "OPENAI_API_KEY",
    },
    KnownApiProvider {
        prefix: "openrouter",
        base_url: "https://openrouter.ai/api/v1",
        key_env: "OPENROUTER_API_KEY",
    },
    KnownApiProvider {
        prefix: "xai",
        base_url: "https://api.x.ai/v1",
        key_env: "XAI_API_KEY",
    },
    KnownApiProvider {
        prefix: "deepseek",
        base_url: "https://api.deepseek.com/v1",
        key_env: "DEEPSEEK_API_KEY",
    },
    KnownApiProvider {
        prefix: "venice",
        base_url: "https://api.venice.ai/api/v1",
        key_env: "VENICE_API_KEY",
    },
    KnownApiProvider {
        prefix: "groq",
        base_url: "https://api.groq.com/openai/v1",
        key_env: "GROQ_API_KEY",
    },
];

/// Built-in model IDs per subscription CLI (mirrors `src/models.ts`).
/// Used in `/v1/models` after any models reported by `installed_models(tool)`.
pub fn builtin_agent_models(tool: AgentTool) -> &'static [&'static str] {
    match tool {
        AgentTool::ClaudeCode => &[
            "opus",
            "sonnet",
            "haiku",
            "fable",
            "best",
            "opusplan",
            "opus[1m]",
            "sonnet[1m]",
            "claude-fable-5-1",
            "claude-fable-5",
            "claude-opus-5-5",
            "claude-opus-5",
            "claude-opus-4-8",
            "claude-opus-4-7",
            "claude-opus-4-6",
            "claude-sonnet-5-5",
            "claude-sonnet-5",
            "claude-sonnet-4-6",
            "claude-sonnet-4-5",
            "claude-haiku-4-5",
        ],
        AgentTool::Codex => &[
            "gpt-6.1-sol",
            "gpt-6-astra",
            "gpt-6-luna",
            "gpt-5.5",
        ],
        AgentTool::Gemini => &[
            "auto",
            "argon",
            "pro",
            "flash",
            "flash-lite",
            "gemini-4-argon",
            "gemini-4-argon-preview",
            "gemini-3.1-pro-preview",
            "gemini-2.5-pro",
            "gemini-3.8-flash",
            "gemini-3.7-flash",
            "gemini-3.6-flash",
            "gemini-3.5-flash",
            "gemini-3-flash-preview",
            "gemini-2.5-flash",
            "gemini-3.5-flash-lite",
            "gemini-3.1-flash-lite",
        ],
        AgentTool::Grok => &[
            "grok-4.7",
            "grok-4.7-build-fast",
            "grok-4.6",
            "grok-4.5",
        ],
        AgentTool::Muse => &[
            "muse-wonder-1.0",
            "muse-spark-1.3",
            "muse-spark-1.2",
        ],
    }
}

/// Merge `installed_models(tool)` with `builtin_agent_models(tool)` in the exact
/// order `src/models.ts::modelGroups` uses: account-reported models first,
/// followed by built-in fallback IDs not already in the reported set, then `"default"`.
pub fn merged_agent_model_ids(tool: AgentTool, reported: &[ModelChoice]) -> Vec<String> {
    let prefix = tool_prefix(tool);
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    let mut push = |slug: &str| {
        let s = slug.trim();
        if !s.is_empty() && seen.insert(s.to_string()) {
            out.push(format!("{prefix}/{s}"));
        }
    };
    for m in reported {
        push(&m.id);
    }
    for &builtin in builtin_agent_models(tool) {
        push(builtin);
    }
    push("default");
    out
}

pub fn tool_prefix(tool: AgentTool) -> &'static str {
    match tool {
        AgentTool::ClaudeCode => "claude",
        AgentTool::Codex => "codex",
        AgentTool::Gemini => "gemini",
        AgentTool::Grok => "grok",
        AgentTool::Muse => "muse",
    }
}

pub fn parse_agent_prefix(prefix: &str) -> Option<AgentTool> {
    match prefix.trim().to_ascii_lowercase().as_str() {
        "claude" | "claude_code" | "claudecode" => Some(AgentTool::ClaudeCode),
        "codex" => Some(AgentTool::Codex),
        "gemini" | "agy" | "antigravity" => Some(AgentTool::Gemini),
        "grok" => Some(AgentTool::Grok),
        "muse" => Some(AgentTool::Muse),
        _ => None,
    }
}

/// Shared state for the HTTP gateway listener.
pub struct GatewayHttpState {
    pub data_dir: PathBuf,
    pub keys: Arc<GatewayKeys>,
    pub login_path: Option<String>,
}

impl GatewayHttpState {
    pub fn new(data_dir: PathBuf, keys: Arc<GatewayKeys>) -> Arc<Self> {
        let login_path = apex_host::agents::login_path();
        Arc::new(Self {
            data_dir,
            keys,
            login_path,
        })
    }
}

struct CancelOnDrop(tokio::task::AbortHandle);
impl Drop for CancelOnDrop { fn drop(&mut self) { self.0.abort(); } }

/// Accept loop for the HTTP gateway listener.
pub async fn serve(listener: TcpListener, state: Arc<GatewayHttpState>) {
    let mut connections = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            _ = connections.join_next(), if !connections.is_empty() => {},
            accepted = listener.accept() => match accepted {
            Ok((stream, _)) => {
                let state = Arc::clone(&state);
                connections.spawn(async move {
                    let _ = handle_connection(stream, state).await;
                });
            }
            Err(e) => {
                eprintln!("apex-daemon: could not accept a gateway HTTP connection: {e}");
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            }
        }
    }
}

/// One incoming message in an OpenAI `/v1/chat/completions` request.
#[derive(Debug, Clone, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    #[serde(default)]
    pub content: Value,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub tool_call_id: Option<String>,
    #[serde(default)]
    pub tool_calls: Option<Value>,
}

/// Flattened `(system, turns)` plus the rendered prompt for single-prompt CLI backends.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlattenedChat {
    pub system: String,
    pub turns: Vec<ViewTurn>,
    pub prompt: String,
}

/// Extract plain text from an OpenAI message `content` field (string, array of
/// content parts like `{"type":"text","text":"..."}`, or null) and optional
/// assistant `tool_calls`.
pub fn extract_message_text(content: &Value, tool_calls: Option<&Value>) -> String {
    let mut parts: Vec<String> = Vec::new();
    match content {
        Value::String(s) => {
            if !s.trim().is_empty() {
                parts.push(s.trim().to_string());
            }
        }
        Value::Array(items) => {
            for item in items {
                if let Some(s) = item.as_str() {
                    if !s.trim().is_empty() {
                        parts.push(s.trim().to_string());
                    }
                } else if item["type"].as_str() == Some("text")
                    || item["type"].as_str() == Some("input_text")
                {
                    if let Some(t) = item["text"].as_str().filter(|t| !t.trim().is_empty()) {
                        parts.push(t.trim().to_string());
                    }
                }
            }
        }
        _ => {}
    }
    if let Some(Value::Array(calls)) = tool_calls {
        for call in calls {
            let name = call["function"]["name"]
                .as_str()
                .or_else(|| call["name"].as_str())
                .unwrap_or("tool");
            let args = match &call["function"]["arguments"] {
                Value::String(s) => s.clone(),
                Value::Null => String::new(),
                other => other.to_string(),
            };
            let id_suffix = call["id"]
                .as_str()
                .filter(|id| !id.is_empty())
                .map(|id| format!(" ({id})"))
                .unwrap_or_default();
            parts.push(format!("[Tool call{id_suffix}: {name}({args})]"));
        }
    }
    parts.join("\n")
}

/// Deterministically flatten an OpenAI `messages` array into `(system, turns, prompt)`.
///
/// Rules:
/// 1. `system` and `developer` messages are collected in order and joined with
///    `"\n\n"` into `system` (defaulting to [`DEFAULT_GATEWAY_SYSTEM`] if none
///    or all blank).
/// 2. Empty/whitespace-only messages without `tool_calls` are skipped.
/// 3. `user` messages become `Role::User`; `assistant` messages become `Role::Assistant`.
/// 4. `tool` and `function` messages become `Role::User` labeled `[Tool result (id)]: <content>`
///    so both HTTP and CLI participants preserve tool outputs without requiring
///    matching `tool_calls` state on upstream providers.
/// 5. Consecutive turns with the same [`Role`] (including consecutive `assistant`
///    turns or `user` followed by `tool`) are merged with `"\n\n"`.
/// 6. If the first turn is `Role::Assistant`, a leading `Role::User` turn
///    `"(The conversation begins.)"` is prepended (matching `apex_core::render_view`).
/// 7. At least one non-system turn must remain, or `Err` is returned (HTTP 400).
pub fn flatten_openai_messages(messages: &[ChatMessage]) -> Result<FlattenedChat, String> {
    if messages.is_empty() {
        return Err("messages array must not be empty".to_string());
    }
    let mut system_parts: Vec<String> = Vec::new();
    let mut turns: Vec<ViewTurn> = Vec::new();

    for msg in messages {
        let role_raw = msg.role.trim().to_ascii_lowercase();
        let text = extract_message_text(&msg.content, msg.tool_calls.as_ref());
        if text.is_empty() {
            continue;
        }
        match role_raw.as_str() {
            "system" | "developer" => {
                system_parts.push(text);
            }
            "user" => {
                push_or_merge(&mut turns, Role::User, text);
            }
            "assistant" => {
                push_or_merge(&mut turns, Role::Assistant, text);
            }
            "tool" | "function" => {
                let tag = msg
                    .tool_call_id
                    .as_deref()
                    .or(msg.name.as_deref())
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                let formatted = match tag {
                    Some(id) => format!("[Tool result ({id})]: {text}"),
                    None => format!("[Tool result]: {text}"),
                };
                push_or_merge(&mut turns, Role::User, formatted);
            }
            other => {
                return Err(format!(
                    "unsupported message role '{other}' (expected system, developer, user, assistant, or tool)"
                ));
            }
        }
    }

    if turns.is_empty() {
        return Err("messages must include at least one non-empty user, assistant, or tool message".to_string());
    }

    if matches!(turns.first(), Some(first) if first.role == Role::Assistant) {
        turns.insert(
            0,
            ViewTurn {
                role: Role::User,
                content: "(The conversation begins.)".to_string(),
            },
        );
    }

    let system = if system_parts.is_empty() {
        DEFAULT_GATEWAY_SYSTEM.to_string()
    } else {
        system_parts.join("\n\n")
    };
    let prompt = apex_core::render_prompt(&system, &turns);
    Ok(FlattenedChat {
        system,
        turns,
        prompt,
    })
}

fn push_or_merge(turns: &mut Vec<ViewTurn>, role: Role, content: String) {
    match turns.last_mut() {
        Some(last) if last.role == role => {
            last.content.push_str("\n\n");
            last.content.push_str(&content);
        }
        _ => turns.push(ViewTurn { role, content }),
    }
}

/// Client requests never inherit the operator's private tool authority.
struct GatewayApprover;

impl Approver for GatewayApprover {
    fn decide<'life0, 'async_trait>(
        &'life0 self,
        _action: ProposedAction,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Decision> + Send + 'async_trait>>
    where
        'life0: 'async_trait,
        Self: 'async_trait,
    {
        Box::pin(async { Decision::Reject })
    }
}

/// Resolved target backend and scope for a requested `<family>/<model>` ID.
#[derive(Debug, Clone)]
pub struct ResolvedTarget {
    pub canonical_model: String,
    pub scope: KeyScope,
    pub config: ParticipantConfig,
}

/// Resolve a gateway model identifier (`claude/opus`, `openrouter/deepseek/deepseek-r1`,
/// `cli/my-bot`, or `profile/my-bot`) against installed tools, API providers, and saved
/// session profiles.
pub fn resolve_model_target(
    data_dir: &Path,
    raw_model: &str,
    effort: Option<String>,
) -> Result<ResolvedTarget, (u16, String)> {
    let trimmed = raw_model.trim();
    if trimmed.is_empty() {
        return Err((400, "model field cannot be empty".to_string()));
    }
    let (prefix, rest) = match trimmed.split_once('/') {
        Some((p, r)) if !p.trim().is_empty() && !r.trim().is_empty() => (p.trim(), r.trim()),
        _ => {
            return Err((
                400,
                format!(
                    "model '{trimmed}' must use '<family>/<model>' format (e.g. 'claude/opus', 'codex/gpt-6.1-sol', 'openrouter/deepseek/deepseek-r1')"
                ),
            ))
        }
    };

    // 1. Subscription CLIs (`claude/*`, `codex/*`, `gemini/*`, `grok/*`, `muse/*`)
    if let Some(tool) = parse_agent_prefix(prefix) {
        let model_opt = if rest.eq_ignore_ascii_case("default") {
            None
        } else {
            Some(rest.to_string())
        };
        let canonical = format!(
            "{}/{}",
            tool_prefix(tool),
            model_opt.as_deref().unwrap_or("default")
        );
        let config = ParticipantConfig {
            id: ParticipantId::new("gateway"),
            display_name: "Gateway".to_string(),
            backend: Backend::Agent {
                tool,
                model: model_opt,
            },
            persona: String::new(),
            access: Access::Read,
            effort,
            auto_effort: false,
            speed: None,
            appearance: None,
            media: None,
        };
        return Ok(ResolvedTarget {
            canonical_model: canonical,
            scope: KeyScope::Sub,
            config,
        });
    }

    // 2. Known OpenAI-compatible API providers (`openai/*`, `openrouter/*`, `xai/*`, `deepseek/*`, `venice/*`, `groq/*`)
    let lower_prefix = prefix.to_ascii_lowercase();
    if let Some(provider) = KNOWN_API_PROVIDERS
        .iter()
        .find(|p| p.prefix == lower_prefix)
    {
        let config = ParticipantConfig {
            id: ParticipantId::new("gateway"),
            display_name: "Gateway".to_string(),
            backend: Backend::OpenAiCompatible {
                base_url: provider.base_url.to_string(),
                model: rest.to_string(),
                api_key_env: Some(provider.key_env.to_string()),
            },
            persona: String::new(),
            access: Access::Read,
            effort,
            auto_effort: false,
            speed: None,
            appearance: None,
            media: None,
        };
        return Ok(ResolvedTarget {
            canonical_model: format!("{}/{}", provider.prefix, rest),
            scope: KeyScope::Api,
            config,
        });
    }

    // 3. Saved session profiles (`cli/<id>`, `profile/<id>`, `scripted/<id>`, or `<profile_id>/<model>`)
    let profiles = load_saved_profiles(data_dir);
    if matches!(lower_prefix.as_str(), "cli" | "profile" | "scripted") {
        if let Some(mut profile) = profiles.into_iter().find(|p| p.id.as_str() == rest) {
            let scope = match &profile.backend {
                Backend::Agent { .. } => KeyScope::Sub,
                Backend::OpenAiCompatible { .. } => KeyScope::Api,
                Backend::Cli { .. } | Backend::Scripted { .. } => KeyScope::Cli,
            };
            profile.access = Access::Read;
            if effort.is_some() {
                profile.effort = effort;
            }
            return Ok(ResolvedTarget {
                canonical_model: format!("{lower_prefix}/{rest}"),
                scope,
                config: profile,
            });
        }
        return Err((404, format!("saved profile '{rest}' was not found")));
    }

    if let Some(mut profile) = profiles.into_iter().find(|p| p.id.as_str() == prefix) {
        if let Backend::OpenAiCompatible { model, .. } = &mut profile.backend {
            *model = rest.to_string();
            profile.access = Access::Read;
            if effort.is_some() {
                profile.effort = effort;
            }
            return Ok(ResolvedTarget {
                canonical_model: format!("{prefix}/{rest}"),
                scope: KeyScope::Api,
                config: profile,
            });
        }
    }

    Err((
        404,
        format!("unknown model or provider prefix '{prefix}' in '{trimmed}'"),
    ))
}

fn load_saved_profiles(data_dir: &Path) -> Vec<ParticipantConfig> {
    let path = data_dir.join("saved-chats-v1").join("session.json");
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(val) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    val["profiles"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| serde_json::from_value::<ParticipantConfig>(item.clone()).ok())
        .collect()
}

/// Entry in the OpenAI `GET /v1/models` response.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OpenAiModelEntry {
    pub id: String,
    pub object: &'static str,
    pub created: u64,
    pub owned_by: String,
}

/// Installed/configured only; no successful upstream completion is implied.
pub fn provider_readiness(data: &Path) -> Value {
    let agents = apex_host::agents::detect();
    let mut rows = Vec::new();
    for (tool, key) in [(AgentTool::ClaudeCode, "claude"), (AgentTool::Codex, "codex"), (AgentTool::Gemini, "gemini"), (AgentTool::Grok, "grok"), (AgentTool::Muse, "muse")] {
        let backend = Backend::Agent { tool, model: None };
        let isolation = gateway_isolation_error(&backend);
        let installed = if tool == AgentTool::Gemini {
            let path = apex_host::agents::login_path().unwrap_or_default();
            std::env::split_paths(&path).any(|p| p.join("gemini").is_file())
        } else { agents.iter().any(|a| a.key == key && a.found) };
        rows.push(json!({ "id": key, "name": key, "kind": "Subscription CLI", "available": installed && isolation.is_none(),
            "detail": isolation.unwrap_or_else(|| if installed { "Installed; login and completion not checked.".into() } else { "Not installed.".into() }) }));
    }
    for p in KNOWN_API_PROVIDERS {
        let configured = apex_adapters::keys::lookup(p.key_env).is_some();
        rows.push(json!({ "id": p.prefix, "name": p.prefix, "kind": "API provider", "available": configured,
            "detail": if configured { "API key configured; connection not checked." } else { "No API key configured." } }));
    }
    for p in load_saved_profiles(data) {
        let isolation = gateway_isolation_error(&p.backend);
        rows.push(json!({ "id": p.id.as_str(), "name": p.display_name, "kind": "Saved profile", "available": isolation.is_none(),
            "detail": isolation.unwrap_or_else(|| "Configured; completion not checked.".into()) }));
    }
    json!({ "providers": rows })
}

/// Build the `GET /v1/models` catalog filtered by `key.scopes`.
pub async fn build_models_catalog(state: &GatewayHttpState, key: &GatewayKey) -> Vec<OpenAiModelEntry> {
    let mut entries: Vec<OpenAiModelEntry> = Vec::new();
    let mut seen = BTreeSet::new();
    let mut push = |id: String, owned_by: &str| {
        if seen.insert(id.clone()) {
            entries.push(OpenAiModelEntry {
                id,
                object: "model",
                created: 0,
                owned_by: owned_by.to_string(),
            });
        }
    };

    // 1. Subscription CLIs (`KeyScope::Sub`)
    if key.has_scope(KeyScope::Sub) {
        let detected = tokio::task::spawn_blocking(apex_host::agents::detect)
            .await
            .unwrap_or_default();
        let is_found = |detect_key: &str| {
            detected
                .iter()
                .any(|a| a.key == detect_key && a.found)
        };
        let tools = [
            (AgentTool::ClaudeCode, "claude"),
            (AgentTool::Codex, "codex"),
            (AgentTool::Gemini, "gemini"),
            (AgentTool::Grok, "grok"),
            (AgentTool::Muse, "muse"),
        ];
        for (tool, detect_key) in tools {
            if gateway_isolation_error(&Backend::Agent { tool, model: None }).is_some() { continue; }
            // Gemini gateway requests use the standalone Google CLI, never
            // Antigravity's already-running service with its own MCP config.
            if tool == AgentTool::Gemini {
                let path = state.login_path.clone().unwrap_or_else(|| std::env::var("PATH").unwrap_or_default());
                if !std::env::split_paths(&path).any(|p| p.join("gemini").is_file()) { continue; }
            }
            let reported = installed_models(tool);
            if is_found(detect_key) || !reported.is_empty() {
                let owner = tool_prefix(tool);
                for id in merged_agent_model_ids(tool, &reported) {
                    push(id, owner);
                }
            }
        }
    }

    // 2. OpenAI-compatible API providers (`KeyScope::Api`)
    if key.has_scope(KeyScope::Api) {
        for provider in KNOWN_API_PROVIDERS {
            if apex_adapters::keys::lookup(provider.key_env).is_some() {
                if let Ok(models) = list_models(provider.base_url, Some(provider.key_env)).await {
                    for m in models {
                        push(format!("{}/{}", provider.prefix, m.id), provider.prefix);
                    }
                }
            }
        }
        for profile in load_saved_profiles(&state.data_dir) {
            if let Backend::OpenAiCompatible { model, .. } = &profile.backend {
                if !model.trim().is_empty() {
                    push(
                        format!("{}/{}", profile.id.as_str(), model.trim()),
                        profile.id.as_str(),
                    );
                }
            }
        }
    }

    // 3. Saved custom CLI / Scripted profiles (`KeyScope::Cli`)
    if key.has_scope(KeyScope::Cli) {
        for profile in load_saved_profiles(&state.data_dir) {
            match &profile.backend {
                Backend::Cli { .. } if gateway_isolation_error(&profile.backend).is_none() => {
                    push(format!("cli/{}", profile.id.as_str()), "cli");
                }
                Backend::Cli { .. } => {}
                Backend::Scripted { .. } => {
                    push(format!("scripted/{}", profile.id.as_str()), "scripted");
                }
                _ => {}
            }
        }
    }

    entries
}

/// Ephemeral scratch folder deleted automatically when the request ends.
struct ScratchDir(PathBuf);

impl ScratchDir {
    fn new() -> Result<Self, String> {
        static N: AtomicU64 = AtomicU64::new(0);
        let seq = N.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "apex-gateway-scratch-{}-{seq}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("could not create gateway scratch folder: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        }
        Ok(Self(dir))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[derive(Deserialize)]
struct ChatCompletionRequest {
    model: String,
    messages: Vec<ChatMessage>,
    #[serde(default)]
    stream: bool,
    #[serde(default)]
    reasoning_effort: Option<String>,
    #[serde(default)]
    effort: Option<String>,
}

struct ParsedHttpRequest {
    method: String,
    path: String,
    authorization: Option<String>,
    body: Vec<u8>,
}

async fn read_http_request(stream: &mut TcpStream) -> Result<Option<ParsedHttpRequest>, (u16, String)> {
    let mut reader = BufReader::new(stream);
    let mut request_line = String::new();
    let n = tokio::time::timeout(READ_TIMEOUT, reader.read_line(&mut request_line))
        .await
        .map_err(|_| (408, "request timed out".to_string()))?
        .map_err(|e| (400, format!("failed to read request line: {e}")))?;
    if n == 0 {
        return Ok(None);
    }
    let parts: Vec<&str> = request_line.trim_end_matches(&['\r', '\n'][..]).split_whitespace().collect();
    if parts.len() < 2 {
        return Err((400, "malformed HTTP request line".to_string()));
    }
    let method = parts[0].to_ascii_uppercase();
    let raw_target = parts[1];
    let path = raw_target.split('?').next().unwrap_or(raw_target).to_string();

    let mut content_length: usize = 0;
    let mut authorization: Option<String> = None;

    for _ in 0..MAX_HEADER_LINES {
        let mut line = String::new();
        let read = tokio::time::timeout(READ_TIMEOUT, reader.read_line(&mut line))
            .await
            .map_err(|_| (408, "header read timed out".to_string()))?
            .map_err(|e| (400, format!("failed to read header: {e}")))?;
        if read == 0 {
            return Err((400, "unexpected EOF in HTTP headers".to_string()));
        }
        let trimmed = line.trim_end_matches(&['\r', '\n'][..]);
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, val)) = trimmed.split_once(':') {
            let name_lower = name.trim().to_ascii_lowercase();
            let val_trimmed = val.trim();
            if name_lower == "content-length" {
                content_length = val_trimmed
                    .parse::<usize>()
                    .map_err(|_| (400, "invalid Content-Length header".to_string()))?;
                if content_length > MAX_BODY_BYTES {
                    return Err((413, format!("request body exceeds {MAX_BODY_BYTES} bytes")));
                }
            } else if name_lower == "authorization" {
                authorization = Some(val_trimmed.to_string());
            }
        }
    }

    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        tokio::time::timeout(READ_TIMEOUT, reader.read_exact(&mut body))
            .await
            .map_err(|_| (408, "request body timed out".to_string()))?
            .map_err(|e| (400, format!("failed to read request body: {e}")))?;
    }

    Ok(Some(ParsedHttpRequest {
        method,
        path,
        authorization,
        body,
    }))
}

fn extract_bearer_token(header: Option<&str>) -> Result<&str, AuthError> {
    let Some(raw) = header else {
        return Err(AuthError::MissingBearer);
    };
    let mut parts = raw.splitn(2, char::is_whitespace);
    let scheme = parts.next().unwrap_or("");
    let token = parts.next().map(str::trim).unwrap_or("");
    if !scheme.eq_ignore_ascii_case("bearer") || token.is_empty() {
        return Err(AuthError::MissingBearer);
    }
    Ok(token)
}

fn status_reason(code: u16) -> &'static str {
    match code {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        _ => "Error",
    }
}

async fn write_json_response(stream: &mut TcpStream, status: u16, body: &Value) {
    let payload = serde_json::to_vec(body).unwrap_or_else(|_| b"{}".to_vec());
    let header = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Authorization, Content-Type\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        status_reason(status),
        payload.len()
    );
    let _ = stream.write_all(header.as_bytes()).await;
    let _ = stream.write_all(&payload).await;
    let _ = stream.flush().await;
}

async fn write_openai_error(stream: &mut TcpStream, status: u16, error_type: &str, message: &str) {
    let body = json!({
        "error": {
            "message": message,
            "type": error_type,
            "param": Value::Null,
            "code": Value::Null,
        }
    });
    write_json_response(stream, status, &body).await;
}

async fn write_auth_error(stream: &mut TcpStream, err: AuthError) {
    write_openai_error(stream, err.status_code(), err.error_type(), &err.message()).await;
}

async fn handle_connection(mut stream: TcpStream, state: Arc<GatewayHttpState>) -> Result<(), ()> {
    let req = match read_http_request(&mut stream).await {
        Ok(Some(req)) => req,
        Ok(None) => return Ok(()),
        Err((status, msg)) => {
            write_openai_error(&mut stream, status, "invalid_request_error", &msg).await;
            return Ok(());
        }
    };

    if req.method == "OPTIONS" {
        let header = "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Authorization, Content-Type\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        let _ = stream.write_all(header.as_bytes()).await;
        let _ = stream.flush().await;
        return Ok(());
    }

    let token = match extract_bearer_token(req.authorization.as_deref()) {
        Ok(t) => t,
        Err(err) => {
            write_auth_error(&mut stream, err).await;
            return Ok(());
        }
    };

    let authed_key = match state.keys.authenticate(token) {
        Ok(k) => k,
        Err(err) => {
            write_auth_error(&mut stream, err).await;
            return Ok(());
        }
    };

    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/v1/models" | "/models") => {
            let data = build_models_catalog(&state, &authed_key).await;
            let body = json!({
                "object": "list",
                "data": data,
            });
            write_json_response(&mut stream, 200, &body).await;
        }
        ("POST", "/v1/chat/completions" | "/chat/completions") => {
            handle_chat_completions(&mut stream, &state, &authed_key, &req.body).await;
        }
        (method, "/v1/models" | "/models" | "/v1/chat/completions" | "/chat/completions") => {
            write_openai_error(
                &mut stream,
                405,
                "invalid_request_error",
                &format!("Method {method} not allowed for {}", req.path),
            )
            .await;
        }
        _ => {
            write_openai_error(
                &mut stream,
                404,
                "invalid_request_error",
                &format!("Unknown endpoint {}", req.path),
            )
            .await;
        }
    }

    Ok(())
}

/// Only backends with a verified way to withhold host MCP configuration
/// may serve clients. No guessed config paths or per-key bypasses.
pub(crate) fn gateway_isolation_error(backend: &Backend) -> Option<String> {
    match backend {
        Backend::Agent { tool: AgentTool::ClaudeCode | AgentTool::Codex, .. }
        | Backend::OpenAiCompatible { .. }
        | Backend::Scripted { .. } => None,
        Backend::Agent { tool: AgentTool::Gemini | AgentTool::Grok | AgentTool::Muse, .. }
        | Backend::Cli { .. } if cfg!(target_os = "macos") => None,
        _ => Some("This backend has no verified MCP isolation and is unavailable to gateway clients. Private MCP tools are never shared.".into()),
    }
}

async fn handle_chat_completions(
    stream: &mut TcpStream,
    state: &Arc<GatewayHttpState>,
    authed_key: &GatewayKey,
    raw_body: &[u8],
) {
    // Validate JSON, messages, and model target BEFORE calling `reserve_turn`,
    // so malformed 400/404 requests never touch the quota counter.
    let parsed: ChatCompletionRequest = match serde_json::from_slice(raw_body) {
        Ok(p) => p,
        Err(e) => {
            write_openai_error(
                stream,
                400,
                "invalid_request_error",
                &format!("Invalid JSON body: {e}"),
            )
            .await;
            return;
        }
    };

    let flattened = match flatten_openai_messages(&parsed.messages) {
        Ok(f) => f,
        Err(why) => {
            write_openai_error(stream, 400, "invalid_request_error", &why).await;
            return;
        }
    };

    let effort = parsed
        .reasoning_effort
        .or(parsed.effort)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let resolved = match resolve_model_target(&state.data_dir, &parsed.model, effort.clone()) {
        Ok(r) => r,
        Err((status, why)) => {
            write_openai_error(stream, status, "invalid_request_error", &why).await;
            return;
        }
    };

    if let Some(why) = gateway_isolation_error(&resolved.config.backend) {
        write_openai_error(stream, 409, "invalid_request_error", &why).await;
        return;
    }

    // Reserve 1 turn against the key's scope and daily/monthly caps.
    let reserved_key = match state.keys.reserve_turn(&authed_key.id, resolved.scope) {
        Ok(k) => k,
        Err(err) => {
            write_auth_error(stream, err).await;
            return;
        }
    };

    let scratch = match ScratchDir::new() {
        Ok(s) => s,
        Err(why) => {
            state.keys.release_turn(&reserved_key.id);
            write_openai_error(stream, 500, "server_error", &why).await;
            return;
        }
    };

    let context = BuildContext {
        codex_hook: None,
        cwd: Some(scratch.path().to_path_buf()),
        path: state.login_path.clone(),
        temp: Some(scratch.path().to_path_buf()),
        process_registry: None,
        cargo_target_dir: None,
        media_dir: None,
        attachment_roots: Vec::new(),
        phone: None,
    };

    // Ignore legacy allow_mcp fields, including on already-issued keys.
    let participant: Arc<dyn apex_core::Participant> = match &resolved.config.backend {
        Backend::Agent { .. } | Backend::Cli { .. } => Arc::new(
            CliParticipant::new(resolved.config.clone())
                .with_context(&context)
                .with_mcp_disabled(),
        ),
        _ => build_without_tools(resolved.config.clone(), &context),
    };

    let turn_request = TurnRequest {
        access: Some(Access::Read),
        effort_override: effort,
        system: flattened.system,
        turns: flattened.turns,
        unseen: Vec::new(),
        plan: false,
    };

    let completion_id = format!("chatcmpl-{}", identity::random_hex(12));
    let created = now_unix();
    let model_name = resolved.canonical_model.clone();
    let key_id = reserved_key.id.clone();
    let mut revoke_rx = state.keys.subscribe_revocations();
    // A broadcast receiver whose senders are gone yields an error *immediately*
    // on every poll. Without these guards `select!` would spin at 100% CPU and
    // never reach the branch that ends the request.
    let mut revoke_open = true;

    if !parsed.stream {
        let approver = GatewayApprover;
        let run_fut = participant.respond_with_approvals(turn_request, &|_| {}, &approver);
        tokio::pin!(run_fut);

        let result: Result<Reply, Result<ParticipantError, &'static str>> = loop {
            tokio::select! {
                res = &mut run_fut => break res.map_err(Ok),
                rev = revoke_rx.recv(), if revoke_open => match rev {
                    Ok(id) if id == key_id => {
                        let _ = participant.cancel_active_turn().await;
                        break Err(Err("revoked"));
                    }
                    // `Lagged` means we may have missed our own id: ask the
                    // store, which is the authority on whether we still exist.
                    Err(broadcast::error::RecvError::Lagged(_)) if !state.keys.is_active(&key_id) => {
                        let _ = participant.cancel_active_turn().await;
                        break Err(Err("revoked"));
                    }
                    Err(broadcast::error::RecvError::Closed) => revoke_open = false,
                    Ok(_) | Err(_) => {}
                }
            }
        };

        match result {
            Ok(reply) => {
                if let Some(cost) = reply.cost_micros {
                    state.keys.record_spend(&key_id, cost);
                }
                let input_tokens = reply.input_tokens.unwrap_or(0);
                let output_tokens = reply.output_tokens.unwrap_or(0);
                let body = json!({
                    "id": completion_id,
                    "object": "chat.completion",
                    "created": created,
                    "model": model_name,
                    "choices": [{
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": reply.text,
                        },
                        "finish_reason": "stop",
                    }],
                    "usage": {
                        "prompt_tokens": input_tokens,
                        "completion_tokens": output_tokens,
                        "total_tokens": input_tokens.saturating_add(output_tokens),
                    }
                });
                write_json_response(stream, 200, &body).await;
            }
            Err(Err("revoked")) => {
                state.keys.release_turn(&key_id);
                write_auth_error(stream, AuthError::Revoked).await;
            }
            Err(Ok(err)) => {
                state.keys.release_turn(&key_id);
                let status = match err {
                    ParticipantError::NotConfigured(_) => 404,
                    _ => 502,
                };
                write_openai_error(stream, status, "upstream_error", &err.to_string()).await;
            }
            Err(Err(_)) => {
                state.keys.release_turn(&key_id);
            }
        }
        return;
    }

    // Streaming (`stream: true`) SSE response.
    let sse_header = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n\r\n";
    if stream.write_all(sse_header.as_bytes()).await.is_err() {
        state.keys.release_turn(&key_id);
        return;
    }
    let initial_chunk = json!({
        "id": completion_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model_name,
        "choices": [{
            "index": 0,
            "delta": { "role": "assistant" },
            "finish_reason": Value::Null,
        }]
    });
    if write_sse_data(stream, &initial_chunk.to_string()).await.is_err() {
        state.keys.release_turn(&key_id);
        return;
    }

    let (delta_tx, mut delta_rx) = mpsc::unbounded_channel::<String>();
    let participant_run = Arc::clone(&participant);
    let mut handle = tokio::spawn(async move {
        let approver = GatewayApprover;
        participant_run
            .respond_with_approvals(
                turn_request,
                &|update| {
                    if let Progress::Text(text) = update {
                        if !text.is_empty() {
                            let _ = delta_tx.send(text.to_string());
                        }
                    }
                },
                &approver,
            )
            .await
    });

    let mut streamed_any = false;
    let mut disconnected = false;
    let mut revoked = false;
    let mut outcome: Option<Result<Reply, ParticipantError>> = None;
    // `delta_rx.recv()` returns `None` for ever once the participant task drops
    // its sender. Under `biased` that ready-immediately branch would win every
    // poll, starving the join branch below: the response never ended and the
    // client blocked on EOF. Turn the branch off instead of re-polling it.
    let _cancel_on_drop = CancelOnDrop(handle.abort_handle());
    let mut deltas_open = true;

    loop {
        tokio::select! {
             biased;
            rev = revoke_rx.recv(), if revoke_open => match rev {
                Ok(id) if id == key_id => {
                    revoked = true;
                    handle.abort();
                    let _ = participant.cancel_active_turn().await;
                    break;
                }
                Err(broadcast::error::RecvError::Lagged(_)) if !state.keys.is_active(&key_id) => {
                    revoked = true;
                    handle.abort();
                    let _ = participant.cancel_active_turn().await;
                    break;
                }
                Err(broadcast::error::RecvError::Closed) => revoke_open = false,
                Ok(_) | Err(_) => {}
            },
            maybe_delta = delta_rx.recv(), if deltas_open => {
                let Some(text) = maybe_delta else {
                    deltas_open = false;
                    continue;
                };
                streamed_any = true;
                let chunk = json!({
                    "id": completion_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model_name,
                    "choices": [{
                        "index": 0,
                        "delta": { "content": text },
                        "finish_reason": Value::Null,
                    }]
                });
                if write_sse_data(stream, &chunk.to_string()).await.is_err() {
                    disconnected = true;
                    handle.abort();
                    let _ = participant.cancel_active_turn().await;
                    break;
                }
            }
            joined = &mut handle => {
                // Drain any remaining deltas buffered before the task completed.
                while let Ok(text) = delta_rx.try_recv() {
                    streamed_any = true;
                    let chunk = json!({
                        "id": completion_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": model_name,
                        "choices": [{
                            "index": 0,
                            "delta": { "content": text },
                            "finish_reason": Value::Null,
                        }]
                    });
                    if write_sse_data(stream, &chunk.to_string()).await.is_err() {
                        disconnected = true;
                        break;
                    }
                }
                if let Ok(res) = joined {
                    outcome = Some(res);
                }
                break;
            }
        }
    }

    if revoked || (disconnected && !streamed_any) {
        state.keys.release_turn(&key_id);
        return;
    }

    match outcome {
        Some(Ok(reply)) => {
            if let Some(cost) = reply.cost_micros {
                state.keys.record_spend(&key_id, cost);
            }
            if !streamed_any && !reply.text.is_empty() {
                let chunk = json!({
                    "id": completion_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model_name,
                    "choices": [{
                        "index": 0,
                        "delta": { "content": reply.text },
                        "finish_reason": Value::Null,
                    }]
                });
                let _ = write_sse_data(stream, &chunk.to_string()).await;
            }
            let input_tokens = reply.input_tokens.unwrap_or(0);
            let output_tokens = reply.output_tokens.unwrap_or(0);
            let stop_chunk = json!({
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model_name,
                "choices": [{
                    "index": 0,
                    "delta": {},
                    "finish_reason": "stop",
                }],
                "usage": {
                    "prompt_tokens": input_tokens,
                    "completion_tokens": output_tokens,
                    "total_tokens": input_tokens.saturating_add(output_tokens),
                }
            });
            let _ = write_sse_data(stream, &stop_chunk.to_string()).await;
            let _ = write_sse_data(stream, "[DONE]").await;
        }
        Some(Err(err)) => {
            if !streamed_any {
                state.keys.release_turn(&key_id);
            }
            let err_chunk = json!({
                "error": {
                    "message": err.to_string(),
                    "type": "upstream_error",
                }
            });
            let _ = write_sse_data(stream, &err_chunk.to_string()).await;
            let _ = write_sse_data(stream, "[DONE]").await;
        }
        None => {
            if !streamed_any {
                state.keys.release_turn(&key_id);
            }
        }
    }
}

async fn write_sse_data(stream: &mut TcpStream, data: &str) -> std::io::Result<()> {
    let frame = format!("data: {data}\n\n");
    stream.write_all(frame.as_bytes()).await?;
    stream.flush().await
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    /// Exercise an actual HTTP listener with a pre-policy key file and a CLI
    /// fixture that deliberately ignores the MCP-disable overrides. No live
    /// account or private MCP server is contacted by this test.
    #[cfg(unix)]
    #[tokio::test]
    async fn stopping_listener_closes_accepted_connections() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let dir = std::env::temp_dir().join(format!("apex-gateway-stop-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let keys = Arc::new(GatewayKeys::load(&dir).unwrap());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(serve(listener, GatewayHttpState::new(dir.clone(), keys)));
        let mut client = TcpStream::connect(address).await.unwrap();
        client.write_all(b"GET /v1/models HTTP/1.1\r\n").await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        server.abort(); let _ = server.await;
        let mut bytes = Vec::new();
        tokio::time::timeout(Duration::from_secs(2), client.read_to_end(&mut bytes)).await.expect("accepted sockets close with listener").unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn legacy_allow_mcp_key_cannot_reach_private_servers_over_http() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("gateway-legacy-mcp-{}", identity::random_hex(8)));
        std::fs::create_dir_all(&dir).unwrap();
        let keys = GatewayKeys::load(&dir).unwrap();
        let issued = keys.issue(IssueSpec {
            label: "legacy-allow-mcp".into(), scopes: KeyScope::all_scopes(),
            allow_mcp: false, max_turns_per_day: None, max_usd_micros_per_month: None,
        }).unwrap();
        let key_path = dir.join(crate::gateway_keys::FILE);
        let mut stored: Value = serde_json::from_slice(&std::fs::read(&key_path).unwrap()).unwrap();
        stored["keys"][0]["allow_mcp"] = json!(true);
        std::fs::write(&key_path, serde_json::to_vec(&stored).unwrap()).unwrap();
        drop(keys);
        let keys = Arc::new(GatewayKeys::load(&dir).unwrap());
        assert!(!keys.authenticate(&issued.token).unwrap().allow_mcp);

        // Advertise private servers even after receiving disable flags: the
        // running-server inventory must refuse the turn before thread/start.
        let fixture = dir.join("codex");
        std::fs::write(&fixture, r##"#!/bin/sh
root=$(/usr/bin/dirname "$0")
printf '%s\n' "$@" >> "$root/args.log"
case "$*" in
  *"mcp list --json"*)
    echo '[{"name":"x_mcp"},{"name":"hl_mcp"}]'
    exit 0 ;;
esac
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$root/requests.log"
  case "$line" in
    *'"method":"initialize"'*) echo '{"id":0,"result":{}}' ;;
    *'"method":"plugin/list"'*) echo '{"id":110,"result":{"marketplaces":[]}}' ;;
    *'"method":"mcpServerStatus/list"'*)
      echo '{"id":10,"result":{"data":[{"name":"x_mcp","tools":{"post":{"name":"post"}},"resources":[],"resourceTemplates":[]},{"name":"hl_mcp","tools":{"trade":{"name":"trade"}},"resources":[],"resourceTemplates":[]}],"nextCursor":null}}' ;;
    *'"method":"thread/start"'*|*'"method":"turn/start"'*) exit 42 ;;
  esac
done
"##).unwrap();
        std::fs::set_permissions(&fixture, std::fs::Permissions::from_mode(0o700)).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let state = Arc::new(GatewayHttpState {
            data_dir: dir.clone(), keys: Arc::clone(&keys),
            login_path: Some(format!("{}:/usr/bin:/bin", dir.display())),
        });
        let server = tokio::spawn(serve(listener, state));
        for private_server in ["x_mcp", "hl_mcp"] {
            let body = json!({"model":"codex/default", "messages":[{
                "role":"user", "content":format!("Use {private_server} now")
            }]}).to_string();
            let (status, response) = tokio::time::timeout(Duration::from_secs(10),
                raw_http(addr, "POST", "/v1/chat/completions", Some(&issued.token), Some(&body))
            ).await.expect("gateway must fail closed promptly");
            assert_eq!(status, 502, "{response}");
            assert!(response.contains("Codex still exposes MCP servers after isolation"), "{response}");
        }
        let args = std::fs::read_to_string(dir.join("args.log")).unwrap();
        for name in ["x_mcp", "hl_mcp"] {
            assert!(args.contains(&format!("mcp_servers.{name}.enabled=false")));
        }
        let requests = std::fs::read_to_string(dir.join("requests.log")).unwrap();
        assert!(requests.contains("mcpServerStatus/list"));
        assert!(!requests.contains("thread/start"), "must reject before creating a model session");
        assert!(!requests.contains("turn/start"), "must never send the client's prompt");
        assert_eq!(keys.list()[0].turns_today, 0, "refused turns must be refunded");
        for family in ["gemini", "grok", "muse"] {
            let body = json!({"model":format!("{family}/default"), "messages":[{
                "role":"user", "content":"Use x_mcp and hl_mcp"
            }]}).to_string();
            let (status, response) = raw_http(addr, "POST", "/v1/chat/completions", Some(&issued.token), Some(&body)).await;
            assert_eq!(status, if cfg!(target_os = "macos") { 502 } else { 409 }, "{family}: {response}");
        }
        server.abort();
        let _ = server.await;
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn legacy_key_gets_normal_completions_without_private_config() {
        let dir = std::env::temp_dir().join(format!("gateway-sandbox-http-{}", identity::random_hex(8)));
        std::fs::create_dir_all(dir.join("saved-chats-v1")).unwrap();
        let secret = dir.join("private-mcp.json");
        std::fs::write(&secret, r#"{"x_mcp":"PRIVATE_CANARY","hl_mcp":"PRIVATE_CANARY"}"#).unwrap();
        let script = format!(r#"prompt=$(cat)
case "$prompt" in
 *x_mcp*|*hl_mcp*)
   if cat '{}' 2>/dev/null; then exit 21; fi
   printf PRIVATE_MCP_UNAVAILABLE ;;
 *) printf 'GATEWAY_OK 42' ;;
esac
"#, secret.display());
        std::fs::write(dir.join("saved-chats-v1/session.json"), json!({"profiles":[{
            "id":"sandbox-test", "display_name":"Sandbox Test", "access":"read", "persona":"",
            "backend":{"kind":"cli", "program":"/bin/sh", "args":["-c",script]}
        }]}).to_string()).unwrap();
        let keys = GatewayKeys::load(&dir).unwrap();
        let issued = keys.issue(crate::gateway_keys::IssueSpec {
            label: "Legacy sandbox test".into(), scopes: vec![KeyScope::Cli],
            allow_mcp: false, max_turns_per_day: None, max_usd_micros_per_month: None
        }).unwrap();
        let key_path = dir.join(crate::gateway_keys::FILE);
        let mut stored: Value = serde_json::from_str(&std::fs::read_to_string(&key_path).unwrap()).unwrap();
        stored["keys"][0]["allow_mcp"] = json!(true);
        std::fs::write(key_path, stored.to_string()).unwrap();
        let keys = Arc::new(GatewayKeys::load(&dir).unwrap());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(serve(listener, Arc::new(GatewayHttpState {
            data_dir:dir.clone(), keys:Arc::clone(&keys), login_path:Some("/usr/bin:/bin".into()),
        })));
        let (status, catalog) = raw_http(addr, "GET", "/v1/models", Some(&issued.token), None).await;
        assert_eq!(status, 200);
        assert!(catalog.contains("cli/sandbox-test"));
        for (prompt, expected) in [("Reply normally", "GATEWAY_OK 42"), ("Use x_mcp and hl_mcp", "PRIVATE_MCP_UNAVAILABLE")] {
            let body = json!({"model":"cli/sandbox-test", "messages":[{"role":"user","content":prompt}]}).to_string();
            let (status, reply) = tokio::time::timeout(Duration::from_secs(10), raw_http(addr, "POST", "/v1/chat/completions", Some(&issued.token), Some(&body))).await.unwrap();
            assert_eq!(status, 200, "{reply}");
            assert!(reply.contains(expected), "{reply}");
            assert!(!reply.contains("PRIVATE_CANARY"));
        }
        assert_eq!(keys.list()[0].turns_today, 2);
        server.abort(); let _ = server.await;
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore = "requires host Grok sign-in and uses a model turn"]
    async fn live_grok_http_completion_with_legacy_key() {
        let dir = std::env::temp_dir().join(format!("gateway-live-grok-{}", identity::random_hex(8)));
        std::fs::create_dir_all(&dir).unwrap();
        let keys = GatewayKeys::load(&dir).unwrap();
        let issued = keys.issue(crate::gateway_keys::IssueSpec {
            label:"Live isolation test".into(), scopes:vec![KeyScope::Sub], allow_mcp:false,
            max_turns_per_day:Some(2), max_usd_micros_per_month:None,
        }).unwrap();
        let path = dir.join(crate::gateway_keys::FILE);
        let mut stored: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        stored["keys"][0]["allow_mcp"] = json!(true);
        std::fs::write(path, stored.to_string()).unwrap();
        let keys = Arc::new(GatewayKeys::load(&dir).unwrap());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(serve(listener, Arc::new(GatewayHttpState {
            data_dir:dir.clone(), keys:Arc::clone(&keys), login_path:None,
        })));
        let body = json!({"model":"grok/default", "messages":[{"role":"user","content":"Without using tools, reply exactly: GATEWAY_OK 42"}]}).to_string();
        let result = tokio::time::timeout(Duration::from_secs(90), raw_http(addr, "POST", "/v1/chat/completions", Some(&issued.token), Some(&body))).await;
        server.abort(); let _ = server.await;
        std::fs::remove_dir_all(&dir).unwrap();
        let (status, reply) = result.unwrap();
        assert_eq!(status, 200, "{reply}");
        let response: Value = serde_json::from_str(&reply).unwrap();
        assert!(response["choices"][0]["message"]["content"].as_str().unwrap().contains("GATEWAY_OK 42"), "{reply}");
        std::fs::write("/tmp/apx-gateway-isolation-live.json", json!({"backend":"grok/default", "legacy_allow_mcp":true,"status":status,"response":response,"test_runtime_removed":true}).to_string()).unwrap();
    }

    #[tokio::test]
    async fn client_mcp_calls_are_always_rejected() {
        let action = apex_core::ProposedAction {
            kind: apex_core::ActionKind::Tool,
            title: "x_mcp: post".into(), detail: "{}".into(),
            expires_at: None, risky: false,
        };
        assert_eq!(super::GatewayApprover.decide(action).await, apex_core::Decision::Reject);
    }

    use super::*;
    use crate::gateway_keys::IssueSpec;

    fn agent(tool: AgentTool) -> Backend {
        Backend::Agent {
            tool,
            model: None,
        }
    }

    #[test]
    fn gateway_requires_platform_isolation_for_muse_and_other_clis() {
        assert_eq!(gateway_isolation_error(&agent(AgentTool::Muse)).is_none(), cfg!(target_os = "macos"));
        for tool in [AgentTool::Gemini, AgentTool::Grok] {
            assert_eq!(gateway_isolation_error(&agent(tool)).is_none(), cfg!(target_os = "macos"));
        }
        for tool in [AgentTool::ClaudeCode, AgentTool::Codex] {
            assert!(gateway_isolation_error(&agent(tool)).is_none());
        }
        assert_eq!(gateway_isolation_error(&Backend::Cli { program: "custom".into(), args: vec![] }).is_none(), cfg!(target_os = "macos"));
    }

    fn msg(role: &str, content: Value) -> ChatMessage {
        ChatMessage {
            role: role.to_string(),
            content,
            name: None,
            tool_call_id: None,
            tool_calls: None,
        }
    }

    #[test]
    fn flatten_merges_consecutive_roles_skips_empty_and_formats_tool_messages() {
        let mut tool_msg = msg("tool", json!("72F and sunny"));
        tool_msg.tool_call_id = Some("call_weather_1".to_string());

        let mut assistant_with_call = msg("assistant", json!(""));
        assistant_with_call.tool_calls = Some(json!([
            {
                "id": "call_weather_1",
                "type": "function",
                "function": { "name": "get_weather", "arguments": "{\"city\":\"SF\"}" }
            }
        ]));

        let messages = vec![
            msg("system", json!("Be concise.")),
            msg("developer", json!("Always cite units.")),
            msg("user", json!("   ")), // empty content skipped
            msg("user", json!("What is the weather?")),
            assistant_with_call,
            msg("assistant", json!("Let me check that for you.")), // consecutive assistant
            tool_msg,
            msg("user", json!("Thanks!")), // merges with preceding tool (both Role::User)
        ];

        let flat = flatten_openai_messages(&messages).unwrap();
        assert_eq!(flat.system, "Be concise.\n\nAlways cite units.");
        assert_eq!(
            flat.turns,
            vec![
                ViewTurn {
                    role: Role::User,
                    content: "What is the weather?".to_string(),
                },
                ViewTurn {
                    role: Role::Assistant,
                    content: "[Tool call (call_weather_1): get_weather({\"city\":\"SF\"})]\n\nLet me check that for you.".to_string(),
                },
                ViewTurn {
                    role: Role::User,
                    content: "[Tool result (call_weather_1)]: 72F and sunny\n\nThanks!".to_string(),
                },
            ]
        );
        assert!(flat.prompt.contains("--- Conversation so far ---"));
        assert!(flat.prompt.contains("[You]: [Tool call (call_weather_1): get_weather({\"city\":\"SF\"})]"));
        assert!(flat.prompt.contains("[Tool result (call_weather_1)]: 72F and sunny\n\nThanks!"));
    }

    #[test]
    fn flatten_prepends_opening_user_turn_when_assistant_speaks_first() {
        let messages = vec![
            msg("assistant", json!("Hello! How can I help?")),
            msg("user", json!("Write a test.")),
        ];
        let flat = flatten_openai_messages(&messages).unwrap();
        assert_eq!(flat.system, DEFAULT_GATEWAY_SYSTEM);
        assert_eq!(flat.turns[0].role, Role::User);
        assert_eq!(flat.turns[0].content, "(The conversation begins.)");
        assert_eq!(flat.turns[1].role, Role::Assistant);
        assert_eq!(flat.turns[2].role, Role::User);
    }

    #[test]
    fn flatten_rejects_empty_or_system_only_messages() {
        assert!(flatten_openai_messages(&[]).is_err());
        assert!(flatten_openai_messages(&[msg("system", json!("only system"))]).is_err());
        assert!(flatten_openai_messages(&[msg("user", json!("   "))]).is_err());
    }

    #[test]
    fn merged_agent_models_puts_reported_first_then_builtins_without_duplicates() {
        let reported = vec![
            ModelChoice {
                id: "claude-opus-4-6".to_string(),
                label: Some("Opus 4.6".to_string()),
                efforts: None,
            },
            ModelChoice {
                id: "custom-account-model".to_string(),
                label: None,
                efforts: None,
            },
        ];
        let merged = merged_agent_model_ids(AgentTool::ClaudeCode, &reported);
        assert_eq!(merged[0], "claude/claude-opus-4-6");
        assert_eq!(merged[1], "claude/custom-account-model");
        assert_eq!(merged[2], "claude/opus");
        assert_eq!(
            merged.iter().filter(|id| *id == "claude/claude-opus-4-6").count(),
            1,
            "built-in duplicate of reported model must be deduplicated"
        );
        assert_eq!(merged.last().unwrap(), "claude/default");
    }

    #[tokio::test]
    async fn http_gateway_authenticates_serves_models_streams_and_refunds_bad_requests() {
        let dir = std::env::temp_dir().join(format!(
            "apex-gateway-http-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("saved-chats-v1")).unwrap();

        // Save a scripted profile so we can exercise /v1/chat/completions end-to-end
        // without needing external network or CLI binaries in unit tests.
        let session = json!({
            "version": 1,
            "profiles": [{
                "id": "echo-bot",
                "display_name": "Echo Bot",
                "backend": {
                    "kind": "scripted",
                    "lines": ["Gateway reply from scripted bot."]
                },
                "persona": "",
                "access": "read"
            }]
        });
        std::fs::write(
            dir.join("saved-chats-v1").join("session.json"),
            serde_json::to_string(&session).unwrap(),
        )
        .unwrap();

        let keys = Arc::new(GatewayKeys::load(&dir).unwrap());
        let issued = keys
            .issue(IssueSpec {
                label: "test-rig".into(),
                scopes: KeyScope::all_scopes(),
                allow_mcp: false,
                max_turns_per_day: Some(1),
                max_usd_micros_per_month: None,
            })
            .unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let state = GatewayHttpState::new(dir.clone(), Arc::clone(&keys));
        let server = tokio::spawn(serve(listener, state));

        // 1. Missing bearer -> 401
        let (status, body) = raw_http(
            addr,
            "GET",
            "/v1/models",
            None,
            None,
        )
        .await;
        assert_eq!(status, 401);
        assert!(body.contains("Missing Authorization"));

        // 2. Valid bearer on GET /v1/models -> includes scripted/echo-bot
        let (status, body) = raw_http(
            addr,
            "GET",
            "/v1/models",
            Some(&issued.token),
            None,
        )
        .await;
        assert_eq!(status, 200);
        let list: Value = serde_json::from_str(&body).unwrap();
        assert!(list["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["id"] == "scripted/echo-bot"));

        // 3. Malformed chat request (400) does NOT consume the 1-turn daily cap
        let (status, _) = raw_http(
            addr,
            "POST",
            "/v1/chat/completions",
            Some(&issued.token),
            Some(r#"{"model":"scripted/echo-bot","messages":[]}"#),
        )
        .await;
        assert_eq!(status, 400);
        assert_eq!(keys.list()[0].turns_today, 0);

        // 4. Streaming completion succeeds and uses the 1 turn
        let (status, sse_body) = raw_http(
            addr,
            "POST",
            "/v1/chat/completions",
            Some(&issued.token),
            Some(r#"{"model":"scripted/echo-bot","stream":true,"messages":[{"role":"user","content":"Hello"}]}"#),
        )
        .await;
        assert_eq!(status, 200);
        let streamed = sse_stream_state(&sse_body);
        assert_eq!(
            streamed.text, "Gateway reply from scripted bot.",
            "deltas must reassemble into the reply, in order"
        );
        assert!(streamed.done, "the stream must end with data: [DONE]");
        assert_eq!(streamed.finish_reason.as_deref(), Some("stop"));
        assert!(streamed.saw_role_delta);
        assert_eq!(streamed.usage.unwrap()["total_tokens"], 0);
        assert_eq!(keys.list()[0].turns_today, 1);

        // 5. Next turn hits the daily cap -> 429
        let (status, cap_body) = raw_http(
            addr,
            "POST",
            "/v1/chat/completions",
            Some(&issued.token),
            Some(r#"{"model":"scripted/echo-bot","messages":[{"role":"user","content":"Again"}]}"#),
        )
        .await;
        assert_eq!(status, 429);
        assert!(cap_body.contains("Daily turn limit"));

        // 6. Revoked key returns 401 "This API key has been revoked."
        keys.revoke(&issued.key.id).unwrap();
        let (status, rev_body) = raw_http(
            addr,
            "GET",
            "/v1/models",
            Some(&issued.token),
            None,
        )
        .await;
        assert_eq!(status, 401);
        assert!(rev_body.contains("revoked"));

        server.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// What a client would reconstruct from an OpenAI SSE body.
    #[derive(Debug, Default)]
    struct SseState {
        text: String,
        done: bool,
        finish_reason: Option<String>,
        saw_role_delta: bool,
        usage: Option<Value>,
    }

    fn sse_stream_state(body: &str) -> SseState {
        let mut state = SseState::default();
        for line in body.lines() {
            let Some(data) = line.strip_prefix("data: ") else {
                continue;
            };
            if data.trim() == "[DONE]" {
                state.done = true;
                continue;
            }
            let frame: Value = serde_json::from_str(data).expect("every data: frame is JSON");
            let choice = &frame["choices"][0];
            if choice["delta"]["role"] == "assistant" {
                state.saw_role_delta = true;
            }
            if let Some(text) = choice["delta"]["content"].as_str() {
                state.text.push_str(text);
            }
            if let Some(reason) = choice["finish_reason"].as_str() {
                state.finish_reason = Some(reason.to_string());
            }
            if frame.get("usage").is_some_and(|u| !u.is_null()) {
                state.usage = Some(frame["usage"].clone());
            }
        }
        state
    }

    async fn raw_http(
        addr: std::net::SocketAddr,
        method: &str,
        path: &str,
        bearer: Option<&str>,
        body: Option<&str>,
    ) -> (u16, String) {
        let mut stream = TcpStream::connect(addr).await.unwrap();
        let payload = body.unwrap_or("");
        let auth_header = bearer
            .map(|t| format!("Authorization: Bearer {t}\r\n"))
            .unwrap_or_default();
        let req = format!(
            "{method} {path} HTTP/1.1\r\nHost: {addr}\r\n{auth_header}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
            payload.len()
        );
        stream.write_all(req.as_bytes()).await.unwrap();
        let mut resp = String::new();
        stream.read_to_string(&mut resp).await.unwrap();
        let (head, rest) = resp.split_once("\r\n\r\n").unwrap_or((&resp, ""));
        let status_line = head.lines().next().unwrap_or("");
        let status: u16 = status_line
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        (status, rest.to_string())
    }
}
