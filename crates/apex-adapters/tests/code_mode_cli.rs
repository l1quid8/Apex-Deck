//! Explicit opt-in subscription acceptance; never run as part of the default suite.
use apex_adapters::{build, BuildContext};
use apex_core::{
    Approver, Decision, ParticipantConfig, Progress, ProposedAction, Role, TurnRequest, ViewTurn,
};
use serde_json::json;
use std::sync::Mutex;

struct Answers(Mutex<Vec<String>>);

struct WaitForWrite {
    waiting: tokio::sync::Notify,
    writes: std::sync::atomic::AtomicUsize,
}
#[async_trait::async_trait]
impl Approver for WaitForWrite {
    async fn decide(&self, action: ProposedAction) -> Decision {
        if action.kind == apex_core::ActionKind::Edit {
            self.writes
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.waiting.notify_one();
            std::future::pending().await
        } else {
            Decision::Approve
        }
    }
}

#[tokio::test]
#[ignore = "uses local Claude Code and Codex subscriptions; run explicitly"]
async fn subscription_agents_stop_during_child_approval() {
    for tool in ["claude_code", "codex"] {
        let dir = std::env::temp_dir().join(format!(
            "deck-cli-code-mode-stop-{tool}-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let config: ParticipantConfig = serde_json::from_value(json!({"id":"probe","display_name":"Probe","access":"ask","backend":{"kind":"agent","tool":tool}})).unwrap();
        let bot = build(
            config,
            &BuildContext {
                cwd: Some(dir.clone()),
                codex_hook: Some(env!("CARGO_BIN_EXE_apex-deck-codex-hook").into()),
                ..Default::default()
            },
        );
        let answers = WaitForWrite {
            waiting: Default::default(),
            writes: Default::default(),
        };
        let request = TurnRequest {system:"Follow the requested MCP call exactly. Use no native file tools.".into(),turns:vec![ViewTurn {role:Role::User,content:r#"Call the apex-code-mode MCP tool deck_code_mode with {"stages":[[{"id":"a","tool":"write_file","args":{"path":"a.txt","content":"NO"}}],[{"id":"b","tool":"write_file","args":{"path":"b.txt","content":"NO"}}]],"output":{"$ref":"b"}}. Do not use other tools."#.into()}],..Default::default()};
        let run = bot.respond_with_approvals(request, &|_| {}, &answers);
        let stop = async {
            answers.waiting.notified().await;
            bot.cancel_active_turn().await.expect("worker cleanup");
        };
        let (result, ()) = tokio::time::timeout(std::time::Duration::from_secs(150), async {
            tokio::join!(run, stop)
        })
        .await
        .expect("Stop must finish the turn");
        assert!(result.is_err());
        assert_eq!(answers.writes.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(!dir.join("a.txt").exists());
        assert!(!dir.join("b.txt").exists());
        eprintln!("{tool}: Stop at child approval produced no files or second approval");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
#[async_trait::async_trait]
impl Approver for Answers {
    async fn decide(&self, action: ProposedAction) -> Decision {
        self.0.lock().unwrap().push(action.title.clone());
        if action.title.contains("denied.txt") {
            Decision::Reject
        } else {
            Decision::Approve
        }
    }
}

#[tokio::test]
#[ignore = "uses local Claude Code and Codex subscriptions; run explicitly"]
async fn subscription_agents_use_deck_mcp_and_child_approvals() {
    for tool in ["claude_code", "codex"] {
        let dir =
            std::env::temp_dir().join(format!("deck-cli-code-mode-{tool}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("input.txt"), "noise\nRECORD {\"units\":9}\n").unwrap();
        let config: ParticipantConfig = serde_json::from_value(json!({"id":"probe","display_name":"Probe","access":"ask","backend":{"kind":"agent","tool":tool}})).unwrap();
        let bot = build(
            config,
            &BuildContext {
                cwd: Some(dir.clone()),
                codex_hook: Some(env!("CARGO_BIN_EXE_apex-deck-codex-hook").into()),
                ..Default::default()
            },
        );
        let answers = Answers(Mutex::new(Vec::new()));
        let steps = Mutex::new(Vec::new());
        let progress = |p: Progress<'_>| {
            if let Progress::Work(step) = p {
                steps.lock().unwrap().push(format!("{step:?}"));
            }
        };
        let request = TurnRequest {system:"You are testing the host-provided Apex Code Mode MCP integration. Follow the exact requested tool plan and do not use other file tools or retry declined operations.".into(), turns:vec![ViewTurn {role:Role::User,content:r#"Use the apex-code-mode MCP server's deck_code_mode tool once with this exact plan: {"stages":[[{"id":"r","tool":"read_file","args":{"path":"input.txt"}}],[{"id":"w","tool":"write_file","args":{"path":"allowed.txt","content":"OK"}}],[{"id":"d","tool":"write_file","args":{"path":"denied.txt","content":"NO"}}]],"output":{"total":{"$ref":"r","pipe":[{"op":"jsonLines","prefix":"RECORD "},{"op":"sum","field":"units"}]},"written":{"$ref":"w"},"declined":{"$ref":"d"}}}. Report total and status. Do not retry declined writes or use native file tools."#.into()}], ..Default::default()};
        let reply = tokio::time::timeout(
            std::time::Duration::from_secs(150),
            bot.respond_with_approvals(request, &progress, &answers),
        )
        .await
        .expect("subscription probe timeout")
        .expect("subscription turn");
        eprintln!(
            "{tool}: {} input={:?} output={:?} approvals={:?}",
            reply.text,
            reply.input_tokens,
            reply.output_tokens,
            answers.0.lock().unwrap()
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("allowed.txt")).unwrap(),
            "OK"
        );
        assert!(!dir.join("denied.txt").exists());
        assert!(
            steps
                .lock()
                .unwrap()
                .iter()
                .any(|s| s.contains("cli-batch-")),
            "must execute through Deck's MCP bridge"
        );
        assert!(reply.text.contains('9'));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
