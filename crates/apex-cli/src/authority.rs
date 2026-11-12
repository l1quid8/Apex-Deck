//! Terminal submissions use the existing root broker, never a local trust token.
//! Call only after an explicit user submit/decision, never during state refresh.
#[cfg(unix)]
use apex_provenance::{
    io::{read_frame, root_file},
    ROOT, SOCKET,
};
use apex_provenance::{verify, Receipt, Signed, DOMAIN};
use serde_json::{json, Value};
use std::{io::IsTerminal, path::Path};
#[cfg(unix)]
use std::{io::Write, os::unix::net::UnixStream, time::Duration};

pub type AuthorityError = String;
const LIMIT: usize = 1024 * 1024;

fn check_environment(
    vars: impl IntoIterator<Item = (String, String)>,
) -> Result<(), AuthorityError> {
    for (name, value) in vars {
        if value.is_empty() {
            continue;
        }
        // Deck injects these context hints into agent terminals. This client
        // never reads them to choose transport, authority, routing or binaries.
        let benign_context = matches!(
            name.as_str(),
            "APEX_DECK_DATA_DIR"
                | "APEX_DECK_BIN"
                | "APEX_DECK_BOT"
                | "APEX_DECK_BOT_NAME"
                | "APEX_DECK_ROOM"
                | "APEX_DECK_PHONE_SOCKET"
        );
        if (name.starts_with("APEX_") && !benign_context)
            || name.starts_with("DYLD_")
            || name.starts_with("ELECTRON_")
            || matches!(
                name.as_str(),
                "NODE_OPTIONS" | "LD_PRELOAD" | "LD_LIBRARY_PATH"
            )
        {
            return Err(format!(
                "Trusted Apex CLI refuses runtime override {name}. Remove it before launching."
            ));
        }
        if name == "APEX_DECK_DATA_DIR" && !Path::new(&value).is_absolute() {
            return Err("Apex data directory must be absolute.".into());
        }
    }
    Ok(())
}

/// Linux: refuse ptrace and core dumps from other same-user processes for
/// the life of this terminal. It only narrows the attack; the jail is the
/// boundary. Never fails startup.
pub fn harden_process() {
    #[cfg(target_os = "linux")]
    unsafe {
        libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0);
    }
}

pub fn assert_trusted_startup() -> Result<(), AuthorityError> {
    if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
        return Err("Apex CLI requires an interactive terminal; piped commands and stdin submissions are refused.".into());
    }
    // This applies to development binaries too. There is no development
    // authority switch; the broker independently checks the exact signed peer.
    check_environment(std::env::vars())
}

fn supported(name: &str) -> bool {
    matches!(
        name,
        "room_post"
            | "room_decide"
            | "room_answer"
            | "room_set_plan"
            | "room_runner_start"
            | "room_runner_action"
            | "room_add_participant"
            | "room_update_participant"
            | "room_remove_participant"
            | "room_set_options"
            | "room_apply_access"
            | "room_state"
            | "room_stop"
            | "room_clear"
            | "room_compact"
            | "room_curate"
            | "room_curate_undo"
            | "room_bot_models"
            | "room_runner_state"
            | "agent_models"
            | "chat_list"
            | "chat_profiles"
            | "chat_create"
            | "chat_update_meta"
            | "chat_add_participant"
            | "chat_update_participant"
            | "chat_remove_participant"
            | "chat_message_claim"
            | "session_load"
            | "session_save"
            | "agent_profile_list"
            | "agent_profile_save"
            | "provider_setup_begin"
            | "backend_stop"
            | "room_create"
    )
}

fn needs_authority(command: &Value) -> Result<bool, AuthorityError> {
    let name = command["cmd"].as_str().ok_or("Missing command")?;
    if !supported(name) {
        return Err("Command is outside the interactive CLI surface.".into());
    }
    // Do not accept transport metadata or a nested/generic signing interface
    // from the caller. The authority function creates its own delivery ID.
    let fields = command.as_object().ok_or("Invalid command")?;
    if fields.keys().any(|key| key != "cmd" && key != "args") {
        return Err("Unexpected command envelope fields.".into());
    }
    let parsed = apex_host::Command::from_json(command.clone())?;
    Ok(parsed.requires_provenance())
}

fn validate_receipt(
    signed: &Signed,
    key: &[u8],
    uid: u32,
    folder: &str,
    command: &Value,
) -> Result<(), AuthorityError> {
    if signed.payload.len() > LIMIT {
        return Err("Oversized provenance response.".into());
    }
    let value = verify(key, signed)?;
    if value["domain"] != DOMAIN || value["kind"] != "submission" {
        return Err("Not a submission receipt.".into());
    }
    let receipt: Receipt =
        serde_json::from_value(value["receipt"].clone()).map_err(|e| e.to_string())?;
    if receipt.uid != uid || receipt.data_dir != folder || receipt.command != *command {
        return Err("Receipt does not match this user, data directory and exact command.".into());
    }
    Ok(())
}

