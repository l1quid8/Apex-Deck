use apex_adapters::decision::{DecisionConfig, normalize_response};
use serde_json::json;
#[test]
fn providers_use_distinct_models_and_cloudflare_envelope() {
    let cf = DecisionConfig { provider: "cloudflare".into(), account_id: "abc123".into() };
    assert_eq!(cf.endpoint().unwrap().1, "clef");
    assert!(cf.endpoint().unwrap().0.contains("abc123"));
    assert!(DecisionConfig { provider: "cloudflare".into(), account_id: "../escape".into() }.endpoint().is_err());
    let payload = json!({"model":"clef", "answers":{"who_replies":{"choice":"nobody","probabilities":{"nobody":1.0}},"awaiting_human":{"noul":0.0},"duplicate_reply":{"noul":1.0}},"usage":{}});
    assert_eq!(normalize_response(json!({"success":true,"result":payload}), 10).unwrap().model, "clef");
    assert!(normalize_response(json!({"answers":{}}), 10).is_err());
}
