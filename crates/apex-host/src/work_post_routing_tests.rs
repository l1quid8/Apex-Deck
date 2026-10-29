//! Client chat IDs must not bypass Work's send preparation or task ownership.
use crate::{Command, Host, HostPaths};
use apex_core::{Participant, ParticipantConfig, RoomOptions};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc, time::Duration};

struct WorkBot {
    config: ParticipantConfig,
    file: Option<PathBuf>,
}

#[async_trait]
impl Participant for WorkBot {
    fn config(&self) -> &ParticipantConfig { &self.config }

    async fn respond(&self, _request: apex_core::TurnRequest, _delta: apex_core::DeltaSink<'_>) -> Result<apex_core::Reply, apex_core::ParticipantError> {
        if let Some(file) = &self.file { std::fs::write(file, "bot edit").unwrap(); }
        Ok(apex_core::Reply::text("done"))
    }

    async fn respond_with_progress(&self, request: apex_core::TurnRequest, progress: apex_core::ProgressSink<'_>) -> Result<apex_core::Reply, apex_core::ParticipantError> {
        progress(apex_core::Progress::ToolServers(&["known".to_string().into()]));
        self.respond(request, &|_| {}).await
    }
}

struct Fixture {
    host: Arc<Host>,
    runtime: tokio::runtime::Runtime,
    data: PathBuf,
}

impl Fixture {
    fn new(name: &str, workspace: bool) -> Self {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let data = std::env::temp_dir().join(format!("apex-work-post-routing-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        let host = Host::new(HostPaths { data: data.clone(), downloads: None }, runtime.handle().clone());
        let cwd = workspace.then(|| {
            let cwd = data.join("workspace");
            std::fs::create_dir_all(&cwd).unwrap();
            std::fs::write(cwd.join("file.txt"), "initial").unwrap();
            cwd
        });
        let config = apex_core::testing::ScriptedParticipant::new("bot", &["done"]).config().clone();
        host.room_create("r".into(), vec![config.clone()], RoomOptions::default(), cwd.as_ref().map(|cwd| cwd.to_string_lossy().into_owned())).unwrap();
        runtime.block_on(async {
            let handle = host.handle("r").unwrap();
            assert!(handle.room.lock().await.replace_participant(Arc::new(WorkBot { config, file: cwd.as_ref().map(|cwd| cwd.join("file.txt")) })));
            if workspace {
                tokio::time::timeout(Duration::from_secs(10), async {
                    loop {
                        if std::fs::read(data.join("snapshots/threads/r.json")).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok()).is_some_and(|thread| thread["checkpoints"].as_array().is_some_and(|points| points.iter().any(|point| point["kind"] == "open"))) { break; }
                        tokio::task::yield_now().await;
                    }
                }).await.expect("opening snapshot finishes before the human edit");
            }
        });
        Self { host, runtime, data }
    }

    async fn call(&self, command: &str, text: &str, message_id: Option<&str>) -> Result<Value, String> {
        let mut args = json!({"id":"r", "text":text});
        if command == "room_post_to" { args["targets"] = json!(["bot"]); }
        if let Some(id) = message_id { args["clientMessageId"] = json!(id); }
        self.host.call_assuming_verified_ui_for_test(Command::from_json(json!({"cmd":command,"args":args}))?).await
    }

    async fn idle(&self) {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let state = self.host.room_state("r".into()).unwrap();
                if state["active"].as_array().unwrap().is_empty() && self.host.store().room("r").unwrap().unwrap().snapshot.transcript.len() >= 2 { break; }
                tokio::task::yield_now().await;
            }
        }).await.expect("Work reply finishes and saves");
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.runtime.block_on(self.host.wind_down(Duration::from_secs(2)));
        let _ = std::fs::remove_dir_all(&self.data);
    }
}

fn assert_work_revert(command: &str) {
    let f = Fixture::new(&format!("revert-{command}"), true);
    f.runtime.block_on(async {
        let file = f.data.join("workspace/file.txt");
        std::fs::write(&file, "human edit").unwrap();
        f.call(command, "change the file", Some("ordinary-message")).await.unwrap();
        f.idle().await;
        let plan = f.host.room_revert_plan("r".into(), 0, None).await.unwrap();
        assert!(plan.available);
        assert!(plan.files.iter().any(|file| file.path == "file.txt" && !file.conflict), "Revert must preserve the human's pre-send edit: {plan:?}");
        assert!(f.host.room_revert("r".into(), 0, None, false, vec!["file.txt".into()]).await.unwrap().is_empty());
        assert_eq!(std::fs::read_to_string(file).unwrap(), "human edit");
        assert!(f.host.store().room("r").unwrap().unwrap().snapshot.client_messages.is_empty(), "ordinary Work sends do not enter chat delivery tracking");
    });
}