/// Returns an ordinary typed command or an existing-format provenance_execute.
/// A failure after sending to the broker is never automatically retried.
#[cfg(unix)]
pub async fn authorize(command: Value, data: &Path) -> Result<Value, AuthorityError> {
    if !needs_authority(&command)? {
        return Ok(command);
    }
    assert_trusted_startup()?;
    // Linux has no root broker. The same-user daemon admits this exact typed
    // surface only after its agent-jail boot probe passed; it decides, not us.
    #[cfg(target_os = "linux")]
    {
        let _ = data;
        return Ok(command);
    }
    #[cfg(not(target_os = "linux"))]
    let data = data.to_owned();
    tokio::task::spawn_blocking(move || {
        let folder = data.canonicalize().map_err(|e| format!("Cannot resolve Apex data directory: {e}"))?;
        let folder = folder.to_str().ok_or("Apex data directory is not UTF-8")?;
        let mut command = command;
        command["provenanceRequestId"] = json!(uuid::Uuid::new_v4().to_string());
        let key = root_file(&Path::new(ROOT).join("public-key"))
            .map_err(|e| format!("Protected commands require the installed signed Apex CLI and provenance service: {e}"))?;
        let mut stream = UnixStream::connect(SOCKET)
            .map_err(|e| format!("Protected provenance service unavailable; submission was not sent: {e}"))?;
        stream.set_read_timeout(Some(Duration::from_secs(30))).map_err(|e| e.to_string())?;
        stream.set_write_timeout(Some(Duration::from_secs(30))).map_err(|e| e.to_string())?;
        let request = json!({"op":"issue","dataDir":folder,"command":command});
        let mut bytes = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        if bytes.len() > LIMIT { return Err("Submission exceeds provenance limit.".into()); }
        stream.write_all(&bytes).map_err(|e| format!("Receipt outcome unknown; refresh before retrying: {e}"))?;
        let response = read_frame(&mut stream).map_err(|e| format!("Receipt outcome unknown; refresh before retrying: {e}"))?;
        if let Some(error) = response["error"].as_str() {
            return Err(format!("Provenance refused this submission: {error} Use the installed signed Apex CLI."));
        }
        let signed: Signed = serde_json::from_value(response).map_err(|e| e.to_string())?;
        validate_receipt(&signed, &key, unsafe { libc::geteuid() }, folder, &command)?;
        Ok(json!({"cmd":"provenance_execute","args":{"receipt":signed}}))
    }).await.map_err(|e| format!("Provenance worker failed; submission outcome is unknown: {e}"))?
}

#[cfg(not(unix))]
pub async fn authorize(command: Value, _data: &Path) -> Result<Value, AuthorityError> {
    if !needs_authority(&command)? {
        return Ok(command);
    }
    Err(
        "Protected CLI commands are not supported on this platform; use the installed Apex app."
            .into(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::KeyPair;
    #[test]
    fn runtime_injection_and_generic_command_signing_are_refused() {
        for name in [
            "DYLD_INSERT_LIBRARIES",
            "LD_PRELOAD",
            "APEX_CLI_TRUSTED",
            "NODE_OPTIONS",
        ] {
            assert!(check_environment([(name.into(), "bad".into())]).is_err());
        }
        assert!(check_environment([("APEX_DECK_DATA_DIR".into(), "/tmp/test".into())]).is_ok());
        for name in [
            "APEX_DECK_BIN",
            "APEX_DECK_BOT",
            "APEX_DECK_BOT_NAME",
            "APEX_DECK_ROOM",
            "APEX_DECK_PHONE_SOCKET",
        ] {
            assert!(check_environment([(name.into(), "ignored context".into())]).is_ok());
        }
        assert!(check_environment([("APEX_DECK_DATA_DIR".into(), "relative".into())]).is_err());
        for name in [
            "provenance_execute",
            "devices_add",
            "personal_permission_set",
            "unknown",
        ] {
            assert!(needs_authority(&json!({"cmd":name,"args":{}})).is_err());
        }
        assert!(
            needs_authority(&json!({"cmd":"room_set_plan","args":{"id":"r","on":true}})).unwrap()
        );
        assert!(!needs_authority(&json!({"cmd":"chat_list","args":{}})).unwrap());
        assert!(
            !needs_authority(&json!({"cmd":"room_post","args":{"id":"r","text":"hello"}})).unwrap()
        );
    }
    #[test]
    fn signed_receipt_binds_identity_scope_and_every_command_byte() {
        let key = apex_provenance::new_key().unwrap();
        let command = json!({"cmd":"room_set_plan","args":{"id":"r","on":true},"provenanceRequestId":"delivery-1"});
        let payload = json!({"domain":DOMAIN,"kind":"submission","receipt":{"uid":501,"dataDir":"/data","command":command,"key":"key"}});
        let signed = apex_provenance::sign(&key, &payload).unwrap();
        let public = key.public_key().as_ref();
        validate_receipt(&signed, public, 501, "/data", &command).unwrap();
        assert!(validate_receipt(&signed, public, 502, "/data", &command).is_err());
        assert!(validate_receipt(&signed, public, 501, "/other", &command).is_err());
        let mut changed = command.clone();
        changed["args"]["on"] = json!(false);
        assert!(validate_receipt(&signed, public, 501, "/data", &changed).is_err());
        let mut tampered = signed.clone();
        tampered.payload.push(' ');
        assert!(validate_receipt(&tampered, public, 501, "/data", &command).is_err());
        for field in ["domain", "kind"] {
            let mut wrong = payload.clone();
            wrong[field] = json!("other");
            assert!(validate_receipt(
                &apex_provenance::sign(&key, &wrong).unwrap(),
                public,
                501,
                "/data",
                &command
            )
            .is_err());
        }
    }
    #[tokio::test]
    async fn unsigned_noninteractive_protected_attempt_fails_closed() {
        if !std::io::stdin().is_terminal() {
            let error = authorize(
                json!({"cmd":"room_set_plan","args":{"id":"r","on":true}}),
                Path::new("/tmp"),
            )
            .await
            .unwrap_err();
            #[cfg(unix)]
            assert!(error.contains("interactive terminal"));
            #[cfg(not(unix))]
            assert!(error.contains("not supported on this platform"));
        }
        assert_eq!(
            authorize(json!({"cmd":"chat_list","args":{}}), Path::new("/tmp"))
                .await
                .unwrap(),
            json!({"cmd":"chat_list","args":{}})
        );
    }
}
