//! The bots a phone may put in a talk-only chat. A phone names one of this
//! machine's saved profiles and may change only the name, model, reasoning
//! and Speed. Everything else (backend, API address, key name, persona) is
//! copied from the machine's own profile, so a phone can never aim one of
//! the machine's keys at a server of its choosing.

use apex_core::{Access, Backend, ParticipantConfig, ParticipantId, Speed};
use serde::{Deserialize, Deserializer, Serialize};

/// One bot a phone asks for in `chat_create`, `chat_add_participant` or `chat_import`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChatBotRequest {
    /// A profile id from this machine's `chat_profiles`.
    pub profile: String,
    /// The bot's id in the chat. Defaults to the profile id; a second copy of
    /// one profile needs its own.
    #[serde(default)]
    pub id: Option<ParticipantId>,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub speed: Option<Speed>,
}

/// The settings `chat_update_participant` may change. A missing field keeps
/// its value; `null` puts `model`, `effort` or `speed` back to the default.
/// Any other field, such as `access`, `plan` or `backend`, is refused.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChatBotPatch {
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default, deserialize_with = "present")]
    pub model: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    pub effort: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    pub speed: Option<Option<Speed>>,
}

/// Tells a field set to `null` apart from a missing one.
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}

const MAX_NAME: usize = 64;
const MAX_SETTING: usize = 128;

fn check_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > MAX_NAME || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("`{id}` isn't a usable bot id: use 1 to {MAX_NAME} letters, digits, - or _."));
    }
    Ok(())
}

fn check_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME || name.chars().any(char::is_control) {
        return Err(format!("A bot name needs 1 to {MAX_NAME} characters."));
    }
    Ok(name.to_string())
}

/// Model and reasoning values reach a provider CLI as arguments, so a value
/// that looks like a flag is refused.
fn check_setting(what: &str, value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > MAX_SETTING
        || value.starts_with('-')
        || value.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(format!("`{value}` isn't a usable {what}."));
    }
    Ok(())
}

fn set_model(config: &mut ParticipantConfig, model: Option<String>) -> Result<(), String> {
    if let Some(m) = &model {
        check_setting("model", m)?;
    }
    match &mut config.backend {
        Backend::Agent { model: slot, .. } => *slot = model,
        Backend::OpenAiCompatible { model: slot, .. } => {
            *slot = model.ok_or("This bot needs a model name.")?;
        }
        Backend::Cli { .. } | Backend::Scripted { .. } => {
            if model.is_some() {
                return Err("This bot has no model to choose.".into());
            }
        }
    }
    Ok(())
}

fn set_effort(config: &mut ParticipantConfig, effort: Option<String>) -> Result<(), String> {
    if let Some(e) = &effort {
        check_setting("reasoning level", e)?;
    }
    config.effort = effort;
    Ok(())
}

/// Build a chat bot from `profiles` (this machine's saved list, unredacted).
pub fn resolve(profiles: &[ParticipantConfig], request: ChatBotRequest) -> Result<ParticipantConfig, String> {
    let mut config = profiles
        .iter()
        .find(|p| p.id.as_str() == request.profile)
        .cloned()
        .ok_or_else(|| format!("This machine has no saved bot `{}`.", request.profile))?;
    if let Some(id) = request.id {
        check_id(id.as_str())?;
        config.id = id;
    }
    if let Some(name) = request.display_name {
        config.display_name = check_name(&name)?;
    }
    if request.model.is_some() {
        set_model(&mut config, request.model)?;
    }
    if request.effort.is_some() {
        set_effort(&mut config, request.effort)?;
    }
    if request.speed.is_some() {
        config.speed = request.speed;
    }
    config.access = Access::Read;
    config.media = None;
    Ok(config)
}

/// Apply `patch` to a bot already in a chat. Its backend never changes.
pub fn apply(current: &ParticipantConfig, patch: ChatBotPatch) -> Result<ParticipantConfig, String> {
    let mut next = current.clone();
    if let Some(name) = patch.display_name {
        next.display_name = check_name(&name)?;
    }
    if let Some(model) = patch.model {
        set_model(&mut next, model)?;
    }
    if let Some(effort) = patch.effort {
        set_effort(&mut next, effort)?;
    }
    if let Some(speed) = patch.speed {
        next.speed = speed;
    }
    next.access = Access::Read;
    next.media = None;
    Ok(next)
}

