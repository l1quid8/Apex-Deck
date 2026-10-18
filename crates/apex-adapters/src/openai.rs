use apex_core::{
    Approver, Backend, ContextUse, DeltaSink, NoApprover, Participant, ParticipantConfig, ParticipantError, Progress,
    ProgressSink, Reply, Role, TurnRequest,
};
use async_trait::async_trait;
use futures::StreamExt;
use serde_json::{json, Value};

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::api_tools::{self, ToolBox, ToolCall};
use crate::Utf8Chunks;

/// Most times one reply may go back to its tools before it is stopped.
const TOOL_ROUNDS_MAX: usize = 100;
/// Recent replies whose thinking is kept for DeepSeek.
const REASONING_KEPT: usize = 32;

/// A participant backed by an HTTP API that speaks the OpenAI-style chat
/// completions format with server-sent event streaming.
///
/// In a chat it is given tools (`api_tools`): files, a shell, web pages and
/// the person's MCP servers, gated by its access level. Built with `new`
/// alone, as for summaries and ApexAgent's checks, it has none.
pub struct OpenAiCompatParticipant {
    config: ParticipantConfig,
    client: reqwest::Client,
    /// Where pictures and videos this bot makes are saved (`media.rs`).
    media_dir: Option<std::path::PathBuf>,
    attachment_roots: Vec<std::path::PathBuf>,
    /// How often a queued video is checked on.
    poll: std::time::Duration,
    tools: Option<Arc<ToolBox>>,
    /// The server turned tools down once; later replies go without them.
    tools_refused: AtomicBool,
    /// The thinking behind this bot's recent replies, by reply text.
    /// DeepSeek's own API refuses a request with tools unless the thinking
    /// of earlier replies is sent back with them.
    reasoning: Mutex<VecDeque<(String, String)>>,
}

impl OpenAiCompatParticipant {
    pub fn new(config: ParticipantConfig) -> Self {
        Self {
            config,
            client: reqwest::Client::new(),
            media_dir: None,
            attachment_roots: Vec::new(),
            poll: std::time::Duration::from_secs(5),
            tools: None,
            tools_refused: AtomicBool::new(false),
            reasoning: Mutex::new(VecDeque::new()),
        }
    }

    /// Lend the bot tools to work in the chat's folder with, as `context`
    /// describes it.
    pub fn with_tools(mut self, context: &crate::BuildContext) -> Self {
        self.tools = Some(Arc::new(ToolBox::new(context)));
        self
    }

    /// Let the bot make pictures and videos when its model does, saving
    /// them in `dir`.
    pub fn with_media_dir(mut self, dir: Option<std::path::PathBuf>) -> Self {
        self.media_dir = dir;
        self
    }

    /// Configure host-authorized image input folders. Defaults to no local reads.
    pub fn with_attachment_roots(mut self, roots: Vec<std::path::PathBuf>) -> Self {
        self.attachment_roots = roots.into_iter().filter_map(|root| root.canonicalize().ok()).collect();
        self
    }

    /// Check on queued videos this often. For tests.
    pub fn with_poll(mut self, poll: std::time::Duration) -> Self {
        self.poll = poll;
        self
    }
}

// Never send OpenAI's paid processing override to an arbitrary compatible server.
fn apply_speed(body: &mut Value, base_url: &str, speed: Option<apex_core::Speed>) {
    let Some(speed) = speed else { return };
    let Ok(url) = reqwest::Url::parse(base_url.trim()) else { return };
    if url.scheme() == "https" && url.host_str() == Some("api.openai.com")
        && url.port_or_known_default() == Some(443) && url.path().trim_end_matches('/') == "/v1"
        && url.query().is_none() && url.fragment().is_none()
        && url.username().is_empty() && url.password().is_none()
    {
        body["service_tier"] = json!(crate::presets::codex_service_tier(speed));
    }
}

