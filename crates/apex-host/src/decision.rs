//! Optional background observation, shared by the daemon and desktop shell.
use crate::host::RoomHandle;
use apex_adapters::decision::{DecisionConfig, HttpDecisionProvider};
use apex_core::decision::{routing_request, observation_is_current, DecisionProvider};
use apex_core::RoomSnapshot;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::io::Write;

static LOG_LOCK: Mutex<()> = Mutex::new(());
static IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);
struct Permit;
impl Drop for Permit { fn drop(&mut self) { IN_FLIGHT.fetch_sub(1, Ordering::SeqCst); } }
fn credential(provider: &str) -> Result<keyring::Entry, String> {
    if !["jev", "openrouter", "cloudflare"].contains(&provider) { return Err("Unknown decision provider".into()); }
    keyring::Entry::new("ai.apex-deck.decisions", provider).map_err(|_| "Could not open the OS credential store".into())
}
/// Remove transient secrets before SettingsChanged or any disk write.
pub(crate) fn save_key(settings: &mut Value) -> Result<(), String> {
    if let Some(fields) = settings.as_object_mut() { fields.remove("decisionApiKey"); }
    if let Some(decision) = settings.get_mut("decision") {
        let provider = decision["provider"].as_str().unwrap_or("jev").to_string();
        let valid = ["jev", "openrouter", "cloudflare"].contains(&provider.as_str());
        *decision = json!({"enabled": decision["enabled"] == true && valid, "provider": if valid { provider } else { "jev".into() }, "accountId": decision["accountId"].as_str().unwrap_or("")});
    }
    Ok(())
}

pub(crate) fn key_available(settings: &Value) -> bool {
    settings["decision"]["enabled"] == true && settings["decision"]["provider"].as_str().is_some_and(|provider| credential(provider).and_then(|entry| entry.get_password().map_err(|_| "Missing key".into())).is_ok_and(|key| !key.trim().is_empty()))
}

pub(crate) fn save_credential(provider: &str, key: &str) -> Result<(), String> {
    if key.trim().is_empty() { return Err("API key must not be empty".into()); }
    credential(provider)?.set_password(key.trim()).map_err(|_| "Could not save decision key in the OS credential store".into())
}

type SharedDecision = futures::future::Shared<futures::future::BoxFuture<'static, Result<apex_core::decision::DecisionResult, String>>>;

/// One cache per accepted post/retry. Changed transcripts receive fresh decisions.
pub(crate) struct Observer {
    runtime: tokio::runtime::Handle,
    data: PathBuf,
    room_id: String,
    handle: RoomHandle,
    initial: RoomSnapshot,
    settings: Value,
    revision: u64,
    routing: bool,
    cache: Mutex<Vec<(Vec<apex_core::Message>, SharedDecision)>>,
}

pub(crate) fn observer(runtime: &tokio::runtime::Handle, data: PathBuf, room_id: String, handle: RoomHandle, snapshot: RoomSnapshot, settings: Value, revision: u64, routing: bool) -> std::sync::Arc<Observer> {
    let observer = std::sync::Arc::new(Observer { runtime: runtime.clone(), data, room_id, handle, initial: snapshot, settings, revision, routing, cache: Mutex::new(Vec::new()) });
    // Preserve routing observations even if Deck chooses nobody.
    if routing && observer.settings["decision"]["enabled"] == true && !observer.initial.participants.is_empty() {
        let _ = observer.start(observer.initial.transcript.clone(), observer.initial.participants.clone());
    }
    observer
}

impl Observer {
    fn start(&self, messages: Vec<apex_core::Message>, roster: Vec<apex_core::ParticipantConfig>) -> (SharedDecision, bool) {
        use futures::FutureExt;
        let mut cache = self.cache.lock().unwrap();
        if let Some((_, call)) = cache.iter().find(|(before, _)| *before == messages) { return (call.clone(), false); }
        let settings = self.settings.clone();
        let ids = roster.iter().map(|p| p.id.clone()).collect::<Vec<_>>();
        let mut request = apex_core::decision::thinking_request(&messages, &ids);
        // Keep the existing routing state exactly as it was on eligible human messages.
        let routing = self.routing && messages == self.initial.transcript;
        if routing { request.state = routing_request(&messages, &ids).state; }
        let choices = request.choices.clone();
        let call = async move {
            if settings["decision"]["enabled"] != true { return Err("Decision observer is off".into()); }
            if IN_FLIGHT.try_update(Ordering::SeqCst, Ordering::SeqCst, |n| (n < 4).then_some(n + 1)).is_err() { return Err("Decision observer is busy".into()); }
            let _permit = Permit;
            let provider = settings["decision"]["provider"].as_str().unwrap_or("").to_string();
            let config = DecisionConfig { provider: provider.clone(), account_id: settings["decision"]["accountId"].as_str().unwrap_or("").to_string() };
            // Includes credential lookup, HTTP and response validation.
            // Preserve the existing observer's 8-second background window.
            // Only an Auto caller's wait is cut off at 1.5 seconds.
            tokio::time::timeout(std::time::Duration::from_secs(8), async move {
                config.endpoint()?;
                let key = tokio::task::spawn_blocking(move || credential(&provider)?.get_password().map_err(|_| "Decision key is missing from the OS credential store".to_string())).await.map_err(|_| "Credential lookup failed")??;
                HttpDecisionProvider::new(config, key)?.decide(request).await
            }).await.map_err(|_| "Decision request timed out".to_string())?
        }.boxed().shared();
        cache.push((messages.clone(), call.clone()));
        let (data, room_id, handle, revision, targets) = (self.data.clone(), self.room_id.clone(), self.handle.clone(), self.revision, self.initial.last_targets.clone());
        let background = call.clone();
        self.runtime.spawn(async move {
            let result = background.await;
            if !routing { return; }
            let stale = is_stale(&handle, revision, &messages).await;
            let mut line = base_line(&room_id, &messages, stale);
            line["choices"] = json!(choices);
            line["deck_targets"] = json!(targets);
            match result {
                Ok(result) => {
                    line["suggested_targets"] = if stale { Value::Null } else { json!(choices.get(&result.choice)) };
                    line["thinking"] = json!(result.thinking);
                    line["result"] = json!(result);
                }
                Err(error) => line["error"] = json!(error),
            }
            write_line(data, line).await;
        });
        (call, !routing)
    }
}