#[test]
fn room_post_with_client_id_keeps_work_revert_snapshot() { assert_work_revert("room_post"); }

#[test]
fn room_post_to_with_client_id_keeps_work_revert_snapshot() { assert_work_revert("room_post_to"); }

fn assert_work_server_validation(command: &str) {
    let f = Fixture::new(&format!("servers-{command}"), false);
    f.runtime.block_on(async {
        f.call("room_post", "discover available servers", None).await.unwrap();
        let before = f.host.store().room("r").unwrap().unwrap().snapshot.transcript;
        let result = f.call(command, "use !missing", Some("ordinary-message")).await;
        assert_eq!(result.unwrap_err(), "No tool server called \"missing\" for the addressed models");
        assert_eq!(f.host.store().room("r").unwrap().unwrap().snapshot.transcript, before);
    });
}

#[test]
fn room_post_with_client_id_keeps_work_tool_server_validation() { assert_work_server_validation("room_post"); }

#[test]
fn room_post_to_with_client_id_keeps_work_tool_server_validation() { assert_work_server_validation("room_post_to"); }

fn assert_work_task_ownership(command: &str) {
    use crate::assistant_tasks::{HumanRequest, TaskDestination, TaskMode, TaskOwner};
    let f = Fixture::new(&format!("task-{command}"), false);
    let owner = TaskOwner { workspace_id: "workspace".into(), cwd: f.data.to_string_lossy().into_owned(), host_id: "host".into(), conversation_id: "parent".into() };
    let destination = TaskDestination { thread_id: Some("r".into()), workers: vec!["bot".into()], new_thread: false };
    let task = f.host.assistant_tasks.submit_human_request(HumanRequest { request_id: "task-request".into(), owner: owner.clone(), text: "work".into(), destination: Some(destination.clone()) }, "work".into(), Some(destination)).unwrap();
    let task = f.host.assistant_tasks.bind_execution(&task.id, task.revision, &owner, "r".into(), TaskMode::ReadOnly, None).unwrap();
    f.host.assistant_tasks.begin_attempt(&task.id, task.revision, &owner).unwrap();
    f.runtime.block_on(async {
        let without_id = f.call(command, "continue", None).await.unwrap_err();
        assert_eq!(without_id, "This assistant task is still running.");
        let with_id = f.call(command, "continue", Some("ordinary-message")).await.unwrap_err();
        assert_eq!(with_id, without_id, "a client chat ID must preserve assistant continuation ownership");
        assert!(f.host.store().room("r").unwrap().unwrap().snapshot.transcript.is_empty());
    });
}

#[test]
fn room_post_with_client_id_keeps_assistant_continuation_ownership() { assert_work_task_ownership("room_post"); }

#[test]
fn room_post_to_with_client_id_keeps_assistant_continuation_ownership() { assert_work_task_ownership("room_post_to"); }

#[test]
fn work_voice_turn_ids_still_deduplicate_and_reject_mismatched_message_ids() {
    let f = Fixture::new("voice", false);
    f.runtime.block_on(async {
        let post = |message_id: Option<&str>| Command::from_json(json!({"cmd":"room_post_to","args":{"id":"r","text":"voice","targets":["bot"],"clientTurnId":"voice-turn","maxBotHops":0,"clientMessageId":message_id}})).unwrap();
        assert_eq!(f.host.call_assuming_verified_ui_for_test(post(Some("different"))).await.unwrap_err(), "voice and client message IDs must match");
        assert!(f.host.store().room("r").unwrap().unwrap().snapshot.transcript.is_empty());
        assert_eq!(f.host.call_assuming_verified_ui_for_test(post(None)).await.unwrap()["state"], "running");
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if f.host.store().room("r").unwrap().unwrap().snapshot.client_messages["voice-turn"].state == apex_core::ClientMessageState::Done { break; }
                tokio::task::yield_now().await;
            }
        }).await.unwrap();
        assert_eq!(f.host.call_assuming_verified_ui_for_test(post(Some("voice-turn"))).await.unwrap()["state"], "done");
        let saved = f.host.store().room("r").unwrap().unwrap().snapshot;
        assert_eq!(saved.transcript.iter().filter(|message| matches!(message.speaker, apex_core::Speaker::Human)).count(), 1);
        assert_eq!(saved.transcript.iter().filter(|message| matches!(message.speaker, apex_core::Speaker::Bot(_))).count(), 1);
        assert_eq!(saved.transcript[0].client_message_id.as_deref(), Some("voice-turn"));
    });
}
