//! Gateway routing for the shared Responses translator.
use super::*;
pub(super) use apex_adapters::responses::{request, accounting, completion, Stream};

pub(super) fn applies(target: &ResolvedTarget, base_url: &str) -> bool {
    target.canonical_model.starts_with("openai/")
        || base_url.trim_end_matches('/') == "https://api.openai.com/v1"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routing_leaves_other_providers_unchanged() {
        let dir = std::env::temp_dir();
        let openai = resolve_model_target(&dir, "openai/gpt-6.1-sol", None).unwrap();
        assert!(applies(&openai, "https://api.openai.com/v1"));
        let other = resolve_model_target(&dir, "openrouter/openai/gpt-6.1-sol", None).unwrap();
        assert!(!applies(&other, "https://openrouter.ai/api/v1"));
        assert!(!applies(&other, "https://api.openai.com.evil/v1"));
        assert!(applies(&other, "https://api.openai.com/v1/"));
    }

}
