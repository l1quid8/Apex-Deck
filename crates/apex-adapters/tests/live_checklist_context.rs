//! Manual two-turn probe through the production concurrent room request path.
//! CHECKLIST_CAPTURE_DIR=/path CHECKLIST_CAPTURE_BIN=/path/bin cargo test
//! -p apex-adapters --test live_checklist_context -- --ignored --nocapture
use apex_adapters::{build, BuildContext, CliParticipant};
use apex_core::{
    Access, AgentTool, Approver, Backend, ConcurrentRoom, DeltaSink, Participant,
    ParticipantConfig, ParticipantError, ParticipantId, ProgressSink, Reply, Room, RoomEvent,
    RoomOptions, TurnRequest,
};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

struct Captured {
    inner: Arc<dyn Participant>,
    requests: Mutex<Vec<Value>>,
}
#[async_trait::async_trait]
impl Participant for Captured {
    fn config(&self) -> &ParticipantConfig {
        self.inner.config()
    }
    async fn respond(&self, _: TurnRequest, _: DeltaSink<'_>) -> Result<Reply, ParticipantError> {
        unreachable!()
    }
    async fn respond_with_approvals(
        &self,
        request: TurnRequest,
        sink: ProgressSink<'_>,
        approver: &dyn Approver,
    ) -> Result<Reply, ParticipantError> {
        self.requests.lock().unwrap().push(json!({"system":request.system,"access":request.access,"turns":request.turns.iter().map(|t|json!({"role":format!("{:?}",t.role),"content":t.content})).collect::<Vec<_>>()}));
        self.inner
            .respond_with_approvals(request, sink, approver)
            .await
    }
    async fn cancel_active_turn(&self) -> Result<bool, String> {
        self.inner.cancel_active_turn().await
    }
}

#[tokio::test]
#[ignore = "uses real provider subscriptions and API credits"]
async fn live_two_turn_checklist_context() {
    let output = PathBuf::from(std::env::var("CHECKLIST_CAPTURE_DIR").expect("capture directory"));
    let path = format!(
        "{}:{}",
        std::env::var("CHECKLIST_CAPTURE_BIN").expect("recording wrappers"),
        std::env::var("PATH").unwrap()
    );
    let mut failures = vec![];
    for (name, backend) in [
        (
            "codex",
            Backend::Agent {
                tool: AgentTool::Codex,
                model: Some("gpt-6.1-sol".into()),
            },
        ),
        (
            "claude",
            Backend::Agent {
                tool: AgentTool::ClaudeCode,
                model: Some("haiku".into()),
            },
        ),
        (
            "muse",
            Backend::Agent {
                tool: AgentTool::Muse,
                model: None,
            },
        ),
        (
            "deepseek",
            Backend::OpenAiCompatible {
                base_url: "https://api.deepseek.com/v1".into(),
                model: "deepseek-chat".into(),
                api_key_env: Some("DEEPSEEK_API_KEY".into()),
            },
        ),
    ] {
        if std::env::var("CHECKLIST_PROVIDER").is_ok_and(|v| v != name) {
            continue;
        }
        let cwd = output.join(format!("workspace-{name}"));
        std::fs::create_dir_all(&cwd).unwrap();
        let config = ParticipantConfig {
            id: ParticipantId::new(name),
            display_name: name.into(),
            backend,
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
        let inner: Arc<dyn Participant> = if name == "deepseek" {
            build(config, &context)
        } else {
            Arc::new(
                CliParticipant::new(config)
                    .with_context(&context)
                    .with_timeout(Duration::from_secs(180)),
            )
        };
        let bot = Arc::new(Captured {
            inner,
            requests: Mutex::new(vec![]),
        });
        let runtime = ConcurrentRoom::new(Room::new(
            vec![bot.clone()],
            RoomOptions {
                max_bot_hops: Some(0),
                ..RoomOptions::default()
            },
        ));
        let mut records = vec![];
        for (n, prompt) in [
            "Use your native checklist/plan tool to create exactly four steps for migrating a project from SQLite to Postgres. Choose specific, distinctive wording for each step yourself. Mark step 1 in progress and all others pending. This is a checklist-state test: do not read or write files, run commands, or do the migration. Put the step wording only in the tool, not in your chat reply. After the tool succeeds, reply only Ready.",
            "Mark step 2 in progress in the checklist you just created. Preserve all four original step texts exactly, mark step 1 completed, and leave steps 3 and 4 pending. Use your checklist tool. Do not read or write files or run commands. If the original list is unavailable, say so rather than inventing replacement steps.",
        ].into_iter().enumerate() {
            println!("START {name} turn {}", n+1);
            let events = Mutex::new(vec![]);
            let sink = |e: RoomEvent| { events.lock().unwrap().push(serde_json::to_value(e).unwrap()); };
            let batch = runtime.begin_post(prompt, None, &sink).await.unwrap();
            let timeout = tokio::time::timeout(Duration::from_secs(240), runtime.run(batch, &sink)).await.is_err();
            if timeout { runtime.stop(None); }
            let events = events.into_inner().unwrap();
            for e in &events { if e["type"] == "todo" || e["type"] == "failed" { println!("{name} turn {}: {e}", n+1); } }
            records.push(json!({"turn":n+1,"request":bot.requests.lock().unwrap().last().cloned(),"events":events,"timeout":timeout}));
            std::fs::write(output.join(format!("{name}.json")), serde_json::to_vec_pretty(&records).unwrap()).unwrap();
            println!("END {name} turn {}", n+1);
            if timeout { break; }
        }
        let todo = |n: usize| -> Option<&Vec<Value>> {
            records.get(n)?["events"]
                .as_array()?
                .iter()
                .rev()
                .find(|e| e["type"] == "todo")?["items"]
                .as_array()
        };
        let valid = match (todo(0), todo(1)) {
            (Some(a), Some(b)) => {
                a.len() == 4
                    && b.len() == 4
                    && a.iter().zip(b).all(|(a, b)| a["text"] == b["text"])
                    && a.iter()
                        .map(|i| i["status"].as_str().unwrap_or(""))
                        .collect::<Vec<_>>()
                        == ["in_progress", "pending", "pending", "pending"]
                    && b.iter()
                        .map(|i| i["status"].as_str().unwrap_or(""))
                        .collect::<Vec<_>>()
                        == ["completed", "in_progress", "pending", "pending"]
            }
            _ => false,
        } && records.iter().all(|r| {
            r["timeout"] == false
                && !r["events"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|e| e["type"] == "failed")
        });
        println!("VERIFIED {name}: {valid}");
        if !valid {
            failures.push(name);
        }
        std::fs::write(
            output.join(format!("{name}-verification.json")),
            serde_json::to_vec_pretty(
                &json!({"provider":name,"wording_and_statuses_verified":valid}),
            )
            .unwrap(),
        )
        .unwrap();
    }
    assert!(
        failures.is_empty(),
        "Live checklist verification failed: {failures:?}"
    );
}
