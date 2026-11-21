use apex_provenance::Journal;
use serde_json::{json, Value};
const UID: u32 = 501;
const FOLDER: &str = "/tmp/phone-admission";
fn endpoint() -> String {
    "ab".repeat(32)
}
fn grant_raw(j: &mut Journal, device: Value, revoked: bool) {
    let current = j.read_document(UID, FOLDER, "devices.json", true).unwrap();
    j.write_document(
        UID,
        FOLDER,
        "devices.json",
        current.revision,
        json!({
            "version": 1,
            "devices": [device],
            "revoked": if revoked { json!([{"endpointId": endpoint()}]) } else { json!([]) }
        }),
        true,
    )
    .unwrap();
}
fn grant(j: &mut Journal, revoked: bool) {
    grant_raw(j, json!({"endpointId": endpoint()}), revoked);
}
fn command(name: &str) -> Value {
    let args = match name {
        "room_create" => {
            json!({"id":"r","participants":[],"options":{"policy":"mention","max_bot_hops":0},"cwd":null})
        }
        "room_decide" => json!({"id":"r","request":"approval-1","approve":true,"always":false}),
        "room_answer" => json!({"id":"r","request":"question-1","answers":[["yes"]]}),
        "personal_todo" => json!({"assistantId":"a","expectedRevision":2,"action":"add","text":"Buy cable"}),
        "computer_set_enabled" => json!({"enabled":true}),
        "computer_set_app_prompts" => json!({"skip":true}),
        "computer_setup" => json!({}),
        "computer_set_action_labels" => json!({"enabled":true}),
        _ => json!({"id":"r","text":"hello"}),
    };
    json!({"cmd":name,"args":args})
}
fn claim(
    j: &mut Journal,
    id: u64,
    cmd: Value,
    trusted: bool,
    assistant_room: bool,
) -> Result<Value, String> {
    j.claim_device_command(
        UID,
        FOLDER,
        &endpoint(),
        &"cd".repeat(16),
        id,
        cmd,
        assistant_room,
        &"ef".repeat(16),
        trusted,
    )
}
#[test]
fn authenticated_full_phone_can_create_and_approve_without_desktop_receipt() {
    let mut j = Journal::new();
    grant(&mut j, false);
    for (id, name) in ["room_create", "room_decide", "room_answer"]
        .iter()
        .enumerate()
    {
        let original = command(name);
        let ack = claim(&mut j, id as u64, original.clone(), true, false).unwrap();
        assert_eq!(ack["kind"], "claim");
        assert_eq!(ack["receipt"]["command"]["args"], original["args"]);
    }
}
#[test]
fn admission_requires_pinned_daemon_and_protected_device_grant() {
    let mut j = Journal::new();
    assert!(claim(&mut j, 1, command("room_create"), true, false).is_err());
    grant(&mut j, false);
    assert!(claim(&mut j, 1, command("room_create"), false, false).is_err());
    for name in ["provenance_execute", "devices_add", "pair_approve", "legacy_import_apply"] {
        assert!(claim(&mut j, 1, command(name), true, false).is_err(), "{name} acquired phone authority");
    }
}
#[test]
fn any_granted_phone_is_admitted_whatever_its_old_level() {
    for (tier, threads) in [("read_only", json!(["r"])), ("chat", json!("all")), ("full", json!(["other"]))] {
        let mut j = Journal::new();
        grant_raw(&mut j, json!({"endpointId": endpoint(), "tier": tier, "threads": threads}), false);
        assert!(claim(&mut j, 1, command("room_post"), true, false).is_ok(), "{tier} room_post");
        assert!(claim(&mut j, 2, command("room_create"), true, false).is_ok(), "{tier} room_create");
        assert!(claim(&mut j, 3, command("room_decide"), true, true).is_ok(), "{tier} assistant approval");
        assert!(claim(&mut j, 4, command("personal_todo"), true, false).is_ok(), "{tier} task manager");
    }
}
#[test]
fn a_grant_without_level_keys_is_admitted() {
    let mut j = Journal::new();
    grant_raw(&mut j, json!({"endpointId": endpoint()}), false);
    assert!(claim(&mut j, 1, command("room_create"), true, true).is_ok());
}
#[test]
fn admission_still_checks_grant_revocation_and_allowlist() {
    let mut j = Journal::new();
    assert!(claim(&mut j, 1, command("room_post"), true, false).is_err()); // no grant
    grant_raw(&mut j, json!({"endpointId": endpoint()}), false);
    assert!(claim(&mut j, 1, command("room_post"), false, false).is_err()); // not the pinned daemon
    assert!(claim(&mut j, 1, command("devices_add"), true, false).is_err()); // not allowlisted
    assert!(claim(&mut j, 1, command("room_post"), true, false).is_ok()); // the refusals consumed nothing
    assert!(claim(&mut j, 1, command("room_post"), true, false).is_err()); // replay
    grant_raw(&mut j, json!({"endpointId": endpoint()}), true);
    assert!(claim(&mut j, 2, command("room_post"), true, false).is_err()); // revoked
}
#[test]
fn consumed_phone_identity_cannot_replay_or_change_content() {
    let mut j = Journal::new();
    grant(&mut j, false);
    claim(&mut j, 1, command("room_create"), true, false).unwrap();
    assert!(claim(&mut j, 1, command("room_create"), true, false).is_err());
    assert!(claim(
        &mut j,
        1,
        json!({"cmd":"room_create","args":{"id":"other"}}),
        true,
        false
    )
    .is_err());
}