/// The JSON body for one turn.
pub(crate) fn request_body(model: &str, effort: Option<&str>, request: &TurnRequest, roots: &[std::path::PathBuf]) -> Result<Value, ParticipantError> {
    let images = crate::attachments::for_request(request, roots)?;
    let mut messages = vec![json!({ "role": "system", "content": request.system })];
    for (index, turn) in request.turns.iter().enumerate() {
        let role = match turn.role {
            Role::User => "user",
            Role::Assistant => "assistant",
        };
        let attached = crate::attachments::paths(&turn.content);
        let current: Vec<_> = images.iter().filter(|image| turn.role == Role::User && attached.contains(&image.path)
            && !request.turns[index + 1..].iter().any(|later| later.role == Role::User && crate::attachments::paths(&later.content).contains(&image.path))).collect();
        let content = if current.is_empty() { json!(turn.content) } else {
            let mut parts = vec![json!({ "type": "text", "text": turn.content })];
            parts.extend(current.iter().map(|image| json!({ "type": "image_url", "image_url": { "url": image.url() } })));
            json!(parts)
        };
        messages.push(json!({ "role": role, "content": content }));
    }
    // Without include_usage, OpenAI and some others send no token counts
    // when streaming. Servers that send them anyway ignore it.
    let mut body = json!({ "model": model, "messages": messages, "stream": true, "stream_options": { "include_usage": true } });
    // Only sent when set, because servers that do not know the field may
    // reject the request.
    if let Some(effort) = effort.map(str::trim).filter(|e| !e.is_empty()) {
        body["reasoning_effort"] = json!(effort);
    }
    Ok(body)
}

/// What one line of the event stream contributed.
#[derive(Debug, PartialEq)]
pub(crate) enum SseLine {
    Text(String),
    /// A piece of the model's thinking, which isn't part of the reply.
    Reasoning(String),
    /// A piece of a tool call. The first piece of each call has its id and
    /// name; the arguments arrive in pieces after it.
    Tool { index: usize, id: Option<String>, name: Option<String>, arguments: String },
    Error(String),
    Usage { input: Option<u64>, output: Option<u64>, cached: Option<u64>, cost_usd: Option<f64> },
    Done,
    Ignored,
}

pub(crate) fn parse_sse_line(line: &str) -> Vec<SseLine> {
    let Some(data) = line.trim_end_matches('\r').strip_prefix("data:") else {
        return vec![SseLine::Ignored];
    };
    let data = data.trim();
    if data == "[DONE]" {
        return vec![SseLine::Done];
    }
    let Ok(value) = serde_json::from_str::<Value>(data) else {
        return vec![SseLine::Ignored];
    };

    if let Some(error) = value.get("error").filter(|error| !error.is_null()) {
        let message = error["message"].as_str().or_else(|| error.as_str())
            .unwrap_or("provider reported an error in its response stream");
        return vec![SseLine::Error(message.to_owned())];
    }
    let mut out = Vec::new();
    let delta = &value["choices"][0]["delta"];
    // DeepSeek and vLLM call it reasoning_content; OpenRouter and Ollama, reasoning.
    for key in ["reasoning_content", "reasoning"] {
        if let Some(text) = delta[key].as_str().filter(|t| !t.is_empty()) {
            out.push(SseLine::Reasoning(text.to_string()));
        }
    }
    if let Some(text) = delta["content"].as_str() {
        if !text.is_empty() {
            out.push(SseLine::Text(text.to_string()));
        }
    }
    for (position, call) in delta["tool_calls"].as_array().into_iter().flatten().enumerate() {
        out.push(SseLine::Tool {
            index: call["index"].as_u64().map_or(position, |i| i as usize),
            id: call["id"].as_str().filter(|i| !i.is_empty()).map(str::to_string),
            name: call["function"]["name"].as_str().filter(|n| !n.is_empty()).map(str::to_string),
            arguments: match &call["function"]["arguments"] {
                Value::String(text) => text.clone(),
                // Some servers send the arguments whole, as an object.
                Value::Null => String::new(),
                other => other.to_string(),
            },
        });
    }
    if value["usage"].is_object() {
        let usage = &value["usage"];
        out.push(SseLine::Usage {
            input: usage["prompt_tokens"].as_u64(),
            output: usage["completion_tokens"].as_u64(),
            cached: usage["prompt_tokens_details"]["cached_tokens"].as_u64(),
            // Venice puts the cost beside the usage, OpenRouter inside it.
            cost_usd: value["cost"]["usd"].as_f64().or_else(|| usage["cost"].as_f64()).filter(|c| c.is_finite() && *c >= 0.0),
        });
    }
    if out.is_empty() {
        out.push(SseLine::Ignored);
    }
    out
}

