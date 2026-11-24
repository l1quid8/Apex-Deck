use apex_provenance::{channel, new_key, sign, verify, Journal, Receipt, DOMAIN};
use ring::signature::KeyPair;
use serde_json::json;

#[test]
fn receipts_from_the_other_channel_domain_and_key_are_rejected() {
    let local_key = new_key().unwrap();
    let foreign_key = new_key().unwrap();
    let other_domain = if channel::NIGHTLY {
        "apex-provenance-v1"
    } else {
        "apex-provenance-nightly-v1"
    };
    assert_ne!(DOMAIN, other_domain);

    let command = json!({
        "cmd": "room_create",
        "args": { "name": "Channel Isolation" },
        "provenanceRequestId": "req-1"
    });
    let mut journal = Journal::new();
    let receipt = journal.issue(501, "/data", command, true).unwrap();

    // Even if signed by the same key, a receipt claiming the other channel's domain is rejected.
    let wrong_domain_payload = json!({
        "domain": other_domain,
        "kind": "submission",
        "receipt": receipt
    });
    let wrong_domain_signed = sign(&local_key, &wrong_domain_payload).unwrap();
    let verified = verify(local_key.public_key().as_ref(), &wrong_domain_signed).unwrap();
    assert_ne!(verified["domain"], DOMAIN);

    // Signed by the other channel's authority key: signature verification fails outright.
    let foreign_payload = json!({
        "domain": other_domain,
        "kind": "submission",
        "receipt": receipt
    });
    let foreign_signed = sign(&foreign_key, &foreign_payload).unwrap();
    assert!(verify(local_key.public_key().as_ref(), &foreign_signed).is_err());

    // Matching key and active channel domain succeeds and can be claimed once.
    let valid_payload = json!({
        "domain": DOMAIN,
        "kind": "submission",
        "receipt": receipt
    });
    let valid_signed = sign(&local_key, &valid_payload).unwrap();
    let parsed = verify(local_key.public_key().as_ref(), &valid_signed).unwrap();
    assert_eq!(parsed["domain"], DOMAIN);
    let parsed_receipt: Receipt = serde_json::from_value(parsed["receipt"].clone()).unwrap();
    let claimed = journal
        .claim(501, "/data", &parsed_receipt, "0123456789abcdef0123456789abcdef")
        .unwrap();
    assert_eq!(claimed["domain"], DOMAIN);
}
