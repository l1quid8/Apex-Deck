use apex_core::{
    Backend, ContextUse, DeltaSink, Participant, ParticipantConfig, ParticipantError, Progress, ProgressSink, Reply,
    Role, TurnRequest,
};
use async_trait::async_trait;
use futures::StreamExt;
use serde_json::{json, Value};

use crate::Utf8Chunks;

/// A participant backed by an HTTP API that speaks the OpenAI-style chat
/// completions format with server-sent event streaming.
pub struct OpenAiCompatParticipant {
    config: ParticipantConfig,
    client: reqwest::Client,
}

impl OpenAiCompatParticipant {
    pub fn new(config: ParticipantConfig) -> Self {
        Self { config, client: reqwest::Client::new() }
    }
}

/// The JSON body for one turn.
pub(crate) fn request_body(model: &str, effort: Option<&str>, request: &TurnRequest) -> Value {
    let mut messages = vec![json!({ "role": "system", "content": request.system })];
    for turn in &request.turns {
        let role = match turn.role {
            Role::User => "user",
            Role::Assistant => "assistant",
        };
        messages.push(json!({ "role": role, "content": turn.content }));
    }
    // Without include_usage, OpenAI and some others send no token counts
    // when streaming. Servers that send them anyway ignore it.
    let mut body = json!({ "model": model, "messages": messages, "stream": true, "stream_options": { "include_usage": true } });
    // Only sent when set, because servers that do not know the field may
    // reject the request.
    if let Some(effort) = effort.map(str::trim).filter(|e| !e.is_empty()) {
        body["reasoning_effort"] = json!(effort);
    }
    body
}

/// What one line of the event stream contributed.
#[derive(Debug, PartialEq)]
pub(crate) enum SseLine {
    Text(String),
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

    let mut out = Vec::new();
    if let Some(text) = value["choices"][0]["delta"]["content"].as_str() {
        if !text.is_empty() {
            out.push(SseLine::Text(text.to_string()));
        }
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

    async fn respond_with_progress(
        &self,
        request: TurnRequest,
        on_progress: ProgressSink<'_>,
    ) -> Result<Reply, ParticipantError> {
        let Backend::OpenAiCompatible { base_url, model, api_key_env } = &self.config.backend else {
            return Err(ParticipantError::NotConfigured("backend is not an HTTP API".into()));
        };

        let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
        let effort = request.effort_override.as_deref().or(self.config.effort.as_deref());
        let mut call = self.client.post(&url).json(&request_body(model, effort, &request));
        if let Some(name) = api_key_env.as_deref().filter(|n| !n.is_empty()) {
            let key = crate::keys::lookup(name).ok_or_else(|| ParticipantError::NotConfigured(no_key(name)))?;
            call = call.bearer_auth(key);
        }

        let response = call
            .send()
            .await
            .map_err(|e| ParticipantError::Failed(format!("request to {url} failed: {e}")))?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            let snippet: String = body.chars().take(300).collect();
            let hint = match status.as_u16() {
                401 | 403 if api_key_env.as_deref().is_none_or(str::is_empty) => " This server wants an API key. Open this bot's settings and paste one into API key.",
                401 | 403 => " The saved API key was refused. Open this bot's settings and paste a new one into API key.",
                _ => "",
            };
            return Err(ParticipantError::Failed(format!("{url} returned {status}: {snippet}{hint}")));
        }

        // The model's context size and prices, looked up while the reply
        // streams. The list is cached, so this rarely costs a request.
        let info = tokio::spawn({
            let (base_url, key, model) = (base_url.clone(), api_key_env.clone(), model.clone());
            async move { crate::api_info::model(&base_url, key.as_deref(), &model).await }
        });

        let mut reply = Reply::default();
        let mut decoder = Utf8Chunks::default();
        let mut line = String::new();
        let mut stream = response.bytes_stream();
        let mut done = false;
        let mut cached = None;
        let mut cost_usd = None;

        let mut handle = |line: &str, reply: &mut Reply, done: &mut bool| {
            for item in parse_sse_line(line) {
                match item {
                    SseLine::Text(text) => {
                        on_progress(Progress::Text(&text));
                        reply.text.push_str(&text);
                    }
                    SseLine::Usage { input, output, cached: c, cost_usd: cost } => {
                        reply.input_tokens = input;
                        reply.output_tokens = output;
                        cached = c;
                        cost_usd = cost;
                    }
                    SseLine::Done => *done = true,
                    SseLine::Ignored => {}
                }
            }
        };

        while let Some(chunk) = stream.next().await {
            let chunk =
                chunk.map_err(|e| ParticipantError::Failed(format!("stream from {url} broke: {e}")))?;
            line.push_str(&decoder.push(&chunk));
            while let Some(end) = line.find('\n') {
                let complete: String = line.drain(..=end).collect();
                handle(complete.trim_end_matches('\n'), &mut reply, &mut done);
            }
            if done {
                break;
            }
        }
        if !done {
            line.push_str(&decoder.finish());
            if !line.is_empty() {
                handle(&line, &mut reply, &mut done);
            }
        }

        let info = info.await.ok().flatten();
        reply.cost_micros = cost_micros(cost_usd, info.as_ref(), reply.input_tokens, cached, reply.output_tokens);
        // The next request carries this whole exchange, so the context in
        // use is what was sent plus what came back.
        if let (Some(window), Some(input)) = (info.as_ref().and_then(|m| m.context_tokens), reply.input_tokens) {
            let used = input.saturating_add(reply.output_tokens.unwrap_or(0));
            on_progress(Progress::Context(ContextUse { used_tokens: used.min(window), window_tokens: window }));
        }
        Ok(reply)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effort_is_only_in_the_request_when_set() {
        let request = TurnRequest { effort_override: None, access: None, system: "s".into(), turns: vec![], unseen: vec![], plan: false };
        assert!(request_body("m", None, &request).get("reasoning_effort").is_none());
        assert!(request_body("m", Some("  "), &request).get("reasoning_effort").is_none());
        assert_eq!(request_body("m", Some("high"), &request)["reasoning_effort"], "high");
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
}
