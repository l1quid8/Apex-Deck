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

pub(crate) fn save_credential(provider: &str, key: &str) -> Result<(), String> {
    if key.trim().is_empty() { return Err("API key must not be empty".into()); }
    credential(provider)?.set_password(key.trim()).map_err(|_| "Could not save decision key in the OS credential store".into())
}

pub(crate) fn observe(runtime: &tokio::runtime::Handle, data: PathBuf, room_id: String, handle: RoomHandle, snapshot: RoomSnapshot, settings: Value, revision: u64) {
    if settings["decision"]["enabled"] != true || snapshot.participants.is_empty() { return; }
    if IN_FLIGHT.try_update(Ordering::SeqCst, Ordering::SeqCst, |n| (n < 4).then_some(n + 1)).is_err() { return; }
    let permit = Permit;
    runtime.spawn(async move {
        let _permit = permit;
        let provider = settings["decision"]["provider"].as_str().unwrap_or("").to_string();
        let config = DecisionConfig { provider: provider.clone(), account_id: settings["decision"]["accountId"].as_str().unwrap_or("").to_string() };
        let ids = snapshot.participants.iter().map(|p| p.id.clone()).collect::<Vec<_>>();
        let request = routing_request(&snapshot.transcript, &ids);
        let choices = request.choices.clone();
        let result = async {
            config.endpoint()?;
            let key = tokio::task::spawn_blocking(move || credential(&provider)?.get_password().map_err(|_| "Decision key is missing from the OS credential store".to_string())).await.map_err(|_| "Credential lookup failed")??;
            HttpDecisionProvider::new(config, key)?.decide(request).await
        }.await;
        let current = handle.room.lock().await;
        let stale = handle.deleted.load(Ordering::SeqCst) || revision != handle.observation_revision.load(Ordering::SeqCst) || !observation_is_current(&snapshot.transcript, current.transcript());
        drop(current);
        let mut line = json!({"version":1,"room":room_id,"message_index":snapshot.transcript.len().saturating_sub(1),"deck_targets":snapshot.last_targets,"stale":stale,"observe_only":true,"choices":choices,"at_ms":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()});
        match result {
            Ok(result) => {
                let choice = result.choice.as_str();
                line["suggested_targets"] = if stale { Value::Null } else { json!(choices.get(choice)) };
                line["result"] = json!(result);
            }
            Err(error) => { line["error"] = json!(error); }
        }
        // No transcript or key in logs. Blocking disk work stays off runtime threads.
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
    });
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
