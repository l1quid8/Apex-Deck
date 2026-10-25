use apex_provenance::Journal;
use serde_json::{json, Value};
const UID: u32 = 501;
const FOLDER: &str = "/tmp/phone-admission";
fn endpoint() -> String {
    "ab".repeat(32)
}
fn grant(j: &mut Journal, tier: &str, threads: Value, revoked: bool) {
    let current = j.read_document(UID, FOLDER, "devices.json", true).unwrap();
    j.write_document(UID,FOLDER,"devices.json",current.revision,json!({"version":1,"devices":[{"endpointId":endpoint(),"tier":tier,"threads":threads}],"revoked":if revoked {json!([{"endpointId":endpoint()}])}else{json!([])}}),true).unwrap();
}
fn command(name: &str) -> Value {
    let args = match name {
        "room_create" => {
            json!({"id":"r","participants":[],"options":{"policy":"mention","max_bot_hops":0},"cwd":null})
        }
        "room_decide" => json!({"id":"r","request":"approval-1","approve":true,"always":false}),
        "room_answer" => json!({"id":"r","request":"question-1","answers":[["yes"]]}),
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
    grant(&mut j, "full", json!("all"), false);
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
    grant(&mut j, "full", json!("all"), false);
    assert!(claim(&mut j, 1, command("room_create"), false, false).is_err());
    for name in ["provenance_execute", "devices_add", "devices_set_tier", "devices_set_threads", "pair_approve", "legacy_import_apply"] {
        assert!(claim(&mut j, 1, command(name), true, false).is_err(), "{name} acquired phone authority");
    }
}
#[test]
fn admission_checks_current_tier_scope_and_revocation() {
    let mut j = Journal::new();
    grant(&mut j, "chat", json!(["r"]), false);
    assert!(claim(&mut j, 1, command("room_decide"), true, false).is_ok());
    assert!(claim(&mut j, 2, command("room_create"), true, false).is_err());
    grant(&mut j, "read_only", json!(["r"]), false);
    assert!(claim(&mut j, 3, command("room_decide"), true, false).is_err());
    grant(&mut j, "full", json!(["other"]), false);
    assert!(claim(&mut j, 4, command("room_decide"), true, false).is_err());
    grant(&mut j, "full", json!("all"), true);
    assert!(claim(&mut j, 5, command("room_create"), true, false).is_err());
}
#[test]
fn consumed_phone_identity_cannot_replay_or_change_content() {
    let mut j = Journal::new();
    grant(&mut j, "full", json!("all"), false);
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
fn assistant_authority_is_checked_separately_from_scoped_coding_access() {
    let mut j = Journal::new();
    grant(&mut j, "chat", json!(["r"]), false);
    assert!(claim(&mut j, 1, command("room_post"), true, true).is_err());
    assert!(claim(&mut j, 2, command("personal_send"), true, false).is_err());
    grant(&mut j, "full", json!("all"), false);
    assert!(claim(&mut j, 3, command("room_post"), true, true).is_ok());
    assert!(claim(
        &mut j,
        4,
        json!({"cmd":"personal_send","args":{"assistantId":"a","requestId":"p","text":"hi"}}),
        true,
        false
    )
    .is_ok());
}

#[test]
fn assistant_approvals_require_global_full_and_denial_does_not_consume_the_intent() {
    for (tier, threads) in [("chat", json!("all")), ("full", json!(["r"])), ("chat", json!(["r"]))] {
        for name in ["room_post", "room_decide", "room_answer"] {
            let mut j = Journal::new();
            grant(&mut j, tier, threads.clone(), false);
            assert!(claim(&mut j, 1, command(name), true, true).is_err(), "{tier} {threads} admitted {name}");
            grant(&mut j, "full", json!("all"), false);
            assert!(claim(&mut j, 1, command(name), true, true).is_ok(), "denied intent was burned: {name}");
        }
    }
}

#[test]
fn consumed_phone_claim_survives_signed_checkpoint_and_reload() {
    use ring::signature::KeyPair;
    let key = apex_provenance::new_key().unwrap();
    let mut j = Journal::new();
    grant(&mut j, "full", json!("all"), false);
    claim(&mut j, 9, command("room_create"), true, false).unwrap();
    j.compact(&key).unwrap();
    let bytes = serde_json::to_vec(&j).unwrap();
    let mut restarted = Journal::open(&bytes, key.public_key().as_ref()).unwrap();
    assert!(claim(&mut restarted, 9, command("room_create"), true, false).is_err());
    assert!(claim(&mut restarted, 9, command("room_answer"), true, false).is_err());
    assert!(claim(&mut restarted, 10, command("room_create"), true, false).is_ok());
}
