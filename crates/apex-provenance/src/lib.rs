//! Root-owned submission authority. No shell execution and no general file API.
#[cfg(unix)]
pub mod io;
#[cfg(unix)]
mod ownership;
#[cfg(unix)]
pub use ownership::{HostOwnership, HostOwnershipError, prepare_host_lock};
#[cfg(any(not(unix), test))]
mod unavailable;
#[cfg(not(unix))]
pub use unavailable::{io, prepare_host_lock, HostOwnership, HostOwnershipError};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ring::{
    rand::{SecureRandom, SystemRandom},
    signature::{Ed25519KeyPair, KeyPair, UnparsedPublicKey, ED25519},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const ROOT: &str = "/Library/Application Support/Apex Deck Provenance";
pub const SOCKET: &str = "/var/run/dev.apexdeck.provenance.sock";
pub const MAX_BYTES: usize = 16 * 1024 * 1024;
pub const JOURNAL_BYTES: usize = 128 * 1024 * 1024;
pub const COMPACT_AT: usize = 75_000;
// Signatures use the same bounded verifier as receipts. This conservative cap
// keeps a checkpoint below MAX_BYTES; capacity always fails closed, never evicts.
pub const MAX_CHECKPOINT_CLAIMS: usize = 200_000;
pub const ORPHAN_GRACE_MS: u64 = 7 * 24 * 60 * 60 * 1000;
pub const UNCLAIMED_TTL_MS: u64 = 24 * 60 * 60 * 1000;
pub const DOMAIN: &str = "apex-provenance-v1";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    pub uid: u32,
    pub data_dir: String,
    pub command: Value,
    pub key: String,
    // Absent on legacy receipts. Exact retries reuse the original token;
    // renewal after expiry cannot revive an older signed receipt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issuance_id: Option<String>,
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
    #[serde(default)]
    issued_at: u64,
    #[serde(default)]
    claimed_at: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointPayload {
    pub domain: String,
    pub kind: String,
    pub generation: u64,
    pub claims: BTreeMap<String, u64>,
    pub folded: u64,
    pub resolved: u64,
    pub orphaned: u64,
    pub expired: u64,
}
// Deliberately no Deserialize on Journal: all persisted loads must pass open().
#[derive(Debug, Clone, Serialize)]
pub struct Journal {
    version: u32,
    entries: BTreeMap<String, Entry>,
    documents: BTreeMap<String, ProtectedDocument>,
    checkpoint: Option<Signed>,
    #[serde(skip)]
    claims: BTreeMap<String, u64>,
}
#[derive(Deserialize)]
struct StoredJournal {
    version: u32,
    entries: BTreeMap<String, Entry>,
    #[serde(default)]
    documents: BTreeMap<String, ProtectedDocument>,
    #[serde(default)]
    checkpoint: Option<Signed>,
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
            checkpoint: None,
            claims: BTreeMap::new(),
        }
    }
    pub fn open(bytes: &[u8], public_key: &[u8]) -> Result<Self, String> {
        if bytes.len() > JOURNAL_BYTES {
            return Err("Protected journal exceeds size limit".into());
        }
        let stored: StoredJournal = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
        let mut journal = Self {
            version: stored.version,
            entries: stored.entries,
            documents: stored.documents,
            checkpoint: stored.checkpoint,
            claims: BTreeMap::new(),
        };
        journal.validate(public_key)?;
        Ok(journal)
    }

    fn checkpoint_payload(&self, public_key: &[u8]) -> Result<Option<CheckpointPayload>, String> {
        self.checkpoint
            .as_ref()
            .map(|signed| {
                let payload: CheckpointPayload =
                    serde_json::from_value(verify(public_key, signed)?)
                        .map_err(|e| e.to_string())?;
                if payload.domain != DOMAIN
                    || payload.kind != "checkpoint"
                    || payload.generation == 0
                    || payload.claims.len() > MAX_CHECKPOINT_CLAIMS
                    || payload.claims.keys().any(|k| {
                        k.len() != 64
                            || !k
                                .bytes()
                                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                    })
                    || payload
                        .resolved
                        .checked_add(payload.orphaned)
                        .and_then(|n| n.checked_add(payload.expired))
                        != Some(payload.folded)
                    || payload.resolved.checked_add(payload.orphaned)
                        != Some(payload.claims.len() as u64)
                {
                    return Err("Invalid protected checkpoint".into());
                }
                Ok(payload)
            })
            .transpose()
    }

    pub fn compact_if_due(&mut self, key: &Ed25519KeyPair, at: usize) -> Result<bool, String> {
        if self.entries.len() < at {
            return Ok(false);
        }
        let before = self.entries.len();
        self.compact(key)?;
        Ok(self.entries.len() < before)
    }

    /// Only commit after the signature and size checks succeed. The broker
    /// persists the entire candidate journal atomically before acknowledging it.
    pub fn compact(&mut self, key: &Ed25519KeyPair) -> Result<(), String> {
        self.validate(key.public_key().as_ref())?;
        let previous = self.checkpoint_payload(key.public_key().as_ref())?;
        let mut payload = previous.unwrap_or(CheckpointPayload {
            domain: DOMAIN.into(),
            kind: "checkpoint".into(),
            generation: 0,
            claims: BTreeMap::new(),
            folded: 0,
            resolved: 0,
            orphaned: 0,
            expired: 0,
        });
        let now = now_ms();
        let mut removed = Vec::new();
        for (id, entry) in &self.entries {
            let counter = if entry.claimed && entry.outcome.is_some() {
                payload.claims.insert(id.clone(), entry.claimed_at);
                &mut payload.resolved
            } else if entry.claimed
                && entry.claimed_at != 0
                && now.saturating_sub(entry.claimed_at) > ORPHAN_GRACE_MS
            {
                payload.claims.insert(id.clone(), entry.claimed_at);
                &mut payload.orphaned
            } else if !entry.claimed
                && entry.issued_at != 0
                && now.saturating_sub(entry.issued_at) > UNCLAIMED_TTL_MS
            {
                &mut payload.expired
            } else {
                continue;
            };
            *counter = counter
                .checked_add(1)
                .ok_or("Checkpoint counter exhausted")?;
            payload.folded = payload
                .folded
                .checked_add(1)
                .ok_or("Checkpoint counter exhausted")?;
            removed.push(id.clone());
        }
        if removed.is_empty() {
            return Ok(());
        }
        if payload.claims.len() > MAX_CHECKPOINT_CLAIMS {
            return Err("Protected checkpoint capacity reached; no claims were evicted".into());
        }
        payload.generation = payload
            .generation
            .checked_add(1)
            .ok_or("Checkpoint generation exhausted")?;
        let signed = sign(
            key,
            &serde_json::to_value(&payload).map_err(|e| e.to_string())?,
        )?;
        if signed.payload.len() > MAX_BYTES {
            return Err(
                "Protected checkpoint exceeds signature size limit; no claims were evicted".into(),
            );
        }
        for id in removed {
            self.entries.remove(&id);
        }
        self.claims = payload.claims;
        self.checkpoint = Some(signed);
        Ok(())
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
        if self.claims.contains_key(key) {
            return Err(
                "Submission was archived after its execution window; outcome not recorded".into(),
            );
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
    pub fn validate(&mut self, public_key: &[u8]) -> Result<(), String> {
        if self.version != 1 {
            return Err("Unsupported protected journal version".into());
        }
        let claims = self
            .checkpoint_payload(public_key)?
            .map(|p| p.claims)
            .unwrap_or_default();
        for (key, entry) in &self.entries {
            if claims.contains_key(key) || (!entry.claimed && entry.outcome.is_some()) {
                return Err("Invalid live/checkpoint state".into());
            }
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
        self.claims = claims;
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
        // Old task-action receipts used one key for every action at a task
        // revision. Preserve those replay barriers while allowing a different
        // explicitly signed action to use its new action-qualified key.
        let content_preflight = content_bound_startup_preflight(&command);
        if command["cmd"] == "assistant_task_action" && command.get("provenanceRequestId").is_some() {
            let mut legacy = command.clone();
            legacy.as_object_mut().unwrap().remove("provenanceRequestId");
            let legacy_key = command_key(uid, data_dir, &legacy)?;
            if self.claims.contains_key(&legacy_key) {
                return Err("Historical task submission was consumed and its action is unavailable; reconcile the task before resubmitting.".into());
            }
            if self.entries.get(&legacy_key).is_some_and(|entry| entry.receipt.command["args"]["action"] == command["args"]["action"] && (!content_preflight || entry.claimed)) {
                return Err("This task action already has a protected legacy submission; do not resubmit automatically.".into());
            }
            if content_preflight {
                let mut qualified = command.clone();
                qualified["provenanceRequestId"] = json!("task-action:revise_startup");
                let previous_key = command_key(uid, data_dir, &qualified)?;
                if self.claims.contains_key(&previous_key) || self.entries.get(&previous_key).is_some_and(|entry| entry.claimed) {
                    return Err("This startup check has a consumed protected submission; reconcile the task before checking another plan.".into());
                }
                // Only unclaimed startup checks may migrate to content-bound
                // keys. Retain their original receipts unchanged. Preflight
                // never dispatches a worker; its successful proposal mutation
                // advances the task revision by compare-and-swap, so competing
                // old/new receipts cannot both revise the same task revision.
            }
        }
        // A still-running older UI must not replay an action already issued
        // under the new qualified key either.
        if command["cmd"] == "assistant_task_action" && command.get("provenanceRequestId").is_none() {
            if let Some(action) = command["args"]["action"].as_str() {
                let mut qualified = command.clone();
                qualified["provenanceRequestId"] = json!(format!("task-action:{action}"));
                let qualified_key = command_key(uid, data_dir, &qualified)?;
                if self.claims.contains_key(&qualified_key) || self.entries.contains_key(&qualified_key) {
                    return Err("This task action already has a protected action-qualified submission; do not resubmit automatically.".into());
                }
            }
        }
        let key = command_key(uid, data_dir, &command)?;
        if self.claims.contains_key(&key) {
            return Err("Submission ID was already consumed; retry with a new request ID".into());
        }
        let now = now_ms();
        if let Some(old) = self.entries.get(&key) {
            if old.receipt.uid != uid
                || old.receipt.data_dir != data_dir
                || old.receipt.command != command
            {
                return Err("Submission ID conflicts with protected original content".into());
            }
            if old.claimed
                || old.issued_at == 0
                || now.saturating_sub(old.issued_at) <= UNCLAIMED_TTL_MS
            {
                return Ok(old.receipt.clone());
            }
        }
        if self.entries.len() >= 100_000 && !self.entries.contains_key(&key) {
            return Err("Protected journal capacity reached; no records were evicted".into());
        }
        let mut token = [0u8; 16];
        SystemRandom::new()
            .fill(&mut token)
            .map_err(|_| "Could not generate issuance token")?;
        let receipt = Receipt {
            uid,
            data_dir: data_dir.into(),
            command,
            key: key.clone(),
            issuance_id: Some(B64.encode(token)),
        };
        self.entries.insert(
            key,
            Entry {
                receipt: receipt.clone(),
                claimed: false,
                outcome: None,
                issued_at: now,
                claimed_at: 0,
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
        if self.claims.contains_key(&receipt.key) {
            return Err("Submission already consumed; execution outcome may be uncertain. Do not retry automatically.".into());
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
        if entry.issued_at != 0 && now_ms().saturating_sub(entry.issued_at) > UNCLAIMED_TTL_MS {
            return Err(
                "Submission expired before it was claimed; request a fresh issuance".into(),
            );
        }
        entry.claimed = true;
        entry.claimed_at = now_ms();
        Ok(json!({"domain":DOMAIN,"kind":"claim","nonce":nonce,"receipt":receipt}))
    }
}
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
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
                | "project-memory-v1.json"
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
            | "personal_avatar_generate"
            | "personal_avatar_cancel"
            | "personal_project_delegate"
            | "personal_project_delegate_ui"
            | "personal_rule_add"
            | "personal_rule_remove"
            | "personal_machine_link"
            | "personal_machine_unlink"
            | "personal_machine_claim"
            | "personal_machine_allow"
            | "personal_pause"
            | "personal_cancel"
            | "personal_task_lifecycle"
            | "personal_archive"
            | "personal_reply_cancel"
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
            // Bound to the UI's delivery ID like room actions; the host also
            // refuses changed content under the same ledger import.
            | "legacy_import_apply"
    )
}
fn content_bound_startup_preflight(command: &Value) -> bool {
    command["cmd"] == "assistant_task_action"
        && command["args"]["action"] == "revise_startup"
        && command["provenanceRequestId"] == "task-action:revise_startup:content-v1"
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
        let task = args["taskId"].as_str().filter(|s| !s.is_empty()).ok_or("Missing task ID")?;
        let revision = args["revision"].as_u64().ok_or("Missing task revision")?;
        if let Some(delivery) = command.get("provenanceRequestId") {
            let action = args["action"].as_str().filter(|s| !s.is_empty() && s.len() <= 200).ok_or("Missing task action")?;
            if content_bound_startup_preflight(command) {
                // The explicit version marker keeps every existing receipt's
                // key stable. The broker hashes all plan content itself; the
                // renderer cannot select a key or substitute unsigned fields.
                json!([task, revision, action, "content-v1", args])
            } else {
                if delivery.as_str() != Some(format!("task-action:{action}").as_str()) { return Err("Task action submission ID does not match its action".into()); }
                json!([task, revision, action])
            }
        } else {
            // Existing receipts must retain their original key across upgrades.
            json!([task, revision])
        }
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

    const NONCE: &str = "0123456789abcdef0123456789abcdef";

    fn claimed(journal: &mut Journal) -> Receipt {
        let receipt = journal.issue(501, "/data", command("hello"), true).unwrap();
        journal.claim(501, "/data", &receipt, NONCE).unwrap();
        receipt
    }

    #[test]
    fn compaction_preserves_claim_set_and_rejects_replay() {
        let key = new_key().unwrap();
        let mut journal = Journal::new();
        let receipt = claimed(&mut journal);
        journal
            .finish(
                501,
                "/data",
                &receipt.key,
                json!({"status":"succeeded"}),
                true,
            )
            .unwrap();
        journal.compact(&key).unwrap();
        assert!(journal.entries.is_empty());
        let mut restored = Journal::open(
            &serde_json::to_vec(&journal).unwrap(),
            key.public_key().as_ref(),
        )
        .unwrap();
        assert!(restored
            .claim(501, "/data", &receipt, NONCE)
            .unwrap_err()
            .contains("already consumed"));
        // Repeated compaction must retain previous claims too.
        restored.compact(&key).unwrap();
        assert!(restored.claim(501, "/data", &receipt, NONCE).is_err());
    }

    #[test]
    fn compaction_never_reissues_a_consumed_submission() {
        let key = new_key().unwrap();
        let mut journal = Journal::new();
        let receipt = claimed(&mut journal);
        journal
            .finish(
                501,
                "/data",
                &receipt.key,
                json!({"status":"rejected"}),
                true,
            )
            .unwrap();
        journal.compact(&key).unwrap();
        assert!(journal
            .issue(501, "/data", command("hello"), true)
            .unwrap_err()
            .contains("already consumed"));
        assert!(journal
            .issue(501, "/data", command("changed"), true)
            .is_err());
        let mut other = command("new");
        other["args"]["requestId"] = json!("r2");
        assert!(journal.issue(501, "/data", other, true).is_ok());
    }

    #[test]
    fn compaction_leaves_live_unclaimed_receipts_claimable() {
        let key = new_key().unwrap();
        let mut journal = Journal::new();
        let receipt = journal.issue(501, "/data", command("hello"), true).unwrap();
        assert!(journal.entries[&receipt.key].issued_at > 0);
        journal.compact(&key).unwrap();
        journal.claim(501, "/data", &receipt, NONCE).unwrap();
    }

    #[test]
    fn compaction_does_not_fold_recent_unresolved_claims() {
        let key = new_key().unwrap();
        let mut journal = Journal::new();
        let receipt = claimed(&mut journal);
        assert!(journal.entries[&receipt.key].claimed_at > 0);
        journal.compact(&key).unwrap();
        journal
            .finish(
                501,
                "/data",
                &receipt.key,
                json!({"status":"succeeded"}),
                true,
            )
            .unwrap();
        // Legacy unknown-age claims must also remain finishable.
        let mut legacy = Journal::new();
        let r = claimed(&mut legacy);
        legacy.entries.get_mut(&r.key).unwrap().claimed_at = 0;
        legacy.compact(&key).unwrap();
        legacy
            .finish(501, "/data", &r.key, json!({"status":"succeeded"}), true)
            .unwrap();
    }

    #[test]
    fn archived_submission_finish_is_reported_not_silently_dropped() {
        let key = new_key().unwrap();
        let mut journal = Journal::new();
        let receipt = claimed(&mut journal);
        journal.entries.get_mut(&receipt.key).unwrap().claimed_at = 1;
        journal.compact(&key).unwrap();
        assert!(journal
            .finish(
                501,
                "/data",
                &receipt.key,
                json!({"status":"succeeded"}),
                true
            )
            .unwrap_err()
            .contains("archived"));
        assert!(journal
            .claim(501, "/data", &receipt, NONCE)
            .unwrap_err()
            .contains("already consumed"));
    }

    #[test]
    fn checkpoint_signature_is_verified_on_load() {
        let key = new_key().unwrap();
        let mut journal = Journal::new();
        let receipt = claimed(&mut journal);
        journal
            .finish(
                501,
                "/data",
                &receipt.key,
                json!({"status":"succeeded"}),
                true,
            )
            .unwrap();
        journal.compact(&key).unwrap();
        let bytes = serde_json::to_vec(&journal).unwrap();
        assert!(Journal::open(&bytes, new_key().unwrap().public_key().as_ref()).is_err());
        let mut altered: Value = serde_json::from_slice(&bytes).unwrap();
        altered["checkpoint"]["payload"] = json!(altered["checkpoint"]["payload"]
            .as_str()
            .unwrap()
            .replace("checkpoint", "tampered"));
        assert!(Journal::open(
            &serde_json::to_vec(&altered).unwrap(),
            key.public_key().as_ref()
        )
        .is_err());
    }

    #[test]
    fn expired_unclaimed_receipt_fails_closed_and_can_be_reissued() {
        let key = new_key().unwrap();
        let mut journal = Journal::new();
        let receipt = journal.issue(501, "/data", command("hello"), true).unwrap();
        journal.entries.get_mut(&receipt.key).unwrap().issued_at = 1;
        journal.compact(&key).unwrap();
        assert!(journal.claim(501, "/data", &receipt, NONCE).is_err());
        let fresh = journal.issue(501, "/data", command("hello"), true).unwrap();
        assert_ne!(fresh, receipt);
        assert!(journal.claim(501, "/data", &receipt, NONCE).is_err());
        journal.claim(501, "/data", &fresh, NONCE).unwrap();
    }

    #[test]
    fn compact_if_due_is_testable_with_a_low_threshold() {
        let key = new_key().unwrap();
        let mut journal = Journal::new();
        let receipt = claimed(&mut journal);
        journal
            .finish(
                501,
                "/data",
                &receipt.key,
                json!({"status":"succeeded"}),
                true,
            )
            .unwrap();
        assert!(!journal.compact_if_due(&key, 2).unwrap());
        assert!(journal.compact_if_due(&key, 1).unwrap());
        assert!(journal.entries.is_empty());
        assert!(journal.issue(501, "/data", command("hello"), true).is_err());
    }

    #[test]
    fn legacy_journal_without_checkpoint_or_timestamps_remains_usable() {
        let key = new_key().unwrap();
        let mut journal = Journal::new();
        let receipt = claimed(&mut journal);
        let mut value = serde_json::to_value(&journal).unwrap();
        value.as_object_mut().unwrap().remove("checkpoint");
        let entry = value["entries"][&receipt.key].as_object_mut().unwrap();
        entry.remove("issued_at");
        entry.remove("claimed_at");
        entry
            .get_mut("receipt")
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove("issuanceId");
        let mut receipt = receipt;
        receipt.issuance_id = None;
        let mut restored = Journal::open(
            &serde_json::to_vec(&value).unwrap(),
            key.public_key().as_ref(),
        )
        .unwrap();
        restored.compact(&key).unwrap();
        restored
            .finish(
                501,
                "/data",
                &receipt.key,
                json!({"status":"succeeded"}),
                true,
            )
            .unwrap();
    }

    #[test]
    fn signed_malformed_checkpoint_and_live_overlap_are_rejected() {
        let key = new_key().unwrap();
        let mut journal = Journal::new();
        let receipt = claimed(&mut journal);
        let entry = journal.entries[&receipt.key].clone();
        journal
            .finish(
                501,
                "/data",
                &receipt.key,
                json!({"status":"succeeded"}),
                true,
            )
            .unwrap();
        journal.compact(&key).unwrap();
        let original = journal.checkpoint.clone().unwrap();
        for field in ["domain", "kind", "generation", "resolved"] {
            let mut payload = verify(key.public_key().as_ref(), &original).unwrap();
            payload[field] = match field {
                "domain" | "kind" => json!("wrong"),
                _ => json!(0),
            };
            journal.checkpoint = Some(sign(&key, &payload).unwrap());
            assert!(Journal::open(
                &serde_json::to_vec(&journal).unwrap(),
                key.public_key().as_ref()
            )
            .is_err());
        }
        journal.checkpoint = Some(original);
        journal.entries.insert(receipt.key, entry);
        assert!(Journal::open(
            &serde_json::to_vec(&journal).unwrap(),
            key.public_key().as_ref()
        )
        .is_err());
    }

    #[test]
    fn compaction_relieves_the_live_entry_limit_without_forgetting_claims() {
        let key = new_key().unwrap();
        let mut journal = Journal::new();
        let first = claimed(&mut journal);
        journal
            .finish(
                501,
                "/data",
                &first.key,
                json!({"status":"succeeded"}),
                true,
            )
            .unwrap();
        for i in 1..100_000 {
            let mut c = command("hello");
            c["args"]["requestId"] = json!(format!("request-{i}"));
            journal.issue(501, "/data", c, true).unwrap();
        }
        let mut extra = command("extra");
        extra["args"]["requestId"] = json!("extra");
        assert!(journal.issue(501, "/data", extra.clone(), true).is_err());
        assert!(journal.compact_if_due(&key, COMPACT_AT).unwrap());
        journal.issue(501, "/data", extra, true).unwrap();
        assert!(journal
            .claim(501, "/data", &first, NONCE)
            .unwrap_err()
            .contains("already consumed"));
    }

    #[test]
    fn expiry_is_enforced_without_reaching_compaction_threshold() {
        let mut journal = Journal::new();
        let receipt = journal.issue(501, "/data", command("hello"), true).unwrap();
        journal.entries.get_mut(&receipt.key).unwrap().issued_at = 1;
        assert!(journal
            .claim(501, "/data", &receipt, NONCE)
            .unwrap_err()
            .contains("expired"));
        let renewed = journal.issue(501, "/data", command("hello"), true).unwrap();
        assert_ne!(renewed, receipt);
        assert!(journal.claim(501, "/data", &receipt, NONCE).is_err());
        journal.claim(501, "/data", &renewed, NONCE).unwrap();
    }

    #[test]
    fn failed_compaction_preserves_the_live_journal() {
        let key = new_key().unwrap();
        let mut journal = Journal::new();
        let receipt = claimed(&mut journal);
        journal
            .finish(
                501,
                "/data",
                &receipt.key,
                json!({"status":"succeeded"}),
                true,
            )
            .unwrap();
        journal.checkpoint = Some(
            sign(
                &key,
                &json!({
                    "domain": DOMAIN, "kind":"checkpoint", "generation": u64::MAX,
                    "claims":{}, "folded":0, "resolved":0, "orphaned":0, "expired":0
                }),
            )
            .unwrap(),
        );
        let before = serde_json::to_vec(&journal).unwrap();
        assert!(journal.compact(&key).is_err());
        assert_eq!(serde_json::to_vec(&journal).unwrap(), before);
        assert!(journal
            .claim(501, "/data", &receipt, NONCE)
            .unwrap_err()
            .contains("already consumed"));
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
        let mut restored: Journal = Journal::open(
            &serde_json::to_vec(&journal).unwrap(),
            new_key().unwrap().public_key().as_ref(),
        )
        .unwrap();
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
        let restored = Journal::open(&bytes, new_key().unwrap().public_key().as_ref()).unwrap();
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
        let restored: Journal = Journal::open(
            &serde_json::to_vec(&journal).unwrap(),
            new_key().unwrap().public_key().as_ref(),
        )
        .unwrap();
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

    fn task_action(action:&str, qualified:bool)->Value {
        let mut command=json!({"cmd":"assistant_task_action","args":{"taskId":"task-1","revision":4,"action":action,"owner":{"workspaceId":"qa","cwd":"/qa","hostId":"local","conversationId":"monitor"}}});
        if qualified {command["provenanceRequestId"]=json!(format!("task-action:{action}"));}
        command
    }
    fn startup_preflight(thread: &str) -> Value {
        let mut command=task_action("revise_startup",true);
        command["provenanceRequestId"]=json!("task-action:revise_startup:content-v1");
        command["args"]["mode"]=json!("isolated");
        command["args"]["destination"]=json!({"threadId":thread,"workers":["worker"],"newThread":false});
        command
    }
    #[test]
    fn startup_preflight_content_can_change_after_failure_without_reusing_authority() {
        let mut journal=Journal::new();
        let first=journal.issue(501,"/data",startup_preflight("worker-a"),true).unwrap();
        assert_eq!(first,journal.issue(501,"/data",startup_preflight("worker-a"),true).unwrap());
        let second=journal.issue(501,"/data",startup_preflight("worker-b"),true).unwrap();
        assert_ne!(first.key,second.key,"a different preflight destination needs its own exact authority");
        let mut other_worker=startup_preflight("worker-a");other_worker["args"]["destination"]["workers"]=json!(["replacement-worker"]);
        assert_ne!(first.key,journal.issue(501,"/data",other_worker,true).unwrap().key,"switching workers is a distinct preflight even in the same room");
        let mut altered=startup_preflight("worker-a");altered["args"]["owner"]["cwd"]=json!("/other");
        assert_ne!(first.key,journal.issue(501,"/data",altered,true).unwrap().key,"all preflight content is bound");
        journal.claim(501,"/data",&second,NONCE).unwrap();
        assert!(journal.claim(501,"/data",&second,NONCE).is_err());
        journal.finish(501,"/data",&second.key,json!({"status":"succeeded"}),true).unwrap();
        let key=new_key().unwrap();journal.compact(&key).unwrap();
        let mut reopened=Journal::open(&serde_json::to_vec(&journal).unwrap(),key.public_key().as_ref()).unwrap();
        assert!(reopened.issue(501,"/data",startup_preflight("worker-b"),true).is_err(),"compaction must not revive consumed content");
        assert!(reopened.claim(501,"/data",&second,NONCE).is_err());
        assert_eq!(first,reopened.issue(501,"/data",startup_preflight("worker-a"),true).unwrap());
    }
    #[test]
    fn startup_preflight_migrates_only_unclaimed_legacy_receipts_and_keeps_originals() {
        for qualified in [false,true] {
            let mut journal=Journal::new();let mut old_command=startup_preflight("failed-worker");
            if qualified {old_command["provenanceRequestId"]=json!("task-action:revise_startup");} else {old_command.as_object_mut().unwrap().remove("provenanceRequestId");}
            let old=journal.issue(501,"/data",old_command,true).unwrap();
            let next=journal.issue(501,"/data",startup_preflight("different-worker"),true).unwrap();
            assert_ne!(old.key,next.key);
            assert_eq!(journal.entries.get(&old.key).unwrap().receipt,old,"migration never edits protected originals");
            let key=new_key().unwrap();let mut reopened=Journal::open(&serde_json::to_vec(&journal).unwrap(),key.public_key().as_ref()).unwrap();
            assert_eq!(next,reopened.issue(501,"/data",startup_preflight("different-worker"),true).unwrap());
            reopened.claim(501,"/data",&old,NONCE).unwrap();
            assert!(reopened.issue(501,"/data",startup_preflight("third-worker"),true).is_err(),"a consumed legacy action remains a barrier");
            reopened.finish(501,"/data",&old.key,json!({"status":"succeeded"}),true).unwrap();reopened.compact(&key).unwrap();
            assert!(reopened.issue(501,"/data",startup_preflight("fourth-worker"),true).is_err(),"compacted legacy authority stays blocked");
        }
    }
    #[test]
    fn content_preflight_marker_cannot_change_other_task_action_keys() {
        let mut journal=Journal::new();
        for action in ["approve","retry","cancel"] {
            let mut forged=task_action(action,true);forged["provenanceRequestId"]=json!("task-action:revise_startup:content-v1");
            assert!(journal.issue(501,"/data",forged,true).is_err());
        }
    }
    #[test]
    fn task_actions_allow_cancel_after_rejected_retry_but_never_replay_the_same_action() {
        let mut journal=Journal::new();
        let retry=journal.issue(501,"/data",task_action("retry",true),true).unwrap();
        journal.claim(501,"/data",&retry,NONCE).unwrap();
        journal.finish(501,"/data",&retry.key,json!({"status":"rejected"}),true).unwrap();
        let cancel=journal.issue(501,"/data",task_action("cancel",true),true).unwrap();
        assert_ne!(retry.key,cancel.key);journal.claim(501,"/data",&cancel,NONCE).unwrap();
        let repeated=journal.issue(501,"/data",task_action("retry",true),true).unwrap();assert_eq!(repeated,retry);
        assert!(journal.issue(501,"/data",task_action("retry",false),true).unwrap_err().contains("action-qualified submission"));
        assert!(journal.claim(501,"/data",&repeated,NONCE).unwrap_err().contains("already consumed"));
        let mut changed=task_action("retry",true);changed["args"]["owner"]["cwd"]=json!("/other");
        assert!(journal.issue(501,"/data",changed,true).unwrap_err().contains("conflicts"));
        let mut mismatched=task_action("cancel",true);mismatched["provenanceRequestId"]=json!("task-action:retry");
        assert!(journal.issue(501,"/data",mismatched,true).is_err());
    }
    #[test]
    fn legacy_task_receipts_load_and_keep_same_action_replay_barriers_after_upgrade() {
        let mut journal=Journal::new();let legacy=journal.issue(501,"/data",task_action("retry",false),true).unwrap();
        journal.claim(501,"/data",&legacy,NONCE).unwrap();journal.finish(501,"/data",&legacy.key,json!({"status":"rejected"}),true).unwrap();
        let key=new_key().unwrap();let mut restored=Journal::open(&serde_json::to_vec(&journal).unwrap(),key.public_key().as_ref()).unwrap();
        assert!(restored.issue(501,"/data",task_action("retry",true),true).unwrap_err().contains("legacy submission"));
        let cancel=restored.issue(501,"/data",task_action("cancel",true),true).unwrap();assert_ne!(cancel.key,legacy.key);restored.claim(501,"/data",&cancel,NONCE).unwrap();
        assert!(restored.claim(501,"/data",&legacy,NONCE).is_err());
        let mut compacted=journal;compacted.compact(&key).unwrap();
        assert!(compacted.issue(501,"/data",task_action("cancel",true),true).unwrap_err().contains("Historical task submission"));
    }

    #[test]
    fn legacy_import_apply_is_issued_only_for_trusted_ui_and_bound_to_a_delivery_id() {
        let mut journal = Journal::new();
        let apply = |delivery: Option<&str>| {
            let mut command = json!({"cmd":"legacy_import_apply","args":{"snapshot":"20261022-101501","sources":{"assistant-tasks-v1.json":"ab"}}});
            if let Some(id) = delivery { command["provenanceRequestId"] = json!(id); }
            command
        };
        assert!(journal.issue(501, "/data", apply(Some("d-1")), false).is_err());
        assert!(journal.issue(501, "/data", apply(None), true).is_err());
        let receipt = journal.issue(501, "/data", apply(Some("d-1")), true).unwrap();
        assert_eq!(receipt.command, apply(Some("d-1")));
        let mut changed = apply(Some("d-1"));
        changed["args"]["sources"]["assistant-tasks-v1.json"] = json!("cd");
        assert!(journal.issue(501, "/data", changed, true).is_err());
        for read_only in ["legacy_import_preview", "legacy_import_history"] {
            assert!(journal.issue(501, "/data", json!({"cmd":read_only,"args":{},"provenanceRequestId":"d-2"}), true).is_err());
        }
    }

    #[test]
    fn claim_is_durable_and_cannot_be_replayed_after_reload() {
        let mut journal = Journal::new();
        let receipt = journal.issue(501, "/data", command("hello"), true).unwrap();
        journal
            .claim(501, "/data", &receipt, "0123456789abcdef0123456789abcdef")
            .unwrap();
        let mut restored: Journal = Journal::open(
            &serde_json::to_vec(&journal).unwrap(),
            new_key().unwrap().public_key().as_ref(),
        )
        .unwrap();
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

    #[test]
    fn project_memory_is_an_accepted_protected_ledger_name() {
        assert!(document_key(501, "/data", "project-memory-v1.json").is_ok());
    }

    #[test]
    fn project_memory_ledger_name_is_exactly_scoped() {
        // Near-misses and traversal must not be accepted as the same ledger.
        for name in [
            "project-memory-v2.json",
            "project-memory-v1.json.bak",
            "../project-memory-v1.json",
            "Project-Memory-v1.json",
            "",
        ] {
            assert!(
                document_key(501, "/data", name).is_err(),
                "accepted protected ledger name: {name}"
            );
        }
        // The data directory must still be absolute.
        assert!(document_key(501, "relative", "project-memory-v1.json").is_err());
    }

    // Checklist: "Crash between claim/dispatch/outcome, then verify uncertain
    // status and no repeated effects." The claim is consumed before dispatch, so
    // a daemon that dies after claiming leaves one claim with no outcome, and
    // neither a retry nor a re-issued identical request can repeat the effect.
    #[test]
    fn a_crash_between_claim_and_outcome_leaves_one_claim_and_no_replay() {
        let key = new_key().unwrap();
        let mut journal = Journal::new();
        let receipt = journal.issue(501, "/data", command("hello"), true).unwrap();
        journal.claim(501, "/data", &receipt, NONCE).unwrap();
        // The daemon dies here, before anything records an outcome.
        let mut recovered =
            Journal::open(&serde_json::to_vec(&journal).unwrap(), key.public_key().as_ref())
                .unwrap();
        let entry = &recovered.entries[&receipt.key];
        assert!(
            entry.claimed && entry.outcome.is_none(),
            "a claimed submission with no outcome is uncertain, never succeeded"
        );
        // The retry says so, rather than running the same effect a second time.
        assert!(recovered
            .claim(501, "/data", &receipt, NONCE)
            .unwrap_err()
            .contains("uncertain"));
        assert!(recovered
            .claim(501, "/data", &receipt, "fedcba9876543210fedcba9876543210")
            .unwrap_err()
            .contains("uncertain"));
        // An identical request hands back its original token; no new effect exists.
        let again = recovered.issue(501, "/data", command("hello"), true).unwrap();
        assert_eq!(again.issuance_id, receipt.issuance_id);
        assert_eq!(recovered.entries.len(), 1);
        // The recovered daemon records the outcome it does know, and only once.
        assert!(recovered
            .finish(
                501,
                "/data",
                &receipt.key,
                json!({"status":"succeeded"}),
                false
            )
            .is_err());
        recovered
            .finish(501, "/data", &receipt.key, json!({"status":"succeeded"}), true)
            .unwrap();
        assert!(recovered
            .finish(501, "/data", &receipt.key, json!({"status":"rejected"}), true)
            .is_err());
        // A changed request is a new effect only under a new request ID.
        assert!(recovered
            .issue(501, "/data", command("changed"), true)
            .is_err());
        let mut fresh = command("changed");
        fresh["args"]["requestId"] = json!("r2");
        assert!(recovered.issue(501, "/data", fresh, true).is_ok());
    }

    // Checklist: "test concurrent compare-and-swap". The broker applies every
    // request to the committed journal (main.rs clones it, then commits), so two
    // writers that read the same revision cannot both commit: the second is
    // refused and the first writer's document stands.
    #[test]
    fn two_writers_from_the_same_read_commit_once_and_the_second_is_refused() {
        let name = "assistant-tasks-v1.json";
        let mut journal = Journal::new();
        journal
            .write_document(501, "/data", name, 0, json!({"writer":"start"}), true)
            .unwrap();
        // Each request begins from its own copy of the journal.
        let mut first = journal.clone();
        let mut second = journal.clone();
        first
            .write_document(501, "/data", name, 1, json!({"writer":"first"}), true)
            .unwrap();
        // On its own stale copy the second would have committed: the lost update
        // that committing only through the authoritative journal prevents.
        second
            .write_document(501, "/data", name, 1, json!({"writer":"second"}), true)
            .unwrap();
        let mut committed = first.clone();
        assert!(committed
            .write_document(501, "/data", name, 1, json!({"writer":"second"}), true)
            .unwrap_err()
            .contains("changed"));
        let current = committed.read_document(501, "/data", name, true).unwrap();
        assert_eq!(current.value, json!({"writer":"first"}));
        assert_eq!(current.revision, 2);
        // The refused writer reloads and writes again at the revision it just read.
        committed
            .write_document(
                501,
                "/data",
                name,
                current.revision,
                json!({"writer":"second"}),
                true,
            )
            .unwrap();
        assert_eq!(
            committed
                .read_document(501, "/data", name, true)
                .unwrap()
                .value,
            json!({"writer":"second"})
        );
    }
}
