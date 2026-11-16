use apex_cli::commands::{catalog, parse_input, runner_input, ParsedInput};
#[test]
fn shared_lifecycle_commands_parse_without_a_selected_thread() {
    for (text, handler) in [("/projects rename New project", "projects"), ("/delete", "delete"), ("/archive", "archive"), ("/folder /tmp", "folder")] {
        assert!(matches!(parse_input(text),ParsedInput::Command{key,..} if key==handler),"{text}");
    }
}

#[test]
fn progress_command_is_cli_only_and_parses_as_a_read_view() {
    assert!(catalog().unwrap().iter().any(|row| row.key == "progress"));
    assert!(matches!(parse_input("/progress"), ParsedInput::Command{key,args} if key=="progress"&&args.is_empty()));
}

#[test]
fn stale_session_rows_do_not_resurrect_deleted_remote_or_removed_project_threads() {
    use apex_cli::controller::merge_threads;
    use serde_json::json;
    let session = json!({"workspaces":[{"id":"w","path":"/repo"},{"id":"remote","path":"/repo","hostId":"vps"}],"panes":[{"id":"deleted","kind":"chat","workspaceId":"w"},{"id":"remote-only","kind":"chat","workspaceId":"remote"},{"id":"draft","kind":"chat","workspaceId":"w"}]});
    let list = json!({"rooms":[{"id":"saved","kind":"work","cwd":"/repo","title":"Saved"}],"projects":[{"path":"/repo","removed":true}],"deletedThreads":["deleted"]});
    assert!(merge_threads(&session,&list).is_empty());
    let list = json!({"rooms":[{"id":"saved","kind":"work","cwd":"/repo","title":"Saved"}],"projects":[{"path":"/repo","removed":false}],"deletedThreads":["deleted"]});
    assert_eq!(merge_threads(&session,&list).iter().map(|r|r.id.as_str()).collect::<Vec<_>>(),vec!["saved"],"CLI lists saved host rooms, not desktop-only drafts");
}
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
fn unnamed_cli_work_thread_reads_as_its_folder_not_new_chat() {
    use apex_cli::controller::merge_threads;
    use serde_json::json;
    let list = json!({"rooms":[
        {"id":"cli-work","kind":"work","title":"New chat","titleExplicit":false,"folderName":"apex-deck","updatedAt":1,"archived":false},
        {"id":"named","kind":"work","title":"Plans","titleExplicit":true,"folderName":"apex-deck","updatedAt":2,"archived":false},
        {"id":"talk","kind":"chat","title":"New chat","titleExplicit":false,"updatedAt":3,"archived":false}
    ]});
    let rows = merge_threads(&json!({}), &list);
    let title = |id: &str| rows.iter().find(|r| r.id == id).unwrap().title.clone();
    assert_eq!(title("cli-work"), "apex-deck");
    assert_eq!(title("named"), "Plans");
    assert_eq!(title("talk"), "New chat");
}
#[test]
fn new_work_reads_folder_then_name_and_defaults_to_the_folder_name() {
    use apex_cli::controller::work_target;
    let root = std::env::temp_dir().join(format!("apex-work-target-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("api")).unwrap();
    std::fs::create_dir_all(root.join("my app")).unwrap();
    let root = root.canonicalize().unwrap();
    let here = |rest: &str| work_target(rest, &root);
    let root_name = root.file_name().unwrap().to_str().unwrap().to_string();
    assert_eq!(here("").unwrap(), (root.clone(), root_name.clone()));
    assert_eq!(here(" . ").unwrap(), (root.clone(), root_name));
    assert_eq!(here(". Plans for v2").unwrap(), (root.clone(), "Plans for v2".into()));
    assert_eq!(here("api").unwrap(), (root.join("api"), "api".into()));
    assert_eq!(here("api Backend").unwrap(), (root.join("api"), "Backend".into()));
    assert_eq!(here("my app").unwrap(), (root.join("my app"), "my app".into()));
    // A word that names no folder is refused, never treated as a name in the wrong folder.
    assert!(here("Plans").unwrap_err().contains("No folder at"));
    assert!(here("missing Backend").unwrap_err().contains("missing Backend"));
    std::fs::remove_dir_all(&root).unwrap();
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
