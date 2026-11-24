#![cfg(target_os = "linux")]
use apex_provenance::{linux_activation::Descriptor, linux_service::validate_health};
use apex_provenance::channel::{LINUX_TREE, NIGHTLY};
use serde_json::json;
#[test]
fn health_requires_exact_challenge_release_phase_and_all_expected_daemons() {
    let descriptor = Descriptor {
        tree: format!("{LINUX_TREE}/test").into(),
        manifest_sha256: "a".repeat(64),
        protocol: 1,
        epoch: 7,
    };
    let nonce = "b".repeat(32);
    let release = NIGHTLY.then(|| json!({"channel":"nightly","version":"0.9.9","commit":"a".repeat(40),"buildNumber":123}));
    let mut good = json!({"domain":apex_provenance::DOMAIN,"kind":"linux-health","nonce":nonce,"epoch":7,"manifestSha256":"a".repeat(64),"protocol":1,"tree":descriptor.tree,"brokerInstance":"c".repeat(32),"ready":false,"daemons":[{"uid":1000,"pid":123,"processLive":true,"protocolReady":true}]});
    if let Some(release) = &release {
        good["release"] = release.clone();
    }
    assert!(validate_health(&good, &descriptor, release.as_ref(), &nonce, &[1000], false).is_ok());
    for (field, value) in [
        ("domain", json!(if NIGHTLY { "apex-provenance-v1" } else { "apex-provenance-nightly-v1" })),
        ("nonce", json!("stale")),
        ("epoch", json!(6)),
        ("manifestSha256", json!("d".repeat(64))),
        ("protocol", json!(2)),
        ("tree", json!(format!("{LINUX_TREE}/other"))),
        ("release", json!({"channel":"nightly","version":"0.9.9","commit":"a".repeat(40),"buildNumber":124})),
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
            validate_health(&bad, &descriptor, release.as_ref(), &nonce, &[1000], false).is_err(),
            "{bad}"
        );
    }
}