/// A copy safe to send to a phone: no key name, and talk-only settings.
pub fn redacted(mut config: ParticipantConfig) -> ParticipantConfig {
    if let Backend::OpenAiCompatible { ref mut api_key_env, .. } = config.backend {
        *api_key_env = None;
    }
    config.access = Access::Read;
    config.media = None;
    config
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn api_profile() -> ParticipantConfig {
        serde_json::from_value(json!({
            "id": "venice", "display_name": "Venice", "persona": "Be brief.", "access": "full",
            "backend": { "kind": "open_ai_compatible", "base_url": "https://api.venice.ai/api/v1", "model": "qwen", "api_key_env": "VENICE_API_KEY" }
        }))
        .unwrap()
    }

    #[test]
    fn a_phone_cannot_choose_the_backend_address_or_key() {
        // The old shape (a whole bot) and any extra field are refused outright.
        let forged = json!({
            "profile": "venice",
            "backend": { "kind": "open_ai_compatible", "base_url": "https://evil.example", "model": "x", "api_key_env": "VENICE_API_KEY" }
        });
        assert!(serde_json::from_value::<ChatBotRequest>(forged).is_err());
        assert!(serde_json::from_value::<ChatBotRequest>(json!({ "profile": "venice", "access": "full" })).is_err());
        for field in ["access", "plan", "backend", "persona", "base_url", "api_key_env"] {
            assert!(serde_json::from_value::<ChatBotPatch>(json!({ field: "x" })).is_err(), "{field} must be refused");
        }
    }

    #[test]
    fn resolve_copies_the_machine_profile_and_applies_only_overrides() {
        let request: ChatBotRequest = serde_json::from_value(json!({
            "profile": "venice", "id": "venice-2", "display_name": "Venice two", "model": "llama-3.3-70b", "effort": "high", "speed": "fast"
        }))
        .unwrap();
        let bot = resolve(&[api_profile()], request).unwrap();
        assert_eq!(bot.id.as_str(), "venice-2");
        assert_eq!(bot.display_name, "Venice two");
        assert_eq!(bot.persona, "Be brief.");
        assert_eq!(bot.access, Access::Read);
        assert_eq!(bot.effort.as_deref(), Some("high"));
        assert_eq!(bot.speed, Some(Speed::Fast));
        assert_eq!(
            bot.backend,
            Backend::OpenAiCompatible { base_url: "https://api.venice.ai/api/v1".into(), model: "llama-3.3-70b".into(), api_key_env: Some("VENICE_API_KEY".into()) }
        );
    }

    #[test]
    fn resolve_refuses_unknown_profiles_and_flag_like_values() {
        let unknown = ChatBotRequest { profile: "nope".into(), id: None, display_name: None, model: None, effort: None, speed: None };
        assert!(resolve(&[api_profile()], unknown).unwrap_err().contains("no saved bot"));
        for (model, effort, id) in [
            (Some("--dangerously-skip-permissions"), None, None),
            (Some("two words"), None, None),
            (None, Some("-x"), None),
            (None, None, Some("../x")),
        ] {
            let request = ChatBotRequest {
                profile: "venice".into(),
                id: id.map(ParticipantId::new),
                display_name: None,
                model: model.map(str::to_owned),
                effort: effort.map(str::to_owned),
                speed: None,
            };
            assert!(resolve(&[api_profile()], request).is_err());
        }
    }

    #[test]
    fn apply_changes_settings_but_never_the_backend() {
        let current = resolve(&[api_profile()], ChatBotRequest { profile: "venice".into(), id: None, display_name: None, model: None, effort: Some("low".into()), speed: Some(Speed::Fast) }).unwrap();
        let patch: ChatBotPatch = serde_json::from_value(json!({ "model": "deepseek-r1", "effort": null, "speed": null })).unwrap();
        let next = apply(&current, patch).unwrap();
        assert_eq!(next.effort, None);
        assert_eq!(next.speed, None);
        let Backend::OpenAiCompatible { base_url, model, api_key_env } = &next.backend else { panic!() };
        assert_eq!((base_url.as_str(), model.as_str(), api_key_env.as_deref()), ("https://api.venice.ai/api/v1", "deepseek-r1", Some("VENICE_API_KEY")));
        // An API bot always needs a model.
        assert!(apply(&current, serde_json::from_value(json!({ "model": null })).unwrap()).is_err());
        // Leaving a field out keeps it.
        let kept = apply(&current, ChatBotPatch::default()).unwrap();
        assert_eq!(kept, current);
    }

    #[test]
    fn redacted_drops_the_key_name() {
        let Backend::OpenAiCompatible { api_key_env, .. } = redacted(api_profile()).backend else { panic!() };
        assert_eq!(api_key_env, None);
    }
}
