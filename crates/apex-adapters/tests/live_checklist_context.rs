//! Manual live two-turn probe. Provider errors are recorded, not asserted.
//! Uses local protocol-recording executable wrappers on PATH. Run with
//! CHECKLIST_CAPTURE_DIR=/path CHECKLIST_CAPTURE_BIN=/path/bin cargo test
//! -p apex-adapters --test live_checklist_context -- --ignored --nocapture
use apex_adapters::{BuildContext, CliParticipant};
use apex_core::{
    system_prompt, Access, AgentTool, Backend, Participant, ParticipantConfig, ParticipantId,
    Progress, Role, TurnRequest, ViewTurn,
};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Mutex, time::Duration};

#[tokio::test]
#[ignore = "uses real provider subscriptions"]
async fn live_two_turn_checklist_context() {
    let output = PathBuf::from(std::env::var("CHECKLIST_CAPTURE_DIR").expect("capture directory"));
    let path = format!(
        "{}:{}",
        std::env::var("CHECKLIST_CAPTURE_BIN").expect("recording wrappers"),
        std::env::var("PATH").unwrap()
    );
    for (name, tool, model) in [
        ("codex", AgentTool::Codex, Some("gpt-6.1-sol")),
        ("claude", AgentTool::ClaudeCode, Some("haiku")),
        ("muse", AgentTool::Muse, None),
        ("grok", AgentTool::Grok, Some("grok-4.7-build-fast")),
    ] {
        if std::env::var("CHECKLIST_PROVIDER").is_ok_and(|v| v != name) {
            continue;
        }
        let cwd = output.join(format!("workspace-{name}"));
        std::fs::create_dir_all(&cwd).unwrap();
        let config = ParticipantConfig {
            id: ParticipantId::new(name),
            display_name: name.into(),
            backend: Backend::Agent {
                tool,
                model: model.map(String::from),
            },
            persona: String::new(),
            access: Access::Read,
            effort: None,
            speed: None,
            voice: None,
            appearance: None,
            media: None,
        };
        let context = BuildContext {
            cwd: Some(cwd),
            path: Some(path.clone()),
            ..BuildContext::default()
        };
        let bot = CliParticipant::new(config.clone())
            .with_context(&context)
            .with_timeout(Duration::from_secs(180));
        let system = system_prompt(&config, &[config.clone()]);
        let first = "[Human]: Use your native checklist/plan tool to create exactly four steps for migrating a project from SQLite to Postgres. Choose specific, distinctive wording for each step yourself. Mark step 1 in progress and all others pending. This is a checklist-state test: do not read or write files, run commands, or do the migration. Put the step wording only in the tool, not in your chat reply. After the tool succeeds, reply only Ready.";
        let mut turns = vec![ViewTurn {
            role: Role::User,
            content: first.into(),
        }];
        let mut records: Vec<Value> = vec![];
        for n in 1..=2 {
            if n == 2 {
                turns.push(ViewTurn {role:Role::User,content:"[Human]: Mark step 2 in progress in the checklist you just created. Preserve all four original step texts exactly, mark step 1 completed, and leave steps 3 and 4 pending. Use your checklist tool. Do not read or write files or run commands. If the original list is unavailable, say so rather than inventing replacement steps.".into()});
            }
            let events = Mutex::new(Vec::<Value>::new());
            let request = TurnRequest {
                access: None,
                effort_override: None,
                system: system.clone(),
                turns: turns.clone(),
                unseen: vec![],
                plan: false,
            };
            let request_log = json!({"system":request.system,"turns":turns.iter().map(|t|json!({"role":format!("{:?}",t.role),"content":t.content})).collect::<Vec<_>>()});
            println!("START {name} turn {n}");
            let sink = |p: Progress<'_>| {
                let value = match p {
                    Progress::Todo(items) => json!({"type":"todo","items":items}),
                    Progress::Work(step) => json!({"type":"work","step":step}),
                    Progress::Activity(s) => json!({"type":"activity","text":s}),
                    _ => return,
                };
                events.lock().unwrap().push(value);
            };
            let result = tokio::time::timeout(
                Duration::from_secs(240),
                bot.respond_with_progress(request, &sink),
            )
            .await;
            let (text, error) = match result {
                Ok(Ok(reply)) => (reply.text, None),
                Ok(Err(e)) => (String::new(), Some(e.to_string())),
                Err(_) => {
                    let _ = bot.cancel_active_turn().await;
                    (String::new(), Some("probe timeout".into()))
                }
            };
            println!("END {name} turn {n}: reply={text:?} error={error:?}");
            let event_log = events.into_inner().unwrap();
            for e in &event_log {
                if e["type"] == "todo" {
                    println!("{name} turn {n}: {e}");
                }
            }
            records.push(json!({"turn":n,"request":request_log,"events":event_log,"reply":text,"error":error}));
            std::fs::write(
                output.join(format!("{name}.json")),
                serde_json::to_vec_pretty(&records).unwrap(),
            )
            .unwrap();
            if error.is_some() {
                break;
            }
            turns.push(ViewTurn {
                role: Role::Assistant,
                content: text,
            });
        }
    }
}
