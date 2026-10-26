use super::*;
use serde_json::{json, Value};
use apex_core::Participant;
use async_trait::async_trait;
use std::time::Duration;

struct HeldParticipant {
    config: ParticipantConfig,
    started: tokio::sync::Notify,
    release: tokio::sync::Notify,
    calls: AtomicUsize,
}

#[async_trait]
impl Participant for HeldParticipant {
    fn config(&self) -> &ParticipantConfig { &self.config }
    async fn respond(&self, _request: apex_core::TurnRequest, delta: apex_core::DeltaSink<'_>) -> Result<apex_core::Reply, apex_core::ParticipantError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.started.notify_one();
        delta("still streaming");
        self.release.notified().await;
        Ok(apex_core::Reply::text("held reply"))
    }
}

async fn hold_bot(host: &Host, id: &str) -> Arc<HeldParticipant> {
    let handle = host.handle("r").unwrap();
    let mut room = handle.room.lock().await;
    let config = room.configs().into_iter().find(|bot| bot.id.as_str() == id).unwrap();
    let held = Arc::new(HeldParticipant { config, started: tokio::sync::Notify::new(), release: tokio::sync::Notify::new(), calls: AtomicUsize::new(0) });
    assert!(room.replace_participant(held.clone()));
    held
}

fn fixture(name: &str) -> (tokio::runtime::Runtime, Arc<Host>, PathBuf) {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let path = std::env::temp_dir().join(format!("apex-chat-delivery-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    let host = Host::new(HostPaths { data: path.clone(), downloads: None }, runtime.handle().clone());
    let bots = vec![
        apex_core::testing::ScriptedParticipant::new("a", &["@b first", "retry a"]).config().clone(),
        apex_core::testing::ScriptedParticipant::new("b", &["second", "retry b"]).config().clone(),
    ];
    host.chat_create("r".into(), Some("test".into()), bots, RoomOptions::default()).unwrap();
    (runtime, host, path)
}

async fn call(host: &Arc<Host>, mut value: Value) -> Result<Value, String> {
    let command = value.as_object_mut().unwrap().remove("command").unwrap();
    host.call_assuming_verified_ui_for_test(serde_json::from_value(json!({"cmd":command,"args":value})).map_err(|e| e.to_string())?).await
}

#[test]
fn fence_is_durable_and_refuses_a_delayed_group_post() {
    let (runtime, host, path) = fixture("fence");
    runtime.block_on(async {
        let claim = call(&host, json!({"command":"chat_message_claim","id":"r","clientMessageId":"m","text":"unused"})).await.unwrap();
        assert_eq!(claim["state"], "fenced");
        let disk = host.store.room("r").unwrap().unwrap();
        assert_eq!(serde_json::to_value(disk.snapshot).unwrap()["clientMessages"]["m"]["state"], "fenced");
        let post = call(&host, json!({"command":"room_post_to","id":"r","text":"hello","targets":["a","b"],"clientMessageId":"m"})).await;
        assert!(post.unwrap_err().contains("moved to another machine"));
        assert_eq!(host.store.room("r").unwrap().unwrap().snapshot.transcript.len(), 0);
    });
    drop(host);
    let host = Host::new(HostPaths { data: path.clone(), downloads: None }, runtime.handle().clone());
    runtime.block_on(async {
        let result = call(&host, json!({"command":"room_post","id":"r","text":"delayed","clientMessageId":"m"})).await;
        assert!(result.unwrap_err().contains("moved to another machine"));
    });
    drop(host);
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn duplicate_group_posts_including_bot_hops_never_run_twice() {
    let (runtime, host, path) = fixture("group");
    runtime.block_on(async {
        let post = json!({"command":"room_post","id":"r","text":"hello","clientMessageId":"m"});
        let (one, two) = futures::join!(call(&host, post.clone()), call(&host, post.clone()));
        one.unwrap(); two.unwrap();
        let saved = host.store.room("r").unwrap().unwrap().snapshot;
        assert_eq!(saved.transcript.iter().filter(|m| matches!(m.speaker, apex_core::Speaker::Human)).count(), 1);
        assert!(saved.transcript.iter().any(|m| m.text == "second"));
        let before = saved.transcript.clone();
        let ack = call(&host, post).await.unwrap();
        assert_eq!(ack["state"], "done");
        assert_eq!(host.store.room("r").unwrap().unwrap().snapshot.transcript, before);
    });
    drop(host);
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn running_post_owns_the_id_against_claims_and_concurrent_replays() {
    let (runtime, host, path) = fixture("running");
    runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(5), async {
            let held = hold_bot(&host, "a").await;
            let post = json!({"command":"room_post_to","id":"r","text":"hello","targets":["a"],"maxBotHops":0,"clientMessageId":"m"});
            assert_eq!(call(&host, post.clone()).await.unwrap()["state"], "running");
            held.started.notified().await;
            let disk = host.store.room("r").unwrap().unwrap().snapshot;
            assert_eq!(disk.transcript.len(), 1);
            assert_eq!(disk.transcript[0].client_message_id.as_deref(), Some("m"));
            assert_eq!(disk.client_messages["m"].state, apex_core::ClientMessageState::Running);
            let (claim, repeat) = futures::join!(call(&host, json!({"command":"chat_message_claim","id":"r","client_message_id":"m"})), call(&host, post.clone()));
            assert_eq!(claim.unwrap()["state"], "running");
            assert_eq!(repeat.unwrap()["state"], "running");
            assert_eq!(held.calls.load(Ordering::SeqCst), 1);
            held.release.notify_one();
            loop {
                if host.store.room("r").unwrap().unwrap().snapshot.client_messages["m"].state == apex_core::ClientMessageState::Done { break; }
                tokio::task::yield_now().await;
            }
            let ack = call(&host, post).await.unwrap();
            assert_eq!(ack["state"], "done");
            assert_eq!(ack["replySeqs"], json!([1]));
            assert_eq!(held.calls.load(Ordering::SeqCst), 1);
        }).await.unwrap();
    });
    drop(host);
    std::fs::remove_dir_all(path).unwrap();
}

fn assert_recovered_boundary(runtime: &tokio::runtime::Runtime, saved: SavedRoom, expected_state: &str, reply_seqs: &[usize], suffix: &str) {
    let path = std::env::temp_dir().join(format!("apex-chat-boundary-{suffix}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    Store::new(path.join("saved-chats-v1")).save_room("r", &saved).unwrap();
    let recovered = Host::new(HostPaths { data: path.clone(), downloads: None }, runtime.handle().clone());
    // Startup recovery is already on disk, before any room has been opened.
    assert!(recovered.rooms.lock().unwrap().is_empty());
    let disk = recovered.store.room("r").unwrap().unwrap().snapshot;
    assert_eq!(serde_json::to_value(&disk.client_messages["m"]).unwrap()["state"], expected_state);
    assert_eq!(disk.client_messages["m"].reply_seqs, reply_seqs);
    runtime.block_on(async {
        let old = call(&recovered, json!({"command":"room_post","id":"r","text":"hello","clientMessageId":"m"})).await.unwrap();
        assert_eq!(old["state"], expected_state);
        let claim = call(&recovered, json!({"command":"chat_message_claim","id":"r","clientMessageId":"m"})).await.unwrap();
        assert_eq!(claim["state"], expected_state);
        assert_eq!(recovered.store.room("r").unwrap().unwrap().snapshot.transcript, disk.transcript);
        call(&recovered, json!({"command":"room_post","id":"r","text":"hello","clientMessageId":"retry-new-id"})).await.unwrap();
        let retry = recovered.store.room("r").unwrap().unwrap().snapshot;
        assert_eq!(retry.transcript.iter().filter(|message| matches!(message.speaker, apex_core::Speaker::Human)).count(), 2);
        assert_eq!(retry.client_messages["retry-new-id"].state, apex_core::ClientMessageState::Done);
    });
    drop(recovered);
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn restart_at_each_two_bot_durable_boundary_never_resumes_an_old_id() {
    let (runtime, host, path) = fixture("boundaries");
    let (accepted, first, both) = runtime.block_on(async {
        let held = hold_bot(&host, "b").await;
        let handle = host.handle("r").unwrap();
        let error = Mutex::new(None);
        let (batch, _) = handle.runtime.begin_client_post("hello", Some(vec![ParticipantId::new("a"), ParticipantId::new("b")]), "m".into(), false, Some(0), &|snapshot| host.commit_client_snapshot("r", &handle, snapshot), &host.turn_sink("r", &handle, &error)).await.unwrap();
        let accepted = host.store.room("r").unwrap().unwrap();
        assert_eq!(accepted.snapshot.transcript.len(), 1);
        assert!(accepted.snapshot.client_messages["m"].reply_seqs.is_empty());
        let host_run = host.clone();
        let handle_run = handle.clone();
        let run = tokio::spawn(async move {
            let error = Mutex::new(None);
            handle_run.runtime.run(batch.unwrap(), &host_run.turn_sink("r", &handle_run, &error)).await;
            assert!(error.into_inner().unwrap().is_none());
        });
        tokio::time::timeout(Duration::from_secs(5), held.started.notified()).await.expect("second bot started");
        let first = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let saved = host.store.room("r").unwrap().unwrap();
                if saved.snapshot.client_messages["m"].reply_seqs.len() == 1 { break saved; }
                tokio::task::yield_now().await;
            }
        }).await.unwrap();
        held.release.notify_one();
        run.await.unwrap();
        let both = host.store.room("r").unwrap().unwrap();
        assert_eq!(both.snapshot.client_messages["m"].reply_seqs, vec![1, 2]);
        assert_eq!(both.snapshot.client_messages["m"].state, apex_core::ClientMessageState::Running);
        (accepted, first, both)
    });
    assert_recovered_boundary(&runtime, accepted, "interrupted", &[], "accepted");
    assert_recovered_boundary(&runtime, first, "interrupted", &[1], "first");
    assert_recovered_boundary(&runtime, both, "interrupted", &[1, 2], "both");
    runtime.block_on(async {
        host.handle("r").unwrap().room.lock().await.finish_client_message("m");
        host.save_room("r").await.unwrap();
    });
    assert_recovered_boundary(&runtime, host.store.room("r").unwrap().unwrap(), "done", &[1, 2], "done");
    drop(host);
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn failed_claim_write_leaves_no_human_message_and_can_be_retried_once() {
    let (runtime, host, path) = fixture("save-failure");
    let rooms = host.store.folder().join("rooms");
    let backup = host.store.folder().join("rooms-backup");
    std::fs::rename(&rooms, &backup).unwrap();
    std::fs::write(&rooms, "block writes").unwrap();
    runtime.block_on(async {
        assert!(call(&host, json!({"command":"room_post","id":"r","text":"hello","clientMessageId":"m"})).await.is_err());
        let snapshot = host.handle("r").unwrap().room.lock().await.snapshot();
        assert!(snapshot.transcript.is_empty());
        assert!(snapshot.client_messages.is_empty());
    });
    std::fs::remove_file(&rooms).unwrap();
    std::fs::rename(&backup, &rooms).unwrap();
    runtime.block_on(async {
        call(&host, json!({"command":"room_post","id":"r","text":"hello","clientMessageId":"m"})).await.unwrap();
        assert_eq!(host.store.room("r").unwrap().unwrap().snapshot.transcript.iter().filter(|message| matches!(message.speaker, apex_core::Speaker::Human)).count(), 1);
    });
    drop(host);
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn local_origin_sequence_never_reuses_cleared_or_rewound_history() {
    let (runtime, host, path) = fixture("origin-sequence");
    runtime.block_on(async {
        let post = |id: &str| json!({"command":"room_post","id":"r","text":"hello","clientMessageId":id});
        call(&host, post("first")).await.unwrap();
        let old = host.store.room("r").unwrap().unwrap().snapshot;
        let old_json = serde_json::to_value(&old).unwrap();
        let high = old_json["transcript"].as_array().unwrap().iter().map(|message| message["originSeq"].as_u64().expect("native messages have stable origin sequence")).max().unwrap();
        host.handle("r").unwrap().room.lock().await.clear();
        host.save_room("r").await.unwrap();
        call(&host, post("second")).await.unwrap();
        let next = serde_json::to_value(host.store.room("r").unwrap().unwrap().snapshot).unwrap();
        assert!(next["transcript"][0]["originSeq"].as_u64().unwrap() > high);
        let second_high = next["transcript"].as_array().unwrap().iter().map(|message| message["originSeq"].as_u64().unwrap()).max().unwrap();
        host.handle("r").unwrap().room.lock().await.rewind(1);
        host.save_room("r").await.unwrap();
        call(&host, post("third")).await.unwrap();
        let last = serde_json::to_value(host.store.room("r").unwrap().unwrap().snapshot).unwrap();
        assert!(last["transcript"][1]["originSeq"].as_u64().unwrap() > second_high);
        assert_eq!(call(&host, post("first")).await.unwrap()["state"], "done");
    });
    drop(host);
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn import_is_folderless_idempotent_and_merge_preserves_new_history() {
    let (runtime, host, path) = fixture("import");
    runtime.block_on(async {
        let participants = host.store.room("r").unwrap().unwrap().snapshot.participants;
        let entry = json!({"seq":9,"speaker":{"kind":"bot","id":"a"},"text":"late","origin":{"machine":"A","room":"old","seq":9},"replyToClientMessageId":"old-message"});
        let import = json!({"command":"chat_import","id":"destination","moveId":"move-1","participants":participants,"entries":[],"title":"Moved","options":{"policy":"round_robin","max_bot_hops":null}});
        let created = call(&host, import.clone()).await.unwrap();
        assert_eq!(created["room"]["kind"], "chat");
        assert_eq!(created["skipped"], json!([]));
        assert_eq!(created["room"]["options"], json!({"policy":"round_robin","max_bot_hops":null}));
        call(&host, json!({"command":"room_post","id":"destination","text":"new on B","clientMessageId":"new"})).await.unwrap();
        let before = host.store.room("destination").unwrap().unwrap().snapshot.transcript.len();
        let merge = json!({"command":"chat_merge_history","id":"destination","entries":[entry.clone(),entry]});
        assert_eq!(call(&host, merge.clone()).await.unwrap()["added"], 1);
        assert_eq!(call(&host, merge).await.unwrap()["added"], 0);
        let saved = host.store.room("destination").unwrap().unwrap();
        assert!(saved.cwd.is_none());
        assert_eq!(saved.snapshot.transcript.len(), before + 1);
        assert_eq!(saved.snapshot.transcript.last().unwrap().text, "late");
        assert_eq!(saved.snapshot.transcript.last().unwrap().reply_to_client_message_id.as_deref(), Some("old-message"));
        let mut retry = import;
        retry["id"] = "different-id".into();
        let repeated = call(&host, retry).await.unwrap();
        assert_eq!(repeated["room"]["transcript"].as_array().unwrap().len(), before + 1);
        assert!(host.store.room("different-id").unwrap().is_none());
    });
    drop(host);
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn claim_and_history_merge_refuse_work_rooms() {
    let (runtime, host, path) = fixture("work-refusal");
    host.room_create("work".into(), vec![], RoomOptions::default(), None).unwrap();
    runtime.block_on(async {
        assert!(call(&host, json!({"command":"chat_message_claim","id":"work","clientMessageId":"m"})).await.unwrap_err().contains("requires a chat room"));
        assert!(call(&host, json!({"command":"chat_merge_history","id":"work","entries":[]})).await.unwrap_err().contains("requires a chat room"));
        let saved = host.store.room("work").unwrap().unwrap().snapshot;
        assert!(saved.transcript.is_empty());
        assert!(saved.client_messages.is_empty());
    });
    drop(host);
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn closed_handle_cannot_fence_or_post_after_reopening_the_same_room() {
    let (runtime, host, path) = fixture("detached-handle");
    let detached = host.handle("r").unwrap();
    host.room_close("r".into());
    host.room_state("r".into()).unwrap();
    let reopened = host.handle("r").unwrap();
    assert!(!Arc::ptr_eq(&detached.room, &reopened.room));
    runtime.block_on(async {
        let stale_claim = detached.room.lock().await.claim_client_message("m", &|snapshot| host.commit_client_snapshot("r", &detached, snapshot));
        assert!(stale_claim.is_err(), "a detached room mutex must not publish a fence after reopening");
        let stale_post = detached.runtime.begin_client_post("hello", None, "stale-post".into(), false, Some(0), &|snapshot| host.commit_client_snapshot("r", &detached, snapshot), &|_| {}).await;
        assert!(stale_post.is_err(), "a detached room mutex must not publish a post after reopening");
        call(&host, json!({"command":"room_post","id":"r","text":"hello","clientMessageId":"m"})).await.unwrap();
        let saved = host.store.room("r").unwrap().unwrap().snapshot;
        assert_eq!(saved.transcript.iter().filter(|message| message.client_message_id.as_deref() == Some("m")).count(), 1);
        assert!(!saved.client_messages.contains_key("stale-post"));
    });
    // The opposite order saves the fence before retiring H2; H3 must load it.
    runtime.block_on(async { call(&host, json!({"command":"chat_message_claim","id":"r","clientMessageId":"fence-before-close"})).await.unwrap(); });
    host.room_close("r".into());
    host.room_state("r".into()).unwrap();
    runtime.block_on(async {
        assert!(call(&host, json!({"command":"room_post","id":"r","text":"delayed","clientMessageId":"fence-before-close"})).await.unwrap_err().contains("moved to another machine"));
    });
    drop(host);
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn close_waits_for_durable_finalization_after_core_execution_finishes() {
    let (runtime, host, path) = fixture("close-finalization");
    let handle = host.handle("r").unwrap();
    runtime.block_on(async {
        let error = Mutex::new(None);
        let (batch, _) = handle.runtime.begin_client_post("hello", Some(vec![ParticipantId::new("a"), ParticipantId::new("b")]), "m".into(), false, Some(0), &|snapshot| host.commit_client_snapshot("r", &handle, snapshot), &host.turn_sink("r", &handle, &error)).await.unwrap();
        handle.runtime.run(batch.unwrap(), &host.turn_sink("r", &handle, &error)).await;
        assert!(error.into_inner().unwrap().is_none());
        assert!(!handle.runtime.busy(), "core execution has released its pending reservation");
        assert_eq!(host.store.room("r").unwrap().unwrap().snapshot.client_messages["m"].state, apex_core::ClientMessageState::Running);
        host.room_close("r".into());
        host.room_state("r".into()).unwrap();
        assert!(Arc::ptr_eq(&host.handle("r").unwrap().room, &handle.room), "close must retain the handle until host finalization is durable");
        handle.room.lock().await.finish_client_message("m");
        host.save_room("r").await.unwrap();
    });
    host.room_close("r".into());
    assert!(handle.deleted.load(Ordering::SeqCst));
    host.room_state("r".into()).unwrap();
    assert!(!Arc::ptr_eq(&host.handle("r").unwrap().room, &handle.room));
    let final_snapshot = host.store.room("r").unwrap().unwrap().snapshot;
    assert_eq!(final_snapshot.client_messages["m"].state, apex_core::ClientMessageState::Done);
    assert_eq!(final_snapshot.client_messages["m"].reply_seqs, vec![1, 2]);
    drop(host);
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn import_sanitizes_profiles_and_keeps_move_identity_across_metadata_failure() {
    let (runtime, host, path) = fixture("import-failure");
    let mut participants = host.store.room("r").unwrap().unwrap().snapshot.participants;
    participants[0].access = Access::Full;
    let mut unsupported = participants[0].clone();
    unsupported.id = ParticipantId::new("unsupported");
    unsupported.display_name = "Unsupported".into();
    unsupported.backend = apex_core::Backend::Cli { program: "unsupported".into(), args: vec![] };
    participants.push(unsupported);
    let meta_path = host.store.folder().join("chat-meta-v1.json");
    std::fs::remove_file(&meta_path).unwrap();
    std::fs::create_dir(&meta_path).unwrap();
    let command = json!({"command":"chat_import","id":"imported","moveId":"durable-move","title":"title","participants":participants,"entries":[{"seq":99,"speaker":{"kind":"human"},"text":"old","clientMessageId":"old-id"}]});
    runtime.block_on(async { assert!(call(&host, command.clone()).await.is_err()); });
    let imported = host.store.room("imported").unwrap().unwrap();
    assert!(imported.cwd.is_none());
    assert!(!imported.snapshot.plan);
    assert_eq!(imported.snapshot.import_move_id.as_deref(), Some("durable-move"));
    assert!(imported.snapshot.participants.iter().all(|participant| participant.access == Access::Read));
    assert_eq!(imported.snapshot.import_skipped[0]["participant"], "unsupported");
    std::fs::remove_dir(&meta_path).unwrap();
    drop(host);
    let host = Host::new(HostPaths { data: path.clone(), downloads: None }, runtime.handle().clone());
    runtime.block_on(async {
        let mut retry = command;
        retry["id"] = "other-target".into();
        let result = call(&host, retry).await.unwrap();
        assert_eq!(result["id"], "imported");
        assert_eq!(result["skipped"][0]["participant"], "unsupported");
        assert!(host.store.room("other-target").unwrap().is_none());
        let before = host.store.room("imported").unwrap().unwrap().snapshot.transcript;
        assert_eq!(call(&host, json!({"command":"room_post","id":"imported","text":"old","clientMessageId":"old-id"})).await.unwrap()["state"], "done");
        assert_eq!(host.store.room("imported").unwrap().unwrap().snapshot.transcript, before);
    });
    drop(host);
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn voice_requests_use_the_same_durable_ledger_and_retain_content_binding() {
    let (runtime, host, path) = fixture("voice");
    runtime.block_on(async {
        let command = json!({"command":"room_post_to","id":"r","text":"spoken words","targets":["a"],"clientTurnId":"voice-1","maxBotHops":0});
        assert_eq!(call(&host, command.clone()).await.unwrap()["state"], "running");
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if host.store.room("r").unwrap().unwrap().snapshot.client_messages["voice-1"].state == apex_core::ClientMessageState::Done { break; }
                tokio::task::yield_now().await;
            }
        }).await.unwrap();
        let before = host.store.room("r").unwrap().unwrap().snapshot.transcript;
        assert_eq!(call(&host, command.clone()).await.unwrap()["state"], "done");
        let mut mismatch = command;
        mismatch["text"] = "different words".into();
        assert!(call(&host, mismatch).await.unwrap_err().contains("different content"));
        assert_eq!(host.store.room("r").unwrap().unwrap().snapshot.transcript, before);
    });
    drop(host);
    let host = Host::new(HostPaths { data: path.clone(), downloads: None }, runtime.handle().clone());
    runtime.block_on(async {
        let before = host.store.room("r").unwrap().unwrap().snapshot.transcript;
        assert_eq!(call(&host, json!({"command":"room_post_to","id":"r","text":"spoken words","targets":["a"],"clientTurnId":"voice-1","maxBotHops":0})).await.unwrap()["state"], "done");
        assert_eq!(host.store.room("r").unwrap().unwrap().snapshot.transcript, before);
    });
    drop(host);
    std::fs::remove_dir_all(path).unwrap();
}
