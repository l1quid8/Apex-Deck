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
    /// What the model makes. Text models chat; image and video models turn
    /// each message into a picture or a clip (`media.rs`).
    #[serde(default, skip_serializing_if = "ModelKind::is_text")]
    pub kind: ModelKind,
    /// The settings an image or video model takes and what it costs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media: Option<MediaSpec>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ModelKind {
    #[default]
    Text,
    Image,
    Video,
}

impl ModelKind {
    fn is_text(&self) -> bool {
        *self == ModelKind::Text
    }
}

/// What an image or video model lets you choose, from Venice's
/// `model_spec.constraints`, and its listed prices. Empty lists mean the
/// setting isn't offered, and it is then never sent: Venice rejects
/// fields a model doesn't take.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct MediaSpec {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aspect_ratios: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_aspect_ratio: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub resolutions: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_resolution: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub qualities: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_quality: Option<String>,
    /// Video lengths such as "5s".
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub durations: Vec<String>,
    /// The clip can have sound, and whether it can be switched off.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub audio: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub audio_configurable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_limit: Option<usize>,
    /// Pictures: US dollars each, when one price fits every setting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub price: Option<f64>,
    /// Pictures: US dollars each by "1K" or by "1K/low" (resolution/quality).
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub prices: HashMap<String, f64>,
    /// Pictures: the model that edits an attached picture, and its price.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edit_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edit_price: Option<f64>,
    /// Video: the sibling that animates an attached picture.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_model: Option<String>,
    /// Video: this model only animates a picture, so one must be attached.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub needs_image: bool,
}

/// Read the `data` list of a `/models` response, sorted by id with duplicates removed.
pub fn parse_models(body: &Value) -> Vec<ApiModel> {
    let items = body["data"].as_array().map(Vec::as_slice).unwrap_or_default();
    let mut models: Vec<ApiModel> = items.iter().filter_map(parse_entry).collect();
    link_media_siblings(&mut models, items);
    models.sort_by(|a, b| a.id.cmp(&b.id));
    models.dedup_by(|a, b| a.id == b.id);
    models
}

/// Venice lists picture editing and picture-to-video as separate models
/// ("flux-2-max-edit", "seedance-2-5-image-to-video-basic"). Each is tied
/// to the model people pick, which uses it when a picture is attached.
/// Picture-to-video models with a text sibling are left out of the list.
fn link_media_siblings(models: &mut Vec<ApiModel>, items: &[Value]) {
    let edits: HashMap<&str, Option<f64>> = items
        .iter()
        .filter(|item| item["type"] == "inpaint")
        .filter_map(|item| Some((item["id"].as_str()?, venice_price(&item["model_spec"]["pricing"]["inpaint"]))))
        .collect();
    let ids: std::collections::HashSet<String> = models.iter().map(|m| m.id.clone()).collect();
    let mut animated = std::collections::HashSet::new();
    for model in models.iter_mut() {
        let id = model.id.clone();
        let Some(media) = model.media.as_mut() else { continue };
        match model.kind {
            ModelKind::Image => {
                if let Some((edit, price)) = edits.get_key_value(format!("{id}-edit").as_str()) {
                    media.edit_model = Some(edit.to_string());
                    media.edit_price = *price;
                }
            }
            ModelKind::Video if id.contains("text-to-video") => {
                let sibling = id.replace("text-to-video", "image-to-video");
                if ids.contains(&sibling) {
                    media.image_model = Some(sibling.clone());
                    animated.insert(sibling);
                }
            }
            _ => {}
        }
    }
    models.retain(|m| !animated.contains(&m.id));
}

/// Read one entry, trying the Venice shape first and then the OpenRouter and Groq shapes.
fn parse_entry(item: &Value) -> Option<ApiModel> {
    let id = item["id"].as_str()?.to_string();
    let spec = &item["model_spec"];
    let kind = match item["type"].as_str() {
        None | Some("text") => ModelKind::Text,
        Some("image") => ModelKind::Image,
        // Only clips made from words or a picture; upscalers and the like
        // need a video to start from.
        Some("video") if matches!(spec["constraints"]["model_type"].as_str(), Some("text-to-video" | "image-to-video")) => ModelKind::Video,
        _ => return None,
    };
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
        media: match kind {
            ModelKind::Text => None,
            ModelKind::Image => Some(image_spec(spec)),
            ModelKind::Video => Some(video_spec(spec)),
        },
        kind,
    })
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect()
}

