use apex_core::{
    Backend, DeltaSink, Participant, ParticipantConfig, ParticipantError, Reply, Role, TurnRequest,
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
    let mut body = json!({ "model": model, "messages": messages, "stream": true });
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
    Usage { input: Option<u64>, output: Option<u64> },
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
        out.push(SseLine::Usage {
            input: value["usage"]["prompt_tokens"].as_u64(),
            output: value["usage"]["completion_tokens"].as_u64(),
        });
    }
    if out.is_empty() {
        out.push(SseLine::Ignored);
    }
    out
}

/// The model names an OpenAI-compatible server offers, from its `/models`
/// endpoint, sorted. Used to fill the model picker.
pub async fn list_models(base_url: &str, api_key_env: Option<&str>) -> Result<Vec<String>, String> {
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let mut call = reqwest::Client::new().get(&url).timeout(std::time::Duration::from_secs(8));
    if let Some(name) = api_key_env.filter(|n| !n.is_empty()) {
        let key = std::env::var(name)
            .map_err(|_| format!("environment variable {name} is not set"))?;
        call = call.bearer_auth(key);
    }
    let response = call.send().await.map_err(|e| format!("could not reach {url}: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("{url} returned {status}"));
    }
    let body: Value =
        response.json().await.map_err(|e| format!("{url} did not return a model list: {e}"))?;
    let mut names: Vec<String> = body["data"]
        .as_array()
        .map(|items| items.iter().filter_map(|m| m["id"].as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    names.sort();
    names.dedup();
    Ok(names)
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
        let Backend::OpenAiCompatible { base_url, model, api_key_env } = &self.config.backend else {
            return Err(ParticipantError::NotConfigured("backend is not an HTTP API".into()));
        };

        let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
        let mut call = self.client.post(&url).json(&request_body(model, self.config.effort.as_deref(), &request));
        if let Some(name) = api_key_env.as_deref().filter(|n| !n.is_empty()) {
            let key = std::env::var(name).map_err(|_| {
                ParticipantError::NotConfigured(format!("environment variable {name} is not set"))
            })?;
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
            return Err(ParticipantError::Failed(format!("{url} returned {status}: {snippet}")));
        }

        let mut reply = Reply::default();
        let mut decoder = Utf8Chunks::default();
        let mut line = String::new();
        let mut stream = response.bytes_stream();
        let mut done = false;

        let handle = |line: &str, reply: &mut Reply, done: &mut bool| {
            for item in parse_sse_line(line) {
                match item {
                    SseLine::Text(text) => {
                        on_delta(&text);
                        reply.text.push_str(&text);
                    }
                    SseLine::Usage { input, output } => {
                        reply.input_tokens = input;
                        reply.output_tokens = output;
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
    fn parses_text_usage_done_and_noise() {
        assert_eq!(
            parse_sse_line(r#"data: {"choices":[{"delta":{"content":"Hi"}}]}"#),
            vec![SseLine::Text("Hi".into())]
        );
        assert_eq!(
            parse_sse_line(r#"data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}"#),
            vec![SseLine::Usage { input: Some(12), output: Some(3) }]
        );
        assert_eq!(parse_sse_line("data: [DONE]"), vec![SseLine::Done]);
        assert_eq!(parse_sse_line(": keep-alive"), vec![SseLine::Ignored]);
        assert_eq!(parse_sse_line(""), vec![SseLine::Ignored]);
        assert_eq!(parse_sse_line(r#"data: {"choices":[{"delta":{"role":"assistant"}}]}"#), vec![SseLine::Ignored]);
    }
}
