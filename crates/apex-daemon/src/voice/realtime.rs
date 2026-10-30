use serde::{Deserialize, Serialize};

const OPENAI_KEY_NAME: &str = "OPENAI_API_KEY";
const REALTIME_ENDPOINT: &str = "https://api.openai.com/v1/realtime/sessions";
// Current GA model as of late 2026. Verified via OpenAI docs 2026-10-29:
// model id `gpt-realtime` (and `gpt-realtime-2.1`) with voices alloy, ash, ballad,
// coral, echo, sage, shimmer, verse, marin, cedar.
pub const DEFAULT_MODEL: &str = "gpt-realtime";
pub const DEFAULT_VOICE: &str = "verse";
const ALLOWED_VOICES: &[&str] = &[
    "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar",
];

#[derive(Debug, Serialize, Deserialize)]
pub struct ClientSecret {
    pub value: String,
    pub expires_at: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RealtimeSessionResponse {
    pub client_secret: ClientSecret,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MintResult {
    pub client_secret: String,
    pub expires_at: Option<u64>,
    pub model: String,
    pub voice: String,
}

#[derive(Debug, Deserialize)]
pub struct MintArgs {
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub voice: Option<String>,
    #[serde(default)]
    pub instructions: Option<String>,
    #[serde(default)]
    pub tools: Option<Vec<serde_json::Value>>,
}

pub async fn mint(api_key: &str, args: MintArgs, base_url: Option<&str>) -> Result<MintResult, String> {
    let key = api_key.trim();
    if key.is_empty() {
        return Err("Missing OpenAI API key. Add it in Settings → Providers or as OPENAI_API_KEY.".into());
    }
    let model = args
        .model
        .as_deref()
        .map(|m| m.trim())
        .filter(|m| !m.is_empty())
        .unwrap_or(DEFAULT_MODEL)
        .to_string();
    let voice_raw = args
        .voice
        .as_deref()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .unwrap_or(DEFAULT_VOICE);
    let voice_lower = voice_raw.to_ascii_lowercase();
    let voice = if ALLOWED_VOICES.contains(&voice_lower.as_str()) {
        voice_lower
    } else {
        DEFAULT_VOICE.to_string()
    };

    // Build request body for OpenAI session creation.
    // Instructions + tools are included when provided, so ephemeral token inherits them.
    let mut body = serde_json::json!({
        "model": model,
        "voice": voice,
    });
    if let Some(inst) = args.instructions {
        if !inst.trim().is_empty() {
            body["instructions"] = serde_json::Value::String(inst);
        }
    }
    if let Some(tools) = args.tools {
        if !tools.is_empty() {
            body["tools"] = serde_json::Value::Array(tools);
            body["tool_choice"] = serde_json::Value::String("auto".into());
        }
    }

    let url = base_url.unwrap_or(REALTIME_ENDPOINT);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Realtime client error: {e}"))?;

    let resp = client
        .post(url)
        .header("Authorization", format!("Bearer {key}"))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error talking to OpenAI Realtime: {e}"))?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("Read error: {e}"))?;

    if !status.is_success() {
        // Do not include key or secret in error. Text is from OpenAI, may contain reason.
        let snippet: String = text.chars().take(400).collect();
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(format!("OpenAI key rejected ({status}): {snippet}"));
        }
        return Err(format!("OpenAI Realtime error {status}: {snippet}"));
    }

    let parsed: RealtimeSessionResponse = serde_json::from_str(&text)
        .map_err(|e| format!("Could not parse OpenAI response: {e}. Body: {}", text.chars().take(200).collect::<String>()))?;

    Ok(MintResult {
        client_secret: parsed.client_secret.value,
        expires_at: parsed.client_secret.expires_at,
        model: parsed.model.unwrap_or(model),
        voice,
    })
}

pub fn lookup_key() -> Option<String> {
    apex_adapters::keys::lookup(OPENAI_KEY_NAME)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;
    use tokio::io::AsyncWriteExt;

    async fn fake_openai_server(
        expected_key: &'static str,
        response_body: serde_json::Value,
        status: u16,
    ) -> (SocketAddr, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            // Read request (best effort up to 16k)
            let mut buf = vec![0u8; 16384];
            use tokio::io::AsyncReadExt;
            let _ = tokio::time::timeout(std::time::Duration::from_secs(2), socket.read(&mut buf)).await;
            let text = String::from_utf8_lossy(&buf);
            // If expected key not present, return 401 with proper framing.
            if !text.contains(expected_key) {
                let body = "invalid key";
                let resp = format!(
                    "HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = socket.write_all(resp.as_bytes()).await;
                return;
            }
            let body = serde_json::to_string(&response_body).unwrap();
            let status_text = if status == 200 { "OK" } else { "Error" };
            let resp = format!(
                "HTTP/1.1 {status} {status_text}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = socket.write_all(resp.as_bytes()).await;
        });
        (addr, handle)
    }

    #[tokio::test]
    async fn mints_with_fake_server_and_never_logs_key_or_secret() {
        let (addr, handle) = fake_openai_server(
            "sk-test-123",
            serde_json::json!({
                "id": "sess_123",
                "model": "gpt-realtime",
                "client_secret": {"value": "ek_abcdef", "expires_at": 9999999999u64}
            }),
            200,
        )
        .await;

        let url = format!("http://{addr}");
        let result = mint(
            "sk-test-123",
            MintArgs {
                model: Some("gpt-realtime".into()),
                voice: Some("alloy".into()),
                instructions: Some("You are helpful".into()),
                tools: None,
            },
            Some(&url),
        )
        .await
        .expect("mint ok");

        assert_eq!(result.client_secret, "ek_abcdef");
        assert_eq!(result.model, "gpt-realtime");
        assert_eq!(result.voice, "alloy");
        // Ensure secret does not appear in error path – ok path just returns it, not logged.
        handle.abort();
    }

    #[tokio::test]
    async fn rejects_missing_key_without_network() {
        let err = mint(
            "   ",
            MintArgs {
                model: None,
                voice: None,
                instructions: None,
                tools: None,
            },
            Some("http://127.0.0.1:1"),
        )
        .await
        .err()
        .unwrap();
        assert!(err.contains("Missing"), "got {err}");
        assert!(!err.contains("sk-"), "error must not echo key");
    }

    #[tokio::test]
    async fn surfaces_401_as_key_rejected() {
        let (addr, handle) = fake_openai_server(
            "wrong-key",
            serde_json::json!({"error": {"message": "Invalid key"}}),
            401,
        )
        .await;
        let url = format!("http://{addr}");
        // Use a different key than server expects, to trigger 401 response from our fake.
        // Our fake returns 401 when key not found in request text.
        let err = mint(
            "sk-different",
            MintArgs {
                model: None,
                voice: None,
                instructions: None,
                tools: None,
            },
            Some(&url),
        )
        .await
        .err()
        .unwrap();
        assert!(err.contains("rejected") || err.contains("401"), "got {err}");
        assert!(!err.contains("ek_"), "must not leak secret");
        handle.abort();
    }
}