fn text(value: &Value) -> Option<String> {
    value.as_str().filter(|s| !s.is_empty()).map(str::to_string)
}

fn image_spec(spec: &Value) -> MediaSpec {
    let limits = &spec["constraints"];
    let pricing = &spec["pricing"];
    let mut prices = HashMap::new();
    for (resolution, price) in pricing["resolutions"].as_object().into_iter().flatten() {
        if let Some(usd) = venice_price(price) {
            prices.insert(resolution.clone(), usd);
        }
    }
    for (resolution, levels) in pricing["quality"].as_object().into_iter().flatten() {
        for (quality, price) in levels.as_object().into_iter().flatten() {
            if let Some(usd) = venice_price(price) {
                prices.insert(format!("{resolution}/{quality}"), usd);
            }
        }
    }
    MediaSpec {
        aspect_ratios: strings(&limits["aspectRatios"]),
        default_aspect_ratio: text(&limits["defaultAspectRatio"]),
        resolutions: strings(&limits["resolutions"]),
        default_resolution: text(&limits["defaultResolution"]),
        qualities: strings(&limits["qualities"]),
        default_quality: text(&limits["defaultQuality"]),
        prompt_limit: limits["promptCharacterLimit"].as_u64().map(|n| n as usize),
        price: venice_price(&pricing["generation"]),
        prices,
        ..MediaSpec::default()
    }
}