impl apex_core::decision::TurnAdvisor for Observer {
    fn advise<'a>(&'a self, config: &'a apex_core::ParticipantConfig, messages: Vec<apex_core::Message>, roster: Vec<apex_core::ParticipantConfig>) -> futures::future::BoxFuture<'a, Option<String>> {
        use futures::FutureExt;
        async move {
            use apex_core::decision::{chosen_effort, supports_auto, AUTO_THINKING_ACTIVE};
            if !supports_auto(config) { return None; }
            if self.settings["decision"]["enabled"] != true { return chosen_effort(config, None, false, ""); }
            let (call, report_usage) = self.start(messages.clone(), roster);
            let (data, room_id, handle, revision, bot, backup, auto) = (self.data.clone(), self.room_id.clone(), self.handle.clone(), self.revision, config.id.clone(), config.effort.clone(), config.auto_effort);
            let log_call = call.clone();
            let log_messages = messages.clone();
            self.runtime.spawn(async move {
                let result = log_call.await;
                let stale = is_stale(&handle, revision, &log_messages).await;
                let mut line = base_line(&room_id, &log_messages, stale);
                line["kind"] = json!("thinking");
                line["agent"] = json!(bot);
                line["auto"] = json!(auto);
                line["observe_only"] = json!(!auto || !AUTO_THINKING_ACTIVE);
                line["backup"] = json!(backup);
                match result {
                    Ok(result) => { line["thinking"] = json!(result.thinking); line["model"] = json!(result.model); line["latency_ms"] = json!(result.latency_ms); if report_usage { line["usage"] = json!(result.usage); } }
                    Err(error) => line["error"] = json!(error),
                }
                write_line(data, line).await;
            });
            // Fixed bots have already scheduled their observation and never wait.
            if !config.auto_effort { return None; }
            let result = bounded(call).await;
            let stale = is_stale(&self.handle, self.revision, &messages).await;
            let thinking = if stale { None } else { result.as_ref().ok().and_then(|r| r.thinking.as_ref()) };
            let human = messages.iter().rev().find(|m| matches!(m.speaker, apex_core::Speaker::Human)).map(|m| m.text.as_str()).unwrap_or("");
            chosen_effort(config, thinking, AUTO_THINKING_ACTIVE, human)
        }.boxed()
    }
}

async fn bounded<T>(future: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
    tokio::time::timeout(std::time::Duration::from_millis(1500), future).await.map_err(|_| "Decision request timed out".to_string())?
}

async fn is_stale(handle: &RoomHandle, revision: u64, messages: &[apex_core::Message]) -> bool {
    let room = handle.room.lock().await;
    handle.deleted.load(Ordering::SeqCst) || revision != handle.observation_revision.load(Ordering::SeqCst) || !observation_is_current(messages, room.transcript())
}

fn base_line(room: &str, messages: &[apex_core::Message], stale: bool) -> Value {
    json!({"version":1,"room":room,"message_index":messages.len().saturating_sub(1),"stale":stale,"observe_only":true,"at_ms":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()})
}

async fn write_line(data: PathBuf, line: Value) {
    let written = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        let _guard = LOG_LOCK.lock().unwrap();
        std::fs::create_dir_all(&data)?;
        let mut options = std::fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut file = options.open(data.join("decisions.jsonl"))?;
        writeln!(file, "{}", line)
    }).await;
    if !matches!(written, Ok(Ok(()))) { eprintln!("[apex-deck] Could not write decision observation log"); }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn secrets_are_removed_before_settings_are_serialized() {
        keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        save_credential("jev", "test-secret").unwrap();
        assert!(save_credential("jev", " ").is_err());
        assert!(save_credential("unknown", "test-secret").is_err());
        let mut settings = json!({"decisionApiKey":"test-secret", "decision":{"enabled":false,"provider":"jev","accountId":"","extra":"test-secret"}});
        save_key(&mut settings).unwrap();
        assert!(!settings.to_string().contains("test-secret"));
        assert!(settings.get("decisionApiKey").is_none());
    }
}

#[cfg(test)]
mod timing_tests {
    use super::*;
    #[tokio::test]
    async fn timeout_is_bounded_and_errors_and_success_are_preserved() {
        let started = std::time::Instant::now();
        assert!(bounded::<()>(std::future::pending()).await.unwrap_err().contains("timed out"));
        assert!(started.elapsed() < std::time::Duration::from_millis(1800));
        assert_eq!(bounded(async { Ok::<_, String>("high") }).await.unwrap(), "high");
        assert_eq!(bounded::<()>(async { Err("missing key".into()) }).await.unwrap_err(), "missing key");
    }
}
