//! Make a picture from a prompt with ChatGPT, Grok or Venice. All three
//! answer OpenAI's `/images/generations` call; the key is read from an
//! environment variable, as API bots do, and never stored.

use base64::Engine;
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Debug, PartialEq)]
pub struct Provider {
    pub label: &'static str,
    pub url: &'static str,
    pub key_env: &'static str,
    pub model: &'static str,
    /// gpt-image models always answer with the bytes and reject the field.
    pub asks_for_bytes: bool,
}

/// The providers `/image` knows, by the names people type.
pub fn provider(name: &str) -> Option<Provider> {
    Some(match name.to_lowercase().as_str() {
        "chatgpt" | "openai" | "gpt" => Provider { label: "ChatGPT", url: "https://api.openai.com/v1/images/generations", key_env: "OPENAI_API_KEY", model: "gpt-image-1", asks_for_bytes: false },
        "grok" | "xai" => Provider { label: "Grok", url: "https://api.x.ai/v1/images/generations", key_env: "XAI_API_KEY", model: "grok-2-image", asks_for_bytes: true },
        "venice" => Provider { label: "Venice", url: "https://api.venice.ai/api/v1/images/generations", key_env: "VENICE_API_KEY", model: "venice-sd35", asks_for_bytes: true },
        _ => return None,
    })
}

pub fn request_body(provider: &Provider, model: Option<&str>, prompt: &str) -> Value {
    let mut body = json!({ "model": model.unwrap_or(provider.model), "prompt": prompt, "n": 1 });
    if provider.asks_for_bytes {
        body["response_format"] = json!("b64_json");
    }
    body
}

#[derive(Debug, PartialEq)]
pub enum Picture {
    Bytes(Vec<u8>),
    Url(String),
}

/// The first picture in a reply, or the server's own error message.
pub fn picture_from(reply: &Value) -> Result<Picture, String> {
    if let Some(message) = reply.pointer("/error/message").and_then(Value::as_str).or_else(|| reply.get("error").and_then(Value::as_str)) {
        return Err(message.to_string());
    }
    let first = reply.pointer("/data/0").ok_or("the reply had no picture in it")?;
    if let Some(b64) = first.get("b64_json").and_then(Value::as_str) {
        return base64::engine::general_purpose::STANDARD.decode(b64).map(Picture::Bytes).map_err(|e| format!("the picture could not be read: {e}"));
    }
    first.get("url").and_then(Value::as_str).map(|u| Picture::Url(u.to_string())).ok_or_else(|| "the reply had no picture in it".into())
}

/// Ask the provider for a picture and return its bytes.
pub async fn generate(provider: &Provider, model: Option<&str>, prompt: &str) -> Result<Vec<u8>, String> {
    let key = apex_adapters::keys::lookup(provider.key_env)
        .ok_or_else(|| format!("{} needs an API key. Add {} in Settings → Providers → API keys.", provider.label, provider.key_env))?;
    let client = reqwest::Client::builder().timeout(Duration::from_secs(180)).build().map_err(|e| e.to_string())?;
    let response = client.post(provider.url).bearer_auth(&key).json(&request_body(provider, model, prompt)).send().await
        .map_err(|e| format!("Could not reach {}: {e}", provider.label))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    let reply: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    match picture_from(&reply) {
        Ok(Picture::Bytes(bytes)) if status.is_success() => Ok(bytes),
        Ok(Picture::Url(url)) if status.is_success() => {
            let fetched = client.get(&url).send().await.and_then(|r| r.error_for_status()).map_err(|e| format!("Could not download the picture: {e}"))?;
            Ok(fetched.bytes().await.map_err(|e| e.to_string())?.to_vec())
        }
        Err(message) => Err(format!("{} said: {message}", provider.label)),
        _ => Err(format!("{} answered {status}: {}", provider.label, text.chars().take(300).collect::<String>())),
    }
}

/// The file extension the bytes call for, from their first few bytes.
pub fn extension(bytes: &[u8]) -> &'static str {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => "png",
        [0xFF, 0xD8, ..] => "jpg",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "webp",
        [b'G', b'I', b'F', ..] => "gif",
        _ => "png",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn providers_go_by_the_names_people_type() {
        assert_eq!(provider("ChatGPT").unwrap().key_env, "OPENAI_API_KEY");
        assert_eq!(provider("openai").unwrap().label, "ChatGPT");
        assert_eq!(provider("grok").unwrap().key_env, "XAI_API_KEY");
        assert_eq!(provider("venice").unwrap().key_env, "VENICE_API_KEY");
        assert!(provider("midjourney").is_none());
    }

    #[test]
    fn only_providers_that_accept_it_are_asked_for_bytes() {
        let openai = request_body(&provider("chatgpt").unwrap(), None, "an apple");
        assert_eq!(openai, json!({ "model": "gpt-image-1", "prompt": "an apple", "n": 1 }));
        let grok = request_body(&provider("grok").unwrap(), Some("grok-imagine"), "an apple");
        assert_eq!(grok, json!({ "model": "grok-imagine", "prompt": "an apple", "n": 1, "response_format": "b64_json" }));
    }

    #[test]
    fn pictures_come_as_bytes_or_an_address() {
        assert_eq!(picture_from(&json!({ "data": [{ "b64_json": "iVBORw==" }] })), Ok(Picture::Bytes(vec![0x89, b'P', b'N', b'G'])));
        assert_eq!(picture_from(&json!({ "data": [{ "url": "https://x/y.png" }] })), Ok(Picture::Url("https://x/y.png".into())));
        assert_eq!(picture_from(&json!({ "error": { "message": "bad key" } })), Err("bad key".into()));
        assert_eq!(picture_from(&json!({ "error": "bad key" })), Err("bad key".into()));
        assert!(picture_from(&json!({ "data": [] })).is_err());
    }

    #[test]
    fn extension_follows_the_bytes() {
        assert_eq!(extension(&[0x89, b'P', b'N', b'G', 0]), "png");
        assert_eq!(extension(&[0xFF, 0xD8, 0xFF]), "jpg");
        assert_eq!(extension(b"RIFF\0\0\0\0WEBPVP8"), "webp");
    }
}
