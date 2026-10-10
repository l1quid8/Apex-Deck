//! Delivering notices to the iPhone with Apple's push service (APNs). Off
//! until `<data>/apns.json` names an APNs key on this machine:
//! `{"keyPath": "/path/AuthKey_ABC123.p8", "keyId": "ABC123", "teamId": "TEAM123",
//!   "topic": "dev.apexdeck.phone", "sandbox": true}`.
//! The phone registers its device token with `personal_push_register`.
//! A push carries only the notice's short text, never task output.

use serde::Deserialize;
use serde_json::json;

use crate::personal::Notice;
use crate::Host;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Apns {
    key_path: String,
    key_id: String,
    team_id: String,
    topic: String,
    #[serde(default)]
    sandbox: bool,
}

fn b64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// The ES256 token APNs wants, signed with the .p8 key.
fn token(config: &Apns, now_secs: u64) -> Result<String, String> {
    use base64::Engine;
    use ring::signature::{EcdsaKeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
    let pem = std::fs::read_to_string(&config.key_path).map_err(|e| format!("Could not read the APNs key: {e}"))?;
    let body: String = pem.lines().filter(|l| !l.starts_with("-----")).collect();
    let der = base64::engine::general_purpose::STANDARD.decode(body.trim()).map_err(|_| "The APNs key isn't valid PEM.".to_string())?;
    let rng = ring::rand::SystemRandom::new();
    let key = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &der, &rng).map_err(|_| "The APNs key isn't a P-256 key.".to_string())?;
    let header = b64(json!({ "alg": "ES256", "kid": config.key_id }).to_string().as_bytes());
    let claims = b64(json!({ "iss": config.team_id, "iat": now_secs }).to_string().as_bytes());
    let input = format!("{header}.{claims}");
    let signature = key.sign(&rng, input.as_bytes()).map_err(|_| "Could not sign the APNs token.".to_string())?;
    Ok(format!("{input}.{}", b64(signature.as_ref())))
}

impl Host {
    /// Push delivered notices to every phone registered with their assistant.
    pub(crate) async fn personal_push(&self, notices: Vec<(String, Notice)>) {
        let Ok(text) = std::fs::read_to_string(self.data_dir().join("apns.json")) else { return };
        let config: Apns = match serde_json::from_str(&text) {
            Ok(config) => config,
            Err(error) => { eprintln!("Personal assistant push: apns.json is invalid: {error}"); return; }
        };
        let jwt = match token(&config, crate::personal::now() / 1000) {
            Ok(jwt) => jwt,
            Err(error) => { eprintln!("Personal assistant push: {error}"); return; }
        };
        let client = match reqwest::Client::builder().http2_prior_knowledge().timeout(std::time::Duration::from_secs(15)).build() {
            Ok(client) => client,
            Err(error) => { eprintln!("Personal assistant push: {error}"); return; }
        };
        let base = if config.sandbox { "https://api.sandbox.push.apple.com" } else { "https://api.push.apple.com" };
        let assistants = self.personal_list().unwrap_or_default();
        // Several notices at once go out as one push.
        let mut by_assistant: std::collections::BTreeMap<String, Vec<Notice>> = Default::default();
        for (id, notice) in notices { by_assistant.entry(id).or_default().push(notice); }
        for (id, notices) in by_assistant {
            let Some(assistant) = assistants.iter().find(|a| a.id == id) else { continue };
            let body = if notices.len() == 1 { notices[0].text.clone() } else { format!("{} updates: {}", notices.len(), notices.iter().map(|n| n.text.as_str()).collect::<Vec<_>>().join(" · ")) };
            // Local-only: nothing the assistant wrote leaves for Apple's servers.
            let body: String = if assistant.privacy.local_only { "New update from your assistant.".into() } else { body.chars().take(240).collect() };
            for device in &assistant.push_devices {
                let payload = json!({ "aps": { "alert": { "title": assistant.name, "body": body }, "sound": "default" }, "assistantId": id });
                let sent = client.post(format!("{base}/3/device/{}", device.token))
                    .header("authorization", format!("bearer {jwt}"))
                    .header("apns-topic", &config.topic)
                    .header("apns-push-type", "alert")
                    .json(&payload).send().await;
                match sent {
                    Ok(response) if response.status().is_success() => {}
                    Ok(response) => eprintln!("Personal assistant push: APNs answered {}", response.status()),
                    Err(error) => eprintln!("Personal assistant push: {error}"),
                }
            }
        }
    }
}