#[test]
fn consumed_phone_claim_survives_signed_checkpoint_and_reload() {
    use ring::signature::KeyPair;
    let key = apex_provenance::new_key().unwrap();
    let mut j = Journal::new();
    grant(&mut j, false);
    claim(&mut j, 9, command("room_create"), true, false).unwrap();
    j.compact(&key).unwrap();
    let bytes = serde_json::to_vec(&j).unwrap();
    let mut restarted = Journal::open(&bytes, key.public_key().as_ref()).unwrap();
    assert!(claim(&mut restarted, 9, command("room_create"), true, false).is_err());
    assert!(claim(&mut restarted, 9, command("room_answer"), true, false).is_err());
    assert!(claim(&mut restarted, 10, command("room_create"), true, false).is_ok());
}
#[test]
fn git_actions_are_admitted_for_any_granted_phone() {
    for kind in ["push", "request_merge", "cancel_merge", "ask_fix"] {
        let intent = json!({"cmd":"room_thread_git_action","args":{"id":"r","action":{"kind":kind,"expected":{"head":"abc"}}}});
        let mut journal = Journal::new();
        grant(&mut journal, true);
        assert!(claim(&mut journal, 1, intent.clone(), true, false).is_err());
        grant(&mut journal, false);
        let ack = claim(&mut journal, 1, intent.clone(), true, false).unwrap();
        assert_eq!(ack["receipt"]["command"]["args"], intent["args"]);
        assert!(claim(&mut journal, 1, intent, true, false).is_err());
    }
}

#[test]
fn a_granted_phone_can_change_both_computer_settings() {
    let mut j = Journal::new();
    grant(&mut j, false);
    for (id, cmd) in [
        (1, json!({"cmd":"computer_set_enabled","args":{"enabled":true}})),
        (2, json!({"cmd":"computer_set_enabled","args":{"enabled":false}})),
        (3, json!({"cmd":"computer_set_app_prompts","args":{"skip":true}})),
        (4, json!({"cmd":"computer_set_app_prompts","args":{"skip":false}})),
    ] {
        let ack = claim(&mut j, id, cmd.clone(), true, false).unwrap();
        assert_eq!(ack["kind"], "claim");
        assert_eq!(ack["receipt"]["command"]["cmd"], cmd["cmd"]);
        assert_eq!(ack["receipt"]["command"]["args"], cmd["args"]);
        // Replayed request ID is refused for both commands.
        assert!(claim(&mut j, id, cmd.clone(), true, false).is_err());
    }
    // A revoked phone is refused for both commands.
    grant(&mut j, true);
    assert!(claim(&mut j, 5, command("computer_set_enabled"), true, false).is_err());
    assert!(claim(&mut j, 6, command("computer_set_app_prompts"), true, false).is_err());
}

#[test]
fn computer_setup_and_action_labels_stay_closed_to_phones() {
    let mut j = Journal::new();
    grant(&mut j, false);
    for name in ["computer_setup", "computer_set_action_labels"] {
        let err = claim(&mut j, 1, command(name), true, false).unwrap_err();
        assert!(err.contains("Command cannot acquire phone submission authority"), "{name}: {err}");
    }
}
