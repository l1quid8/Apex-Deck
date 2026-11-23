#![cfg(target_os = "linux")]
use apex_provenance::{linux_activation::Descriptor, linux_service::validate_health};
use serde_json::json;
#[test]
fn health_requires_exact_challenge_release_phase_and_all_expected_daemons() {
    let descriptor = Descriptor {
        tree: "/opt/apex-deck/test".into(),
        manifest_sha256: "a".repeat(64),
        protocol: 1,
        epoch: 7,
    };
    let nonce = "b".repeat(32);
    let good = json!({"domain":apex_provenance::DOMAIN,"kind":"linux-health","nonce":nonce,"epoch":7,"manifestSha256":"a".repeat(64),"protocol":1,"tree":"/opt/apex-deck/test","brokerInstance":"c".repeat(32),"ready":false,"daemons":[{"uid":1000,"pid":123,"processLive":true,"protocolReady":true}]});
    assert!(validate_health(&good, &descriptor, &nonce, &[1000], false).is_ok());
    for (field, value) in [
        ("nonce", json!("stale")),
        ("epoch", json!(6)),
        ("manifestSha256", json!("d".repeat(64))),
        ("protocol", json!(2)),
        ("tree", json!("/opt/apex-deck/other")),
        ("ready", json!(true)),
        ("daemons", json!([])),
        (
            "daemons",
            json!([{"uid":1000,"pid":123,"processLive":true,"protocolReady":false}]),
        ),
        (
            "daemons",
            json!([{"uid":1001,"pid":123,"processLive":true,"protocolReady":true}]),
        ),
    ] {
        let mut bad = good.clone();
        bad[field] = value;
        assert!(
            validate_health(&bad, &descriptor, &nonce, &[1000], false).is_err(),
            "{bad}"
        );
    }
}