/// What a turn cost in millionths of a dollar: the server's own figure when
/// it gives one, otherwise worked out from the model's listed prices.
pub(crate) fn cost_micros(
    reported_usd: Option<f64>,
    model: Option<&crate::ApiModel>,
    input: Option<u64>,
    cached: Option<u64>,
    output: Option<u64>,
) -> Option<u64> {
    if let Some(usd) = reported_usd {
        return Some((usd * 1_000_000.0).round() as u64);
    }
    let model = model?;
    let (price_in, price_out) = (model.price_in?, model.price_out?);
    let input = input? as f64;
    let cached = (cached.unwrap_or(0) as f64).min(input);
    // Prices are per million tokens, so tokens × price is millionths of a dollar.
    let micros = (input - cached) * price_in
        + cached * model.price_cached_in.unwrap_or(price_in)
        + output.unwrap_or(0) as f64 * price_out;
    Some(micros.round() as u64)
}

/// What to tell someone whose bot has no key under `name`.
pub(crate) fn no_key(name: &str) -> String {
    format!("no API key is saved for {name}. Open this bot's settings and paste your key into API key, or add it in Settings → Providers → API keys.")
}

/// The models an OpenAI-compatible server offers, sorted by id, with what
/// it says about each. Used to fill the model picker.
pub async fn list_models(base_url: &str, api_key_env: Option<&str>) -> Result<Vec<crate::ApiModel>, String> {
    crate::api_info::models(base_url, api_key_env).await
}

#[async_trait]
impl Participant for OpenAiCompatParticipant {
    fn config(&self) -> &ParticipantConfig {
        &self.config
    }

    /// A picture or video model costs money with every message, so it
    /// answers only when named.
    fn named_only(&self) -> bool {
        let Backend::OpenAiCompatible { base_url, model, .. } = &self.config.backend else { return false };
        crate::api_info::cached_kind(base_url, model).is_some_and(|kind| kind != crate::ModelKind::Text)
    }

    async fn respond(
        &self,
        request: TurnRequest,
        on_delta: DeltaSink<'_>,
    ) -> Result<Reply, ParticipantError> {
        self.respond_with_progress(request, &|update| {
            if let Progress::Text(text) = update {
                on_delta(text);
            }
        })
        .await
    }

    /// With nobody to ask, a picture or video is never paid for.
    async fn respond_with_progress(
        &self,
        request: TurnRequest,
        on_progress: ProgressSink<'_>,
    ) -> Result<Reply, ParticipantError> {
        self.respond_with_approvals(request, on_progress, &NoApprover).await
    }

