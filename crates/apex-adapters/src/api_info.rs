use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One model an OpenAI-compatible server offers, with what it says about it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct ApiModel {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Reasoning levels the model accepts. None = not known; Some(empty) = no reasoning setting.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub efforts: Option<Vec<String>>,
    /// The level the server uses when none is sent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_tokens: Option<u64>,
    /// US dollars per million tokens.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price_in: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price_cached_in: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price_out: Option<f64>,
}

/// Read the `data` list of a `/models` response, sorted by id with duplicates removed.
pub fn parse_models(body: &Value) -> Vec<ApiModel> {
    let mut models: Vec<ApiModel> = body["data"]
        .as_array()
        .map(|items| items.iter().filter_map(parse_entry).collect())
        .unwrap_or_default();
    models.sort_by(|a, b| a.id.cmp(&b.id));
    models.dedup_by(|a, b| a.id == b.id);
    models
}

/// Read one entry, trying the Venice shape first and then the OpenRouter and Groq shapes.
fn parse_entry(item: &Value) -> Option<ApiModel> {
    let id = item["id"].as_str()?.to_string();
    if item["type"].as_str().is_some_and(|kind| kind != "text") {
        return None;
    }
    let spec = &item["model_spec"];
    let capabilities = &spec["capabilities"];
    let label = [spec["name"].as_str(), item["name"].as_str()]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|name| !name.is_empty() && *name != id)
        .map(str::to_string);
    let efforts = if capabilities["supportsReasoningEffort"].as_bool() == Some(false) {
        Some(Vec::new())
    } else {
        capabilities["reasoningEffortOptions"]
            .as_array()
            .and_then(|levels| levels.iter().map(Value::as_str).map(|level| level.map(str::to_string)).collect())
    };
    Some(ApiModel {
        id,
        label,
        efforts,
        default_effort: capabilities["defaultReasoningEffort"].as_str().filter(|s| !s.is_empty()).map(str::to_string),
        context_tokens: [item["context_length"].as_u64(), spec["availableContextTokens"].as_u64(), item["context_window"].as_u64()]
            .into_iter()
            .flatten()
            .find(|tokens| *tokens > 0),
        price_in: venice_price(&spec["pricing"]["input"]).or_else(|| per_token_price(&item["pricing"]["prompt"])),
        price_cached_in: venice_price(&spec["pricing"]["cache_input"]).or_else(|| per_token_price(&item["pricing"]["input_cache_read"])),
        price_out: venice_price(&spec["pricing"]["output"]).or_else(|| per_token_price(&item["pricing"]["completion"])),
    })
}

/// Venice already quotes dollars per million tokens. Negative values mean "not priced".
fn venice_price(value: &Value) -> Option<f64> {
    value["usd"].as_f64().filter(|price| *price >= 0.0)
}

/// OpenRouter quotes dollars per single token as a string. "-1" means variable.
fn per_token_price(value: &Value) -> Option<f64> {
    let per_token: f64 = value.as_str()?.trim().parse().ok()?;
    (per_token >= 0.0).then_some(per_token * 1_000_000.0)
}

type Cache = Mutex<HashMap<String, (Instant, Vec<ApiModel>)>>;

static CACHE: OnceLock<Cache> = OnceLock::new();

const CACHE_FOR: Duration = Duration::from_secs(600);

