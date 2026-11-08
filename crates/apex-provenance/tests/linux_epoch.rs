use apex_provenance::{new_key, Journal};
use ring::signature::KeyPair;
use serde_json::json;
const FOLDER: &str = "/home/test/.apex-deck";
fn command(id: &str) -> serde_json::Value {
    json!({"cmd":"room_create","args":{"id":"r"},"provenanceRequestId":id})
}

#[test]
fn linux_receipts_persist_epoch_and_cannot_cross_activation_or_restart() {
    let key = new_key().unwrap();
    let mut journal = Journal::new();
    let receipt = journal
        .issue_at_epoch(1000, FOLDER, command("epoch-a"), true, 7)
        .unwrap();
    assert_eq!(
        serde_json::to_value(&receipt).unwrap()["installationEpoch"],
        7
    );
    let bytes = serde_json::to_vec(&journal).unwrap();
    let mut restored = Journal::open(&bytes, key.public_key().as_ref()).unwrap();
    let before = serde_json::to_vec(&restored).unwrap();
    assert!(restored
        .claim_at_epoch(1000, FOLDER, &receipt, &"ab".repeat(16), 8)
        .is_err());
    assert_eq!(serde_json::to_vec(&restored).unwrap(), before);
    let mut retagged = receipt.clone();
    retagged.installation_epoch = Some(8);
    assert!(restored
        .claim_at_epoch(1000, FOLDER, &retagged, &"ab".repeat(16), 8)
        .is_err());
    assert!(restored
        .issue_at_epoch(1000, FOLDER, command("epoch-a"), true, 8)
        .is_err());
    restored
        .claim_at_epoch(1000, FOLDER, &receipt, &"ab".repeat(16), 7)
        .unwrap();
    let mut reopened = Journal::open(
        &serde_json::to_vec(&restored).unwrap(),
        key.public_key().as_ref(),
    )
    .unwrap();
    assert!(reopened
        .claim_at_epoch(1000, FOLDER, &receipt, &"cd".repeat(16), 7)
        .is_err());
    assert!(reopened
        .claim_at_epoch(1000, FOLDER, &receipt, &"cd".repeat(16), 9)
        .is_err());
}
#[test]
fn legacy_receipts_are_never_promoted_to_linux_installation_authority() {
    let mut journal = Journal::new();
    let legacy = journal
        .issue(1000, FOLDER, command("legacy"), true)
        .unwrap();
    assert!(journal
        .issue_at_epoch(1000, FOLDER, command("legacy"), true, 1)
        .is_err());
    assert!(journal
        .claim_at_epoch(1000, FOLDER, &legacy, &"ab".repeat(16), 1)
        .is_err());
    assert!(journal
        .issue_at_epoch(1000, FOLDER, command("zero"), true, 0)
        .is_err());
    assert!(journal
        .issue_at_epoch(1000, FOLDER, command("forged"), false, 1)
        .is_err());
    assert!(serde_json::to_value(&legacy)
        .unwrap()
        .get("installationEpoch")
        .is_none());
}