    async fn respond_with_approvals(
        &self,
        request: TurnRequest,
        on_progress: ProgressSink<'_>,
        approver: &dyn Approver,
    ) -> Result<Reply, ParticipantError> {
        let Backend::OpenAiCompatible { base_url, model, api_key_env } = &self.config.backend else {
            return Err(ParticipantError::NotConfigured("backend is not an HTTP API".into()));
        };

        // An image or video model makes a file instead of chatting. Only
        // Venice lists those, so other providers skip the lookup.
        if crate::api_info::is_venice(base_url) {
            if let Some(info) = crate::api_info::model(base_url, api_key_env.as_deref(), model).await.filter(|m| m.kind != crate::ModelKind::Text) {
                let dir = self.media_dir.as_deref().ok_or_else(|| ParticipantError::NotConfigured("this thread has no folder to save pictures and videos in".into()))?;
                let key = match api_key_env.as_deref().filter(|n| !n.is_empty()) {
                    Some(name) => Some(crate::keys::lookup(name).ok_or_else(|| ParticipantError::NotConfigured(no_key(name)))?),
                    None => None,
                };
                let job = crate::media::Job { client: &self.client, base_url, key, model: &info, settings: self.config.media.as_ref(), dir, attachment_roots: &self.attachment_roots, poll: self.poll, approver, bot: &self.config.id };
                return job.run(&request, on_progress).await;
            }
        }

        let key = match api_key_env.as_deref().filter(|n| !n.is_empty()) {
            Some(name) => Some(crate::keys::lookup(name).ok_or_else(|| ParticipantError::NotConfigured(no_key(name)))?),
            None => None,
        };
        let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
        let effort = request.effort_override.as_deref().or(self.config.effort.as_deref());
        let mut base = request_body(model, effort, &request, &self.attachment_roots)?;
        apply_speed(&mut base, base_url, self.config.speed);
        let mut messages: Vec<Value> = base["messages"].as_array().cloned().unwrap_or_default();
        let system = request.system.clone();

        // Tools in a chat turn, unless the model can't take them or this is
        // only the question about what the person will ask next.
        let next_steps = request.turns.last().is_some_and(|t| t.role == Role::User && t.content == apex_core::next_steps::ASK);
        let mut turn = match &self.tools {
            Some(tools) if !next_steps && !self.tools_refused.load(Ordering::SeqCst) && crate::api_info::cached_tools(base_url, model) != Some(false) => {
                let access = request.access.unwrap_or(self.config.access);
                Some(api_tools::Turn::new(tools, access, request.plan, self.config.access, approver, on_progress))
            }
            _ => None,
        };
        let deepseek = is_deepseek(base_url);
        match &turn {
            Some(turn) => {
                messages[0]["content"] = json!(format!("{system}{}", turn.instructions()));
                if deepseek {
                    self.restore_reasoning(&mut messages);
                }
            }
            None if self.tools.is_some() && !next_steps => messages[0]["content"] = json!(format!("{system}{}", api_tools::NO_TOOLS)),
            None => {}
        }

        let mut info: Option<tokio::task::JoinHandle<Option<crate::ApiModel>>> = None;
        let mut reply = Reply::default();
        let mut thinking = String::new();
        let mut thinking_off = false;
        // Thinking goes back with the tool calls it led to, unless the
        // server turns that down.
        let mut echo_thinking = true;
        let mut rounds: Vec<Usage> = Vec::new();
        let mut stopped_early = false;
        for round in 0.. {
            if round == TOOL_ROUNDS_MAX {
                stopped_early = true;
                break;
            }
            let response = loop {
                let mut body = base.clone();
                body["messages"] = json!(messages);
                if let Some(turn) = &turn {
                    body["tools"] = json!(turn.definitions());
                    body["tool_choice"] = json!("auto");
                }
                if thinking_off {
                    body["thinking"] = json!({"type": "disabled"});
                }
                let mut call = self.client.post(&url).json(&body);
                if let Some(key) = &key {
                    call = call.bearer_auth(key);
                }
                let response = call.send().await.map_err(|e| ParticipantError::Failed(format!("request to {url} failed: {e}")))?;
                let status = response.status();
                if status.is_success() {
                    break response;
                }
                let text = response.text().await.unwrap_or_default();
                let lower = text.to_ascii_lowercase();
                // DeepSeek wants the thinking of every earlier reply back;
                // when that isn't to hand, the turn goes on without thinking.
                if deepseek && turn.is_some() && !thinking_off && lower.contains("reasoning_content") {
                    thinking_off = true;
                    strip_reasoning(&mut messages);
                    continue;
                }
                // Another server that doesn't take thinking sent back.
                if !deepseek && echo_thinking && lower.contains("reasoning") && messages.iter().any(|m| m.get("reasoning_content").is_some()) {
                    echo_thinking = false;
                    strip_reasoning(&mut messages);
                    continue;
                }
                // A model that doesn't take tools: answer without them,
                // and say so, so it doesn't pretend.
                if turn.is_some() && round == 0 && matches!(status.as_u16(), 400 | 404 | 422 | 501) && (lower.contains("tool") || lower.contains("function")) {
                    eprintln!("[apex-deck] {model} turned tools down; answering without them: {}", text.chars().take(200).collect::<String>());
                    self.tools_refused.store(true, Ordering::SeqCst);
                    turn = None;
                    strip_reasoning(&mut messages);
                    messages[0]["content"] = json!(format!("{system}{}", api_tools::NO_TOOLS));
                    continue;
                }
                let snippet: String = text.chars().take(300).collect();
                let hint = match status.as_u16() {
                    401 | 403 if key.is_none() => " This server wants an API key. Open this bot's settings and paste one into API key.",
                    401 | 403 => " The saved API key was refused. Open this bot's settings and paste a new one into API key.",
                    _ => "",
                };
                return Err(ParticipantError::Failed(format!("{url} returned {status}: {snippet}{hint}")));
            };

            // The model's context size and prices, looked up while the reply
            // streams. The list is cached, so this rarely costs a request.
            if info.is_none() {
                info = Some(tokio::spawn({
                    let (base_url, key, model) = (base_url.clone(), api_key_env.clone(), model.clone());
                    async move { crate::api_info::model(&base_url, key.as_deref(), &model).await }
                }));
            }

            // Later rounds continue the same reply: keep their text apart.
            let gap = !reply.text.is_empty() && !reply.text.ends_with("\n\n");
            let mut separated = !gap;
            let mut on_text = |text: &str| {
                if !separated {
                    separated = true;
                    let joint = if reply.text.ends_with('\n') { "\n" } else { "\n\n" };
                    on_progress(Progress::Text(joint));
                    reply.text.push_str(joint);
                }
                on_progress(Progress::Text(text));
                reply.text.push_str(text);
            };
            let streamed = read_stream(response, &url, &mut on_text).await?;
            rounds.push(streamed.usage);
            thinking.push_str(&streamed.reasoning);
            let Some(turn) = turn.as_mut().filter(|_| !streamed.calls.is_empty()) else { break };

            let mut said = json!({
                "role": "assistant",
                "content": streamed.text,
                "tool_calls": streamed.calls.iter().map(|c| json!({
                    "id": c.id,
                    "type": "function",
                    "function": {"name": c.name, "arguments": if c.arguments.trim().is_empty() { "{}" } else { c.arguments.as_str() }}
                })).collect::<Vec<_>>()
            });
            if !streamed.reasoning.is_empty() && !thinking_off && echo_thinking {
                said["reasoning_content"] = json!(streamed.reasoning);
            }
            messages.push(said);
            for call in &streamed.calls {
                let result = turn.run(call).await;
                messages.push(json!({"role": "tool", "tool_call_id": call.id, "content": result}));
            }
        }
        if let Some(turn) = turn.as_mut() {
            turn.finish().await;
        }
        if stopped_early {
            let note = format!("\n\n[Stopped: this reply went back to its tools {TOOL_ROUNDS_MAX} times. Say continue to keep going.]");
            on_progress(Progress::Text(&note));
            reply.text.push_str(&note);
        }
        if deepseek && !thinking.is_empty() && !thinking_off {
            self.remember_reasoning(&reply.text, thinking);
        }

        let info = match info {
            Some(lookup) => lookup.await.ok().flatten(),
            None => None,
        };
        let sum = |pick: fn(&Usage) -> Option<u64>| -> Option<u64> {
            rounds.iter().filter_map(pick).reduce(|a, b| a.saturating_add(b))
        };
        reply.input_tokens = sum(|u| u.input);
        reply.output_tokens = sum(|u| u.output);
        reply.cost_micros = rounds
            .iter()
            .filter_map(|u| cost_micros(u.cost_usd, info.as_ref(), u.input, u.cached, u.output))
            .reduce(|a, b| a.saturating_add(b));
        // The next request carries this whole exchange, so the context in
        // use is what the last request sent plus what came back.
        if let (Some(window), Some(last)) = (info.as_ref().and_then(|m| m.context_tokens), rounds.last()) {
            if let Some(input) = last.input {
                let used = input.saturating_add(last.output.unwrap_or(0));
                on_progress(Progress::Context(ContextUse { used_tokens: used.min(window), window_tokens: window }));
            }
        }
        Ok(reply)
    }

