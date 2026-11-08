use apex_cli::commands::{catalog, parse_input, runner_input, ParsedInput};
#[test]
fn registry_is_dispatchable_and_longest_match_wins() {
    let rows = catalog().unwrap();
    assert!(rows.iter().any(|r| r.key == "threads"));
    assert!(
        matches!(parse_input("/curate undo"),ParsedInput::Command{key,args} if key=="curate undo"&&args.is_empty())
    );
    for retired in ["/lead null", "/resume", "/session", "/approval"] {
        assert!(matches!(parse_input(retired), ParsedInput::Unknown(_)));
    }
    for path in ["/etc/passwd is here", "/usr/local/bin/apex"] {
        assert!(matches!(parse_input(path), ParsedInput::Message(_)));
    }
    assert_eq!(
        parse_input("//clear"),
        ParsedInput::Message("/clear".into())
    );
}
#[test]
fn runners_validate_bounds_and_reserved_syntax() {
    assert!(runner_input("loop", "0m check").is_err());
    assert!(runner_input("loop", "10m").is_err());
    assert_eq!(
        runner_input("loop", "10m check").unwrap()["intervalSeconds"],
        600
    );
    assert_eq!(
        runner_input("goal", "start pause").unwrap()["objective"],
        "pause"
    );
    assert_eq!(runner_input("goal", "pause").unwrap()["action"], "pause");
}
#[test]
fn runner_parser_matches_shared_app_vectors() {
    let rows: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("../../../shared/cli-runner-vectors.json")).unwrap();
    for row in rows {
        let result = runner_input(row["kind"].as_str().unwrap(), row["arg"].as_str().unwrap());
        if let Some(error) = row["error"].as_str() {
            assert_eq!(result.unwrap_err(), error, "{row}");
        } else {
            assert_eq!(result.unwrap(), row["expected"], "{row}");
        }
    }
}
#[test]
fn work_catalog_keeps_session_title_archive_and_recency_until_explicit_host_edit() {
    use apex_cli::controller::merge_threads;
    use serde_json::json;
    let session = json!({"panes":[{"id":"work","kind":"chat","title":"Build CLI","activeAt":900},{"id":"archived","kind":"chat","title":"Hidden","archived":true}]});
    let list = json!({"rooms":[{"id":"work","kind":"work","title":"New chat","titleExplicit":false,"archiveExplicit":false,"updatedAt":1,"archived":false},{"id":"archived","kind":"work","title":"New chat","archived":false}]});
    let rows = merge_threads(&session, &list);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].title, "Build CLI");
    assert_eq!(rows[0].updated, 900);
    let explicit = json!({"rooms":[{"id":"work","kind":"work","title":"Host name","titleExplicit":true,"archiveExplicit":true,"updatedAt":1000,"archived":false}]});
    assert_eq!(merge_threads(&session, &explicit)[0].title, "Host name");
}
#[test]
fn model_lookup_uses_the_backend_specific_daemon_api() {
    use apex_cli::controller::model_query;
    use serde_json::json;
    let (cmd, args) = model_query(
        "r",
        &json!({"id":"codex","backend":{"kind":"agent","tool":"codex"}}),
    );
    assert_eq!(cmd, "agent_models");
    assert_eq!(args, json!({"tool":"codex"}));
    assert!(apex_host::Command::from_json(json!({"cmd":cmd,"args":args})).is_ok());
    assert_eq!(
        model_query("r", &json!({"id":"api","backend":{"kind":"api"}})).0,
        "room_bot_models"
    );
}