fn video_spec(spec: &Value) -> MediaSpec {
    let limits = &spec["constraints"];
    MediaSpec {
        aspect_ratios: strings(&limits["aspect_ratios"]),
        resolutions: strings(&limits["resolutions"]),
        durations: strings(&limits["durations"]),
        audio: limits["audio"].as_bool().unwrap_or(false),
        audio_configurable: limits["audio_configurable"].as_bool().unwrap_or(false),
        prompt_limit: limits["prompt_character_limit"].as_u64().map(|n| n as usize),
        needs_image: limits["model_type"] == "image-to-video",
        ..MediaSpec::default()
    }
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

    // Venice lists only text models unless asked for every kind; the
    // others ignore the parameter.
    let url = if is_venice(base) { format!("{base}/models?type=all") } else { format!("{base}/models") };
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

/// Whether `base_url` is Venice's API, the one provider with image and
/// video models wired up so far.
pub fn is_venice(base_url: &str) -> bool {
    reqwest::Url::parse(base_url).ok().and_then(|url| url.host_str().map(str::to_lowercase)).as_deref() == Some("api.venice.ai")
}

/// One model by id, or None if the lookup fails or the server doesn't list it.
pub async fn model(base_url: &str, api_key_env: Option<&str>, id: &str) -> Option<ApiModel> {
    models(base_url, api_key_env).await.ok()?.into_iter().find(|model| model.id == id)
}

/// What kind of model `id` is, from the last list fetched, however old.
/// None until the list has been fetched once. For decisions that can't
/// wait for the network, such as who a message goes to.
pub fn cached_kind(base_url: &str, id: &str) -> Option<ModelKind> {
    let cache = CACHE.get()?.lock().unwrap();
    cache.get(base_url.trim_end_matches('/'))?.1.iter().find(|model| model.id == id).map(|model| model.kind)
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
            { "id": "music-model", "type": "music" },
            { "id": "upscaler", "type": "video", "model_spec": { "constraints": { "model_type": "video" } } },
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

    fn venice_media() -> Value {
        json!({ "data": [
            {"id":"flux-2-max","type":"image","model_spec":{"name":"Flux 2 Max","pricing":{"generation":{"usd":0.07}},"constraints":{"promptCharacterLimit":3000,"aspectRatios":["1:1","16:9"],"defaultAspectRatio":"1:1"}}},
            {"id":"flux-2-max-edit","type":"inpaint","model_spec":{"pricing":{"inpaint":{"usd":0.08}}}},
            {"id":"grok-imagine-image-2-0","type":"image","model_spec":{"name":"Grok Imagine 2.0","pricing":{"resolutions":{"1K":{"usd":0.07},"2K":{"usd":0.1}},"quality":{"1K":{"low":{"usd":0.05}}}},"constraints":{"defaultResolution":"1K","resolutions":["1K","2K"],"defaultQuality":"medium","qualities":["low","medium"]}}},
            {"id":"seedance-2-5-us-text-to-video-private","type":"video","model_spec":{"name":"Seedance 2.5 US","constraints":{"model_type":"text-to-video","aspect_ratios":["auto","16:9","9:16"],"resolutions":["480p","720p","1080p"],"durations":["4s","5s","6s"],"audio":true,"audio_configurable":true,"prompt_character_limit":15000}}},
            {"id":"seedance-2-5-us-image-to-video-private","type":"video","model_spec":{"name":"Seedance 2.5 US","constraints":{"model_type":"image-to-video","aspect_ratios":["16:9"],"resolutions":["720p"],"durations":["5s"],"audio":true,"audio_configurable":true}}},
            {"id":"wan-2-5-image-to-video","type":"video","model_spec":{"name":"Wan 2.5","constraints":{"model_type":"image-to-video","aspect_ratios":[],"resolutions":["720p"],"durations":["5s"],"audio":false,"audio_configurable":false}}}
        ] })
    }

    #[test]
    fn image_models_carry_their_choices_prices_and_edit_sibling() {
        let models = parse_models(&venice_media());
        let flux = models.iter().find(|m| m.id == "flux-2-max").unwrap();
        assert_eq!(flux.kind, ModelKind::Image);
        assert_eq!(flux.label.as_deref(), Some("Flux 2 Max"));
        let media = flux.media.as_ref().unwrap();
        assert_eq!(media.aspect_ratios, ["1:1", "16:9"]);
        assert_eq!(media.default_aspect_ratio.as_deref(), Some("1:1"));
        assert_eq!(media.price, Some(0.07));
        assert_eq!(media.prompt_limit, Some(3000));
        assert_eq!(media.edit_model.as_deref(), Some("flux-2-max-edit"));
        assert_eq!(media.edit_price, Some(0.08));
        let grok = models.iter().find(|m| m.id == "grok-imagine-image-2-0").unwrap().media.clone().unwrap();
        assert_eq!(grok.prices.get("2K"), Some(&0.1));
        assert_eq!(grok.prices.get("1K/low"), Some(&0.05));
        assert_eq!(grok.qualities, ["low", "medium"]);
        assert_eq!(grok.edit_model, None);
        assert!(!models.iter().any(|m| m.id.ends_with("-edit")), "edit models are used through their sibling");
    }

    #[test]
    fn video_models_carry_their_choices_and_picture_sibling() {
        let models = parse_models(&venice_media());
        let seedance = models.iter().find(|m| m.id == "seedance-2-5-us-text-to-video-private").unwrap();
        assert_eq!(seedance.kind, ModelKind::Video);
        let media = seedance.media.as_ref().unwrap();
        assert_eq!(media.durations, ["4s", "5s", "6s"]);
        assert_eq!(media.resolutions, ["480p", "720p", "1080p"]);
        assert!(media.audio && media.audio_configurable);
        assert_eq!(media.prompt_limit, Some(15000));
        assert_eq!(media.image_model.as_deref(), Some("seedance-2-5-us-image-to-video-private"));
        assert!(!media.needs_image);
        assert!(!models.iter().any(|m| m.id == "seedance-2-5-us-image-to-video-private"), "a picture sibling is not listed on its own");
        let wan = models.iter().find(|m| m.id == "wan-2-5-image-to-video").unwrap().media.clone().unwrap();
        assert!(wan.needs_image, "a picture-only model with no text sibling stays, marked as needing a picture");
    }

    #[test]
    fn text_models_serialize_without_kind_or_media() {
        let value = serde_json::to_value(&parse_models(&json!({ "data": [venice_glm()] }))[0]).unwrap();
        assert!(value.get("kind").is_none() && value.get("media").is_none());
        let video = serde_json::to_value(parse_models(&venice_media()).iter().find(|m| m.kind == ModelKind::Video).unwrap()).unwrap();
        assert_eq!(video["kind"], "video");
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