    async fn cancel_active_turn(&self) -> Result<bool, String> {
        match &self.tools {
            Some(tools) => tools.processes.terminate_all().await,
            None => Ok(false),
        }
    }
}

/// What one request used, as the server reported it.
#[derive(Debug, Default, Clone, Copy)]
struct Usage {
    input: Option<u64>,
    output: Option<u64>,
    cached: Option<u64>,
    cost_usd: Option<f64>,
}

/// One streamed answer: its text, its thinking and any tool calls.
#[derive(Debug, Default)]
struct Streamed {
    text: String,
    reasoning: String,
    calls: Vec<ToolCall>,
    usage: Usage,
}

/// Read an event stream to its end, passing on the text as it arrives.
async fn read_stream(response: reqwest::Response, url: &str, on_text: &mut (dyn FnMut(&str) + Send)) -> Result<Streamed, ParticipantError> {
    let mut out = Streamed::default();
    let mut decoder = Utf8Chunks::default();
    let mut line = String::new();
    let mut stream = response.bytes_stream();
    let mut done = false;
    let mut handle = |line: &str, out: &mut Streamed, done: &mut bool| -> Result<(), ParticipantError> {
        for item in parse_sse_line(line) {
            match item {
                SseLine::Text(text) => {
                    on_text(&text);
                    out.text.push_str(&text);
                }
                SseLine::Reasoning(text) => out.reasoning.push_str(&text),
                SseLine::Tool { index, id, name, arguments } => {
                    while out.calls.len() <= index {
                        out.calls.push(ToolCall::default());
                    }
                    let call = &mut out.calls[index];
                    if let Some(id) = id {
                        call.id = id;
                    }
                    if let Some(name) = name {
                        call.name = name;
                    }
                    call.arguments.push_str(&arguments);
                }
                SseLine::Usage { input, output, cached, cost_usd } => out.usage = Usage { input, output, cached, cost_usd },
                SseLine::Error(message) => return Err(ParticipantError::Failed(format!("stream from {url} failed: {message}"))),
                SseLine::Done => *done = true,
                SseLine::Ignored => {}
            }
        }
        Ok(())
    };
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| ParticipantError::Failed(format!("stream from {url} broke: {e}")))?;
        line.push_str(&decoder.push(&chunk));
        while let Some(end) = line.find('\n') {
            let complete: String = line.drain(..=end).collect();
            handle(complete.trim_end_matches('\n'), &mut out, &mut done)?;
        }
        if done {
            break;
        }
    }
    if !done {
        line.push_str(&decoder.finish());
        if !line.is_empty() {
            handle(&line, &mut out, &mut done)?;
        }
    }
    // A call without a name can't be run; one without an id gets one, since
    // its result has to point back at it.
    out.calls.retain(|c| !c.name.is_empty());
    for (n, call) in out.calls.iter_mut().enumerate() {
        if call.id.is_empty() {
            call.id = format!("call_{n}");
        }
    }
    Ok(out)
}

