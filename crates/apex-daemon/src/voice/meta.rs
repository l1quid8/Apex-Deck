use serde::{Deserialize, Serialize};

const META_KEY_NAME: &str = "META_API_KEY";
pub const DEFAULT_MODEL: &str = "muse-voice-transcribe-1.0";

#[derive(Debug, Serialize, Deserialize)]
pub struct MintResult {
    pub token: String,
    pub model: String,
}

#[derive(Debug, Deserialize)]
pub struct MintArgs {
    #[serde(default)]
    pub model: Option<String>,
}

pub async fn mint(api_key: &str, args: MintArgs) -> Result<MintResult, String> {
    let key = api_key.trim();
    if key.is_empty() {
        return Err(
            "Missing Meta API key. Add it in Settings → Providers or as META_API_KEY.".into(),
        );
    }
    let model = args
        .model
        .as_deref()
        .map(|m| m.trim())
        .filter(|m| !m.is_empty())
        .unwrap_or(DEFAULT_MODEL)
        .to_string();

    Ok(MintResult {
        token: key.to_string(),
        model,
    })
}

pub fn lookup_key() -> Option<String> {
    apex_adapters::keys::lookup(META_KEY_NAME)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mints_with_valid_key() {
        let result = mint("test_key_123", MintArgs { model: None })
            .await
            .expect("mint ok");
        assert_eq!(result.token, "test_key_123");
        assert_eq!(result.model, DEFAULT_MODEL);
    }

    #[tokio::test]
    async fn rejects_missing_key() {
        let err = mint("   ", MintArgs { model: None }).await.err().unwrap();
        assert!(err.contains("Missing"));
        assert!(!err.contains("test_key"));
    }
}