/// The models a server offers, from its `/models` endpoint. Successful
/// answers are kept for ten minutes per base URL.
pub async fn models(base_url: &str, api_key_env: Option<&str>) -> Result<Vec<ApiModel>, String> {
    let base = base_url.trim_end_matches('/');
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let cached = cache
        .lock()
        .unwrap()
        .get(base)
        .filter(|(at, _)| at.elapsed() < CACHE_FOR)
        .map(|(_, models)| models.clone());
    if let Some(models) = cached {
        return Ok(models);
    }

    let url = format!("{base}/models");
    let mut call = reqwest::Client::new().get(&url).timeout(Duration::from_secs(8));
    // The list is often public, so a missing key isn't an error here.
    if let Some(key) = api_key_env.filter(|n| !n.is_empty()).and_then(crate::keys::lookup) {
        call = call.bearer_auth(key);
    }
    let response = call.send().await.map_err(|e| format!("could not reach {url}: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("{url} returned {status}"));
    }
    let body: Value =
        response.json().await.map_err(|e| format!("{url} did not return a model list: {e}"))?;
    let models = parse_models(&body);
    cache.lock().unwrap().insert(base.to_string(), (Instant::now(), models.clone()));
    Ok(models)
}

/// One model by id, or None if the lookup fails or the server doesn't list it.
pub async fn model(base_url: &str, api_key_env: Option<&str>, id: &str) -> Option<ApiModel> {
    models(base_url, api_key_env).await.ok()?.into_iter().find(|model| model.id == id)
}

/// The remaining account balance in US dollars, for the providers that
/// report one. None when there is no key, no balance API, or no answer.
pub async fn balance(base_url: &str, api_key_env: Option<&str>) -> Result<Option<f64>, String> {
    let Some(key) = api_key_env.filter(|n| !n.is_empty()).and_then(crate::keys::lookup) else {
        return Ok(None);
    };
    let host = reqwest::Url::parse(base_url).ok().and_then(|url| url.host_str().map(str::to_lowercase));
    let (path, read): (&str, fn(&Value) -> Option<f64>) = match host.as_deref() {
        Some("api.venice.ai") => ("api_keys/rate_limits", parse_venice_balance),
        Some("openrouter.ai") => ("credits", parse_openrouter_balance),
        _ => return Ok(None),
    };
    let url = format!("{}/{path}", base_url.trim_end_matches('/'));
    let response = reqwest::Client::new()
        .get(&url)
        .bearer_auth(key)
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .map_err(|e| format!("could not reach {url}: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("{url} returned {status}"));
    }
    let body: Value =
        response.json().await.map_err(|e| format!("{url} did not return a balance: {e}"))?;
    Ok(read(&body))
}

/// Venice's rate limit answer carries the USD balance under `data.balances`.
pub fn parse_venice_balance(body: &Value) -> Option<f64> {
    body["data"]["balances"]["USD"].as_f64()
}

/// OpenRouter reports total credits bought and total used.
pub fn parse_openrouter_balance(body: &Value) -> Option<f64> {
    Some(body["data"]["total_credits"].as_f64()? - body["data"]["total_usage"].as_f64()?)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn venice_glm() -> Value {
        json!({"context_length":1000000,"id":"zai-org-glm-5-2","model_spec":{"pricing":{"input":{"usd":1.4},"cache_input":{"usd":0.26},"output":{"usd":4.4}},"availableContextTokens":1000000,"capabilities":{"supportsReasoning":true,"supportsReasoningEffort":true,"reasoningEffortOptions":["none","high","max"],"defaultReasoningEffort":"max"},"name":"GLM 5.2"},"object":"model","type":"text"})
    }

    #[test]
    fn a_venice_entry_gives_label_levels_context_and_prices() {
        let models = parse_models(&json!({ "data": [venice_glm()] }));
        assert_eq!(models.len(), 1);
        let model = &models[0];
        assert_eq!(model.id, "zai-org-glm-5-2");
        assert_eq!(model.label.as_deref(), Some("GLM 5.2"));
        assert_eq!(model.efforts, Some(vec!["none".to_string(), "high".into(), "max".into()]));
        assert_eq!(model.default_effort.as_deref(), Some("max"));
        assert_eq!(model.context_tokens, Some(1_000_000));
        assert_eq!(model.price_in, Some(1.4));
        assert_eq!(model.price_cached_in, Some(0.26));
        assert_eq!(model.price_out, Some(4.4));
    }

    #[test]
    fn an_openrouter_entry_turns_per_token_strings_into_per_million_prices() {
        let body = json!({ "data": [{
            "id": "openai/gpt-4o",
            "name": "OpenAI: GPT-4o",
            "context_length": 128000,
            "pricing": { "prompt": "0.0000025", "completion": "0.00001", "input_cache_read": "-1" }
        }] });
        let model = &parse_models(&body)[0];
        assert_eq!(model.label.as_deref(), Some("OpenAI: GPT-4o"));
        assert_eq!(model.context_tokens, Some(128_000));
        assert!((model.price_in.unwrap() - 2.5).abs() < 1e-9);
        assert!((model.price_out.unwrap() - 10.0).abs() < 1e-9);
        assert_eq!(model.price_cached_in, None);
        assert_eq!(model.efforts, None);
    }

    #[test]
    fn a_venice_model_without_reasoning_effort_has_no_levels() {
        let body = json!({ "data": [{
            "id": "plain",
            "model_spec": { "capabilities": { "supportsReasoningEffort": false, "reasoningEffortOptions": ["low"] } }
        }] });
        assert_eq!(parse_models(&body)[0].efforts, Some(Vec::new()));
    }

    #[test]
    fn entries_without_an_id_or_of_another_type_are_skipped_and_the_rest_sorted() {
        let body = json!({ "data": [
            { "id": "zeta" },
            { "object": "model" },
            { "id": "image-model", "type": "image" },
            { "id": "alpha", "type": "text" },
            { "id": "alpha", "type": "text" }
        ] });
        let ids: Vec<String> = parse_models(&body).into_iter().map(|m| m.id).collect();
        assert_eq!(ids, ["alpha", "zeta"]);
    }

    #[test]
    fn a_label_equal_to_the_id_is_dropped_and_a_context_of_zero_is_ignored() {
        let body = json!({ "data": [{ "id": "llama3", "name": "llama3", "context_length": 0, "context_window": 8192 }] });
        let model = &parse_models(&body)[0];
        assert_eq!(model.label, None);
        assert_eq!(model.context_tokens, Some(8192));
    }

    #[test]
    fn venice_balance_is_the_usd_figure() {
        let body = json!({"data":{"accessPermitted":true,"balances":{"USD":6.35657664,"DIEM":0}}});
        assert_eq!(parse_venice_balance(&body), Some(6.35657664));
        assert_eq!(parse_venice_balance(&json!({"data":{}})), None);
    }

    #[test]
    fn openrouter_balance_is_credits_minus_usage() {
        let body = json!({"data":{"total_credits":20.0,"total_usage":3.5}});
        assert_eq!(parse_openrouter_balance(&body), Some(16.5));
        assert_eq!(parse_openrouter_balance(&json!({"data":{"total_credits":20.0}})), None);
    }
}
