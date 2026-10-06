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

#[test]
fn echoed_secrets_and_unknown_fields_never_survive_normalization() {
    let payload = json!({"model":"jev-1.13", "secret":"private chat", "answers":{
        "who_replies":{"choice":"bot_0", "probabilities":{"bot_0":1.0}, "explanation":"private chat"},
        "awaiting_human":{"noul":0.2,"echo":"private chat"}, "duplicate_reply":{"noul":0.9,"echo":"private chat"}},
        "usage":{"cost":0.001,"input_tokens":100,"echo":"private chat","unknown":123}});
    let result = normalize_response(payload.clone(), 5).unwrap();
    let serialized = serde_json::to_string(&result).unwrap();
    assert!(!serialized.contains("private chat"));
    assert!(!serialized.contains("duplicate_reply"));
    assert!(!serialized.contains("unknown"));
    assert_eq!(result.usage["cost"], 0.001);
    let mut invalid = payload;
    invalid["model"] = json!("echoed secret with spaces");
    assert!(normalize_response(invalid, 5).is_err());
}
