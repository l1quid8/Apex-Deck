//! System One HTTP adapter. Credentials never appear in results or errors.
use apex_core::decision::{DecisionProvider, DecisionRequest, DecisionResult};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

#[derive(Clone)]
pub struct DecisionConfig {
    pub provider: String,
    pub account_id: String,
}
impl DecisionConfig {
    pub fn endpoint(&self) -> Result<(String, &'static str), String> {
        match self.provider.as_str() {
            "jev" => Ok(("https://api.typesafe.ai/v1/systemone".into(), "jev-latest")),
            "openrouter" => Ok(("https://openrouter.ai/api/alpha/decisions".into(), "cloudflare/clef")),
            "cloudflare" if !self.account_id.is_empty() && self.account_id.chars().all(|c| c.is_ascii_alphanumeric()) => Ok((format!("https://api.cloudflare.com/client/v4/accounts/{}/ai/run/@cf/cloudflare/clef", self.account_id), "clef")),
            _ => Err("Select a decision provider and, for Cloudflare, a valid account ID".into()),
        }
    }
}
pub struct HttpDecisionProvider {
    config: DecisionConfig,
    key: String,
    client: reqwest::Client,
}
impl HttpDecisionProvider {
    pub fn new(config: DecisionConfig, key: String) -> Result<Self, String> {
        config.endpoint()?;
        if key.trim().is_empty() { return Err("Decision provider key is missing".into()); }
        let client = reqwest::Client::builder().timeout(Duration::from_secs(8)).redirect(reqwest::redirect::Policy::none()).build().map_err(|_| "Could not create decision client")?;
        Ok(Self { config, key, client })
    }
}
#[async_trait]
impl DecisionProvider for HttpDecisionProvider {
    async fn decide(&self, request: DecisionRequest) -> Result<DecisionResult, String> {
        let (endpoint, model) = self.config.endpoint()?;
        let started = Instant::now();
        let response = self.client.post(endpoint).bearer_auth(self.key.trim()).json(&json!({"model":model, "state":request.state, "questions":request.questions})).send().await.map_err(|_| "Decision request failed or timed out")?;
        if !response.status().is_success() { return Err(format!("Decision provider returned HTTP {}", response.status().as_u16())); }
        // Bound response allocation; errors never echo a provider response body.
        let mut response = response;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "Could not read decision response")? {
            if bytes.len() + chunk.len() > 256 * 1024 { return Err("Decision response too large".into()); }
            bytes.extend_from_slice(&chunk);
        }
        let value = serde_json::from_slice(&bytes).map_err(|_| "Decision provider returned invalid JSON")?;
        let result = normalize_response(value, started.elapsed().as_millis() as u64)?;
        let choice = result.answers["who_replies"]["choice"].as_str().ok_or("Missing decision choice")?;
        if !request.choices.contains_key(choice) { return Err("Decision provider returned an unknown choice".into()); }
        let probabilities = result.answers["who_replies"]["probabilities"].as_object().ok_or("Missing probabilities")?;
        if probabilities.len() != request.choices.len() || request.choices.keys().any(|k| !probabilities.contains_key(k)) { return Err("Decision probabilities do not match eligible choices".into()); }
        Ok(result)
    }
}
pub fn normalize_response(mut value: Value, latency_ms: u64) -> Result<DecisionResult, String> {
    if value.get("success").is_some() {
        if value["success"] != true { return Err("Decision provider reported failure".into()); }
        value = value["result"].take();
    }
    let model = value["model"].as_str().ok_or("Missing decision model")?.to_string();
    let answers = &value["answers"];
    if answers["who_replies"]["choice"].as_str().is_none() { return Err("Missing decision choice".into()); }
    let probabilities = answers["who_replies"]["probabilities"].as_object().ok_or("Missing decision probabilities")?;
    let probability = |v: &Value| v.as_f64().is_some_and(|p| p.is_finite() && (0.0..=1.0).contains(&p));
    if probabilities.is_empty() || probabilities.values().any(|v| !probability(v)) { return Err("Invalid decision probabilities".into()); }
    let sum: f64 = probabilities.values().filter_map(Value::as_f64).sum();
    if (sum - 1.0).abs() > 0.02 { return Err("Decision probabilities must sum to one".into()); }
    for name in ["awaiting_human", "duplicate_reply"] {
        if !probability(&answers[name]["noul"]) { return Err(format!("Invalid {name} answer")); }
    }
    Ok(DecisionResult { model, answers: value["answers"].take(), latency_ms, usage: value["usage"].take() })
}