/// DeepSeek's own API, the one that wants earlier thinking sent back.
fn is_deepseek(base_url: &str) -> bool {
    reqwest::Url::parse(base_url.trim()).ok().and_then(|u| u.host_str().map(str::to_ascii_lowercase)).as_deref() == Some("api.deepseek.com")
}

/// Take the thinking out of every message, for a request without it.
fn strip_reasoning(messages: &mut [Value]) {
    for message in messages {
        if let Some(fields) = message.as_object_mut() {
            fields.remove("reasoning_content");
        }
    }
}

impl OpenAiCompatParticipant {
    fn remember_reasoning(&self, reply: &str, thinking: String) {
        let mut kept = self.reasoning.lock().unwrap();
        kept.push_back((reply.trim().to_string(), thinking));
        while kept.len() > REASONING_KEPT {
            kept.pop_front();
        }
    }

    /// Put the thinking back on this bot's earlier replies. A reply from
    /// before the chat was opened has none to hand, and gets an empty one.
    fn restore_reasoning(&self, messages: &mut [Value]) {
        let kept = self.reasoning.lock().unwrap();
        for message in messages.iter_mut().filter(|m| m["role"] == "assistant") {
            let text = message["content"].as_str().unwrap_or("").trim().to_string();
            let thinking = kept.iter().rev().find(|(reply, _)| *reply == text).map(|(_, t)| t.clone()).unwrap_or_default();
            message["reasoning_content"] = json!(thinking);
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speed_is_sent_only_to_the_direct_openai_api_when_explicit() {
        for (speed, expected) in [(None, None), (Some(apex_core::Speed::Standard), Some("default")), (Some(apex_core::Speed::Fast), Some("priority"))] {
            let mut body = json!({"model": "gpt-6-sol"});
            apply_speed(&mut body, "https://api.openai.com/v1/", speed);
            assert_eq!(body.get("service_tier").and_then(Value::as_str), expected);
        }
        for url in ["https://api.openai.com.evil.test/v1", "https://other.test/api.openai.com/v1", "https://api.openai.com/proxy", "invalid"] {
            let mut body = json!({"model": "gpt-6-sol"});
            apply_speed(&mut body, url, Some(apex_core::Speed::Fast));
            assert!(body.get("service_tier").is_none(), "{url}");
        }
    }

    #[test]
    fn effort_is_only_in_the_request_when_set() {
        let request = TurnRequest { effort_override: None, access: None, system: "s".into(), turns: vec![], unseen: vec![], plan: false };
        assert!(request_body("m", None, &request, &[]).unwrap().get("reasoning_effort").is_none());
        assert!(request_body("m", Some("  "), &request, &[]).unwrap().get("reasoning_effort").is_none());
        assert_eq!(request_body("m", Some("high"), &request, &[]).unwrap()["reasoning_effort"], "high");
    }

    #[test]
    fn cost_prefers_the_servers_figure_then_listed_prices() {
        let glm = crate::ApiModel { id: "glm".into(), price_in: Some(1.4), price_cached_in: Some(0.26), price_out: Some(4.4), ..Default::default() };
        assert_eq!(cost_micros(Some(0.00042292), Some(&glm), Some(1), None, Some(1)), Some(423));
        // 1000 fresh + 1000 cached in, 100 out.
        assert_eq!(cost_micros(None, Some(&glm), Some(2000), Some(1000), Some(100)), Some(1400 + 260 + 440));
        assert_eq!(cost_micros(None, Some(&crate::ApiModel { id: "x".into(), ..Default::default() }), Some(10), None, Some(1)), None);
        assert_eq!(cost_micros(None, None, Some(10), None, Some(1)), None);
    }

    #[test]
    fn parses_text_usage_done_and_noise() {
        assert_eq!(
            parse_sse_line(r#"data: {"choices":[{"delta":{"content":"Hi"}}]}"#),
            vec![SseLine::Text("Hi".into())]
        );
        assert_eq!(
            parse_sse_line(r#"data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}"#),
            vec![SseLine::Usage { input: Some(12), output: Some(3), cached: None, cost_usd: None }]
        );
        // Venice's shape: cached tokens and the dollar cost.
        assert_eq!(
            parse_sse_line(r#"data: {"choices":[],"usage":{"prompt_tokens":1485,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":1472}},"cost":{"usd":0.00042292}}"#),
            vec![SseLine::Usage { input: Some(1485), output: Some(5), cached: Some(1472), cost_usd: Some(0.00042292) }]
        );
        // OpenRouter's shape.
        assert_eq!(
            parse_sse_line(r#"data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"cost":0.5}}"#),
            vec![SseLine::Usage { input: Some(10), output: Some(2), cached: None, cost_usd: Some(0.5) }]
        );
        assert_eq!(parse_sse_line("data: [DONE]"), vec![SseLine::Done]);
        assert_eq!(parse_sse_line(": keep-alive"), vec![SseLine::Ignored]);
        assert_eq!(parse_sse_line(""), vec![SseLine::Ignored]);
        assert_eq!(parse_sse_line(r#"data: {"choices":[{"delta":{"role":"assistant"}}]}"#), vec![SseLine::Ignored]);
    }
    #[test]
    fn attached_images_are_native_content_not_just_path_text() {
        let path = std::env::temp_dir().join(format!("apex-vision-{}.png", std::process::id()));
        std::fs::write(&path, b"\x89PNG\r\n\x1a\nfixture").unwrap();
        let text = format!("Describe this\nAttached image: {}", path.display());
        let request = TurnRequest { effort_override: None, access: None, system: "s".into(),
            turns: vec![apex_core::ViewTurn { role: Role::User, content: text }], unseen: vec![], plan: false };
        let body = request_body("vision", None, &request, &[path.parent().unwrap().canonicalize().unwrap()]).unwrap();
        std::fs::remove_file(path).unwrap();
        assert_eq!(body["messages"][1]["content"][0]["type"], "text");
        assert!(body["messages"][1]["content"][1]["image_url"]["url"].as_str().unwrap().starts_with("data:image/png;base64,"));
    }

    #[test]
    fn a_later_assistant_path_reference_does_not_take_the_users_image() {
        let path = std::env::temp_dir().join(format!("apex-user-image-{}.png", std::process::id()));
        std::fs::write(&path, b"\x89PNG\r\n\x1a\nfixture").unwrap();
        let text = format!("Attached image: {}", path.display());
        let request = TurnRequest { effort_override: None, access: None, system: "s".into(),
            turns: vec![apex_core::ViewTurn { role: Role::User, content: text.clone() },
                apex_core::ViewTurn { role: Role::Assistant, content: text.clone() }],
            unseen: vec![apex_core::Message { seq: 0, speaker: apex_core::Speaker::Human, text, servers: vec![], at: None }], plan: false };
        let body = request_body("vision", None, &request, &[path.parent().unwrap().canonicalize().unwrap()]).unwrap();
        std::fs::remove_file(path).unwrap();
        assert_eq!(body["messages"][1]["content"][1]["type"], "image_url");
        assert!(body["messages"][2]["content"].is_string());
    }

}
