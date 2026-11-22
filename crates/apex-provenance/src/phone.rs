//! A phone intent is attested by the pinned daemon's authenticated iroh
//! session, and authorized by the broker's protected device grant. User-owned
//! registry files and local-socket requests are never admission evidence.
use crate::{Journal, DOMAIN};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub fn phone_command(
    endpoint: &str,
    session: &str,
    id: u64,
    mut command: Value,
) -> Result<Value, String> {
    if endpoint.len() != 64
        || !endpoint
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || session.len() != 32
        || !session.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("Invalid authenticated phone identity".into());
    }
    if command
        .as_object()
        .is_none_or(|o| o.len() != 2 || !o.contains_key("cmd") || !o.contains_key("args"))
        || !command["args"].is_object()
    {
        return Err("Expected exact phone command and args".into());
    }
    command["provenanceRequestId"] = json!(format!("phone:{endpoint}:{session}:{id}"));
    Ok(command)
}

pub(crate) fn phone_key(
    uid: u32,
    data_dir: &str,
    command: &Value,
) -> Option<Result<String, String>> {
    let id = command["provenanceRequestId"]
        .as_str()?
        .strip_prefix("phone:")?;
    Some(
        serde_json::to_vec(&(DOMAIN, uid, data_dir, "phone_intent", id))
            .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
            .map_err(|e| e.to_string()),
    )
}

impl Journal {
    /// Check the CURRENT grant and consume the exact intent in one broker
    /// transaction. The caller must fsync before returning the signed claim.
    pub fn claim_device_command(
        &mut self,
        uid: u32,
        data_dir: &str,
        endpoint: &str,
        session: &str,
        id: u64,
        command: Value,
        assistant_room: bool,
        nonce: &str,
        trusted_daemon: bool,
    ) -> Result<Value, String> {
        if !trusted_daemon {
            return Err("Phone admission requires the pinned daemon".into());
        }
        let document = self.read_document(uid, data_dir, "devices.json", true)?;
        let registry = &document.value;
        if registry["version"] != 1 {
            return Err(
                "No protected phone grant; approve this phone in the installed Apex Deck app".into(),
            );
        }
        if registry["revoked"]
            .as_array()
            .is_none_or(|rs| rs.iter().any(|r| r["endpointId"] == endpoint))
        {
            return Err("This phone is revoked or its protected registry is invalid".into());
        }
        let _device = registry["devices"]
            .as_array()
            .and_then(|ds| ds.iter().find(|d| d["endpointId"] == endpoint))
            .ok_or("No protected grant for this phone")?;
        // Kept in the wire request (`phone_claim`) so broker and daemon wire format
        // does not change in this PR; a granted, unrevoked phone has full access.
        let _ = assistant_room;
        let name = command["cmd"].as_str().ok_or("Missing phone command")?;
        // Explicit allowlist: a granted, unrevoked phone may submit every
        // allowlisted intent. Never delegate UI receipts, pairing, migration or
        // device administration back to a paired device.
        match name {
            "room_post" | "room_post_to" | "room_turn" | "room_decide" | "room_answer"
            | "room_runner_start" | "room_runner_action" | "room_set_plan"
            | "room_mount"
            | "room_update_participant"
            | "room_add_participant"
            | "room_remove_participant"
            | "room_set_options"
            | "room_forget_allowed"
            | "room_create" | "room_import" | "room_fork" | "chat_promote" | "room_thread_git_action" => {}
            // User decision (2026-11-20): a paired phone may change these two Mac-wide UCU settings.
            "computer_set_enabled" | "computer_set_app_prompts" => {}
            _ if crate::protected(name)
                && (name.starts_with("personal_")
                    || name.starts_with("assistant_")
                    || name.starts_with("project_memory_")
                    || name == "project_task_lifecycle") => {}
            _ => return Err("Command cannot acquire phone submission authority".into()),
        }
        let command = phone_command(endpoint, session, id, command)?;
        let receipt = self.issue(uid, data_dir, command, true)?;
        self.claim(uid, data_dir, &receipt, nonce)
    }
}
