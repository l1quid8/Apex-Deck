//! Root-owned submission authority. No shell execution and no general file API.
pub mod io;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, UnparsedPublicKey, ED25519},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const ROOT: &str = "/Library/Application Support/Apex Deck Provenance";
pub const SOCKET: &str = "/var/run/dev.apexdeck.provenance.sock";
pub const MAX_BYTES: usize = 16 * 1024 * 1024;
pub const JOURNAL_BYTES: usize = 128 * 1024 * 1024;
pub const DOMAIN: &str = "apex-provenance-v1";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    pub uid: u32,
    pub data_dir: String,
    pub command: Value,
    pub key: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Signed {
    pub payload: String,
    pub signature: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Entry {
    receipt: Receipt,
    claimed: bool,
    #[serde(default)]
    outcome: Option<Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Journal {
    version: u32,
    entries: BTreeMap<String, Entry>,
    #[serde(default)]
    documents: BTreeMap<String, ProtectedDocument>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProtectedDocument {
    pub revision: u64,
    pub value: Value,
}
impl Journal {
    pub fn new() -> Self {
        Self {
            version: 1,
            entries: BTreeMap::new(),
            documents: BTreeMap::new(),
        }
    }
    pub fn read_document(
        &self,
        uid: u32,
        data_dir: &str,
        name: &str,
        trusted: bool,
    ) -> Result<ProtectedDocument, String> {
        if !trusted {
            return Err("Protected ledgers require the pinned daemon".into());
        }
        let key = document_key(uid, data_dir, name)?;
        Ok(self
            .documents
            .get(&key)
            .cloned()
            .unwrap_or(ProtectedDocument {
                revision: 0,
                value: Value::Null,
            }))
    }
    pub fn write_document(
        &mut self,
        uid: u32,
        data_dir: &str,
        name: &str,
        expected: u64,
        value: Value,
        trusted: bool,
    ) -> Result<ProtectedDocument, String> {
        let current = self.read_document(uid, data_dir, name, trusted)?;
        if current.revision != expected {
            return Err("Protected ledger changed; reload instead of overwriting".into());
        }
        if !value.is_object() {
            return Err("Protected ledger must be an object".into());
        }
        let document = ProtectedDocument {
            revision: expected.checked_add(1).ok_or("Ledger revision exhausted")?,
            value,
        };
        self.documents
            .insert(document_key(uid, data_dir, name)?, document.clone());
        Ok(document)
    }
    pub fn finish(
        &mut self,
        uid: u32,
        data_dir: &str,
        key: &str,
        outcome: Value,
        trusted: bool,
    ) -> Result<Value, String> {
        if !trusted {
            return Err("Only the pinned daemon may report execution outcomes".into());
        }
        if !matches!(outcome["status"].as_str(), Some("succeeded" | "rejected"))
            || outcome.to_string().len() > 16_000
        {
            return Err("Invalid execution outcome".into());
        }
        let entry = self.entries.get_mut(key).ok_or("Unknown submission")?;
        if entry.receipt.uid != uid || entry.receipt.data_dir != data_dir || !entry.claimed {
            return Err("Submission was not claimed by this scope".into());
        }
        if let Some(old) = &entry.outcome {
            if old != &outcome {
                return Err("Execution outcome is already recorded".into());
            }
        }
        entry.outcome = Some(outcome.clone());
        Ok(outcome)
    }
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 {
            return Err("Unsupported protected journal version".into());
        }
        for (key, entry) in &self.entries {
            if *key
                != command_key(
                    entry.receipt.uid,
                    &entry.receipt.data_dir,
                    &entry.receipt.command,
                )?
                || *key != entry.receipt.key
            {
                return Err("Invalid protected journal entry".into());
            }
        }
        Ok(())
    }
    pub fn issue(
        &mut self,
        uid: u32,
        data_dir: &str,
        command: Value,
        trusted: bool,
    ) -> Result<Receipt, String> {
        if !trusted {
            return Err("Only the pinned installed UI may record a submission or decision.".into());
        }
        if self.version != 1 {
            return Err("Unsupported provenance journal version".into());
        }
        if !data_dir.starts_with('/') || data_dir.len() > 4096 || data_dir.contains('\0') {
            return Err("Invalid data directory".into());
        }
        let key = command_key(uid, data_dir, &command)?;
        let receipt = Receipt {
            uid,
            data_dir: data_dir.into(),
            command,
            key: key.clone(),
        };
        if let Some(old) = self.entries.get(&key) {
            if old.receipt != receipt {
                return Err("Submission ID conflicts with protected original content".into());
            }
            return Ok(old.receipt.clone());
        }
        if self.entries.len() >= 100_000 {
            return Err("Protected journal capacity reached; no records were evicted".into());
        }
        self.entries.insert(
            key,
            Entry {
                receipt: receipt.clone(),
                claimed: false,
                outcome: None,
            },
        );
        Ok(receipt)
    }
    pub fn claim(
        &mut self,
        uid: u32,
        data_dir: &str,
        receipt: &Receipt,
        nonce: &str,
    ) -> Result<Value, String> {
        if uid != receipt.uid || data_dir != receipt.data_dir {
            return Err("Receipt belongs to another user or data directory".into());
        }
        if nonce.len() != 32 || !nonce.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err("Invalid claim challenge".into());
        }
        let entry = self
            .entries
            .get_mut(&receipt.key)
            .ok_or("No protected original submission exists")?;
        if &entry.receipt != receipt {
            return Err("Receipt does not match protected original content".into());
        }
        if entry.claimed {
            return Err("Submission already consumed; execution outcome may be uncertain. Do not retry automatically.".into());
        }
        entry.claimed = true;
        Ok(json!({"domain":DOMAIN,"kind":"claim","nonce":nonce,"receipt":receipt}))
    }
}
fn document_key(uid: u32, data_dir: &str, name: &str) -> Result<String, String> {
    if !data_dir.starts_with('/')
        || !matches!(
            name,
            "personal-assistants.json"
                | "assistant-tasks-v1.json"
                | "assistant-conversations-v1.json"
                | "room-authority-v1.json"
                | "personal-machine.json"
        )
    {
        return Err("Not a protected ledger name".into());
    }
    serde_json::to_string(&(uid, data_dir, name)).map_err(|e| e.to_string())
}
/// This is deliberately smaller than the host command API. New privileged verbs
/// fail closed here until their identity and replay key have been specified.
pub fn protected(name: &str) -> bool {
    matches!(
        name,
        "assistant_message"
            | "assistant_task_action"
            | "personal_send"
            | "personal_decide"
            | "room_post"
            | "room_post_to"
            | "room_turn"
            | "room_decide"
            | "room_answer"
            | "personal_create"
            | "personal_configure"
            | "personal_workspace_configure"
            | "personal_rule_add"
            | "personal_rule_remove"
            | "personal_machine_link"
            | "personal_machine_unlink"
            | "personal_machine_claim"
            | "personal_machine_allow"
            | "personal_pause"
            | "personal_cancel"
            | "personal_schedule_cancel"
            | "room_create"
            | "room_import"
            | "room_fork"
            | "room_update_participant"
            | "room_add_participant"
            | "room_remove_participant"
            | "room_set_options"
            | "room_forget_allowed"
            | "room_set_plan"
            | "room_mount"
            | "personal_memory_add"
            | "personal_memory_correct"
            | "personal_memory_forget"
            | "project_memory_save"
            | "project_memory_forget"
            | "project_memory_stage"
            | "project_memory_promote"
    )
}
fn command_key(uid: u32, data_dir: &str, command: &Value) -> Result<String, String> {
    let name = command["cmd"].as_str().ok_or("Missing command")?;
    if !protected(name) {
        return Err("Command cannot acquire submission authority".into());
    }
    if command
        .as_object()
        .is_none_or(|o| o.len() != 2 && !(o.len() == 3 && o.contains_key("provenanceRequestId")))
        || !command["args"].is_object()
    {
        return Err("Expected exactly cmd and args".into());
    }
    let args = &command["args"];
    let id = if name.starts_with("room_")
        || !matches!(
            name,
            "assistant_message" | "personal_send" | "personal_decide" | "assistant_task_action"
        ) {
        json!(command["provenanceRequestId"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 200)
            .ok_or("Missing room action submission ID")?)
    } else if name == "assistant_task_action" {
        json!([
            args["taskId"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or("Missing task ID")?,
            args["revision"].as_u64().ok_or("Missing task revision")?
        ])
    } else {
        json!(args["requestId"]
            .as_str()
            .filter(|s| !s.trim().is_empty() && s.len() <= 200)
            .ok_or("Missing request ID")?)
    };
    // Scope is explicit; identity/project fields remain bound in the exact receipt
    // too. Same request ID cannot be reissued with a different assistant or text.
    let binding =
        serde_json::to_vec(&(DOMAIN, uid, data_dir, name, id)).map_err(|e| e.to_string())?;
    Ok(format!("{:x}", Sha256::digest(binding)))
}

pub fn new_key() -> Result<Ed25519KeyPair, String> {
    let document = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
        .map_err(|_| "Key generation failed")?;
    Ed25519KeyPair::from_pkcs8(document.as_ref()).map_err(|_| "Invalid key".into())
}
pub fn sign(key: &Ed25519KeyPair, value: &Value) -> Result<Signed, String> {
    let payload = serde_json::to_string(value).map_err(|e| e.to_string())?;
    Ok(Signed {
        signature: B64.encode(key.sign(payload.as_bytes()).as_ref()),
        payload,
    })
}
pub fn verify(key: &[u8], signed: &Signed) -> Result<Value, String> {
    if signed.payload.len() > MAX_BYTES {
        return Err("Receipt too large".into());
    }
    let signature = B64
        .decode(&signed.signature)
        .map_err(|_| "Invalid signature encoding")?;
    UnparsedPublicKey::new(&ED25519, key)
        .verify(signed.payload.as_bytes(), &signature)
        .map_err(|_| "Invalid provenance signature")?;
    serde_json::from_str(&signed.payload).map_err(|e| e.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::KeyPair;
    use serde_json::json;

    fn command(text: &str) -> serde_json::Value {
        json!({"cmd":"assistant_message","args":{"requestId":"r1","workspaceId":"p1","hostId":"h1","conversationId":"c1","cwd":"/project","text":text}})
    }

    #[test]
    fn stale_approval_rejection_is_durable_and_cannot_be_rewritten() {
        let mut journal = Journal::new();
        let receipt = journal.issue(501, "/data", command("hello"), true).unwrap();
        journal
            .claim(501, "/data", &receipt, "0123456789abcdef0123456789abcdef")
            .unwrap();
        let outcome = json!({"status":"rejected","reason":"Stale revision"});
        assert!(journal
            .finish(501, "/data", &receipt.key, outcome.clone(), false)
            .is_err());
        journal
            .finish(501, "/data", &receipt.key, outcome.clone(), true)
            .unwrap();
        let mut restored: Journal =
            serde_json::from_slice(&serde_json::to_vec(&journal).unwrap()).unwrap();
        assert_eq!(
            restored
                .finish(501, "/data", &receipt.key, outcome, true)
                .unwrap()["reason"],
            "Stale revision"
        );
        assert!(restored
            .finish(
                501,
                "/data",
                &receipt.key,
                json!({"status":"succeeded"}),
                true
            )
            .is_err());
    }
    #[test]
    fn journal_larger_than_old_frame_limit_remains_decodable() {
        let mut journal = Journal::new();
        for i in 0..32 {
            let mut cmd = command(&"x".repeat(40_000));
            cmd["args"]["requestId"] = json!(format!("r-{i}"));
            journal.issue(501, "/data", cmd, true).unwrap();
        }
        let bytes = serde_json::to_vec(&journal).unwrap();
        assert!(bytes.len() > 1024 * 1024 && bytes.len() < JOURNAL_BYTES);
        let restored: Journal = serde_json::from_slice(&bytes).unwrap();
        restored.validate().unwrap();
        assert_eq!(restored.entries.len(), 32);
    }

    #[test]
    fn protected_ledgers_reject_untrusted_writers_and_stale_versions() {
        let mut journal = Journal::new();
        assert!(journal
            .write_document(
                501,
                "/data",
                "assistant-conversations-v1.json",
                0,
                json!({"forged":true}),
                false
            )
            .is_err());
        let first = journal
            .write_document(
                501,
                "/data",
                "assistant-conversations-v1.json",
                0,
                json!({"text":"genuine"}),
                true,
            )
            .unwrap();
        assert_eq!(first.revision, 1);
        assert!(journal
            .write_document(
                501,
                "/data",
                "assistant-conversations-v1.json",
                0,
                json!({"text":"overwrite"}),
                true
            )
            .is_err());
        assert_eq!(
            journal
                .read_document(501, "/data", "assistant-conversations-v1.json", true)
                .unwrap()
                .value,
            json!({"text":"genuine"})
        );
        assert!(journal
            .read_document(502, "/data", "assistant-conversations-v1.json", true)
            .unwrap()
            .value
            .is_null());
        assert!(journal
            .read_document(501, "/data", "../../outside", true)
            .is_err());
    }
    #[test]
    fn protected_personal_approval_survives_reload_without_trusting_user_json() {
        let mut journal = Journal::new();
        journal
            .write_document(
                501,
                "/data",
                "personal-assistants.json",
                0,
                json!({"events":[],"tasks":[]}),
                true,
            )
            .unwrap();
        let restored: Journal =
            serde_json::from_slice(&serde_json::to_vec(&journal).unwrap()).unwrap();
        assert_eq!(
            restored
                .read_document(501, "/data", "personal-assistants.json", true)
                .unwrap()
                .value,
            json!({"events":[],"tasks":[]})
        );
    }

    #[test]
    fn untrusted_process_cannot_issue_even_with_full_filesystem_access() {
        let mut journal = Journal::new();
        assert!(journal
            .issue(501, "/data", command("hello"), false)
            .is_err());
        assert!(journal.entries.is_empty());
    }

    #[test]
    fn exact_retry_is_idempotent_but_changed_request_is_rejected() {
        let mut journal = Journal::new();
        let first = journal.issue(501, "/data", command("hello"), true).unwrap();
        assert_eq!(
            first,
            journal.issue(501, "/data", command("hello"), true).unwrap()
        );
        assert!(journal
            .issue(501, "/data", command("changed"), true)
            .is_err());
    }

    #[test]
    fn claim_is_durable_and_cannot_be_replayed_after_reload() {
        let mut journal = Journal::new();
        let receipt = journal.issue(501, "/data", command("hello"), true).unwrap();
        journal
            .claim(501, "/data", &receipt, "0123456789abcdef0123456789abcdef")
            .unwrap();
        let mut restored: Journal =
            serde_json::from_slice(&serde_json::to_vec(&journal).unwrap()).unwrap();
        assert!(restored
            .claim(501, "/data", &receipt, "fedcba9876543210fedcba9876543210")
            .is_err());
    }

    #[test]
    fn signature_binds_every_byte_and_scope() {
        let key = new_key().unwrap();
        let signed = sign(
            &key,
            &json!({"uid":501,"dataDir":"/data","command":command("hello")}),
        )
        .unwrap();
        verify(key.public_key().as_ref(), &signed).unwrap();
        let mut tampered = signed.clone();
        tampered.payload = tampered.payload.replace("hello", "changed");
        assert!(verify(key.public_key().as_ref(), &tampered).is_err());
        assert!(verify(new_key().unwrap().public_key().as_ref(), &signed).is_err());
    }

    #[test]
    fn copied_receipt_cannot_cross_user_project_or_data_directory() {
        let mut journal = Journal::new();
        let receipt = journal.issue(501, "/data", command("hello"), true).unwrap();
        assert!(journal
            .claim(502, "/data", &receipt, "0123456789abcdef0123456789abcdef")
            .is_err());
        assert!(journal
            .claim(501, "/other", &receipt, "0123456789abcdef0123456789abcdef")
            .is_err());
        let mut changed = receipt.clone();
        changed.command["args"]["workspaceId"] = json!("p2");
        assert!(journal
            .claim(501, "/data", &changed, "0123456789abcdef0123456789abcdef")
            .is_err());
    }

    #[test]
    fn unknown_and_nested_commands_never_gain_authority() {
        let mut journal = Journal::new();
        for name in [
            "provenance_execute",
            "host.command",
            "unknown",
            "mod_process_run",
        ] {
            assert!(journal
                .issue(
                    501,
                    "/data",
                    json!({"cmd":name,"args":{"requestId":"r"}}),
                    true
                )
                .is_err());
        }
    }
}
