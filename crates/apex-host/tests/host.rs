//! The host driven the way the daemon will drive it: JSON commands in,
//! numbered events out. One chat, one terminal, an approval answer and a
//! restart that brings the chat back.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use apex_core::{Backend, ParticipantConfig, ParticipantId, RoomOptions};
use apex_host::events::{Envelope, HostEvent};
use apex_host::{Command, Host, HostPaths};
use serde_json::{json, Value};

struct Running {
    host: Arc<Host>,
    runtime: tokio::runtime::Runtime,
    seen: Arc<Mutex<Vec<Envelope>>>,
}

#[test]
fn an_unreadable_process_recovery_registry_refuses_host_startup() {
    let data = std::env::temp_dir().join(format!("apex-host-recovery-obstructed-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(&data).unwrap();
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    for (directory, expected) in [("worker-processes", "worker recovery registry"), ("operation-processes", "task operation recovery registry")] {
        std::fs::write(data.join(directory), "not a recovery directory").unwrap();
        let result = Host::try_new(HostPaths { data: data.clone(), downloads: None }, runtime.handle().clone());
        assert!(matches!(result, Err(error) if error.contains(expected)));
        std::fs::remove_file(data.join(directory)).unwrap();
    }
    std::fs::remove_dir_all(data).unwrap();
}

#[cfg(unix)]
#[test]
fn linked_process_recovery_namespaces_and_task_directories_refuse_startup() {
    use std::os::unix::fs::symlink;
    let root = std::env::temp_dir().join(format!("apex-host-recovery-linked-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let data = root.join("data");
    let outside = root.join("outside");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    for namespace in ["worker-processes", "operation-processes"] {
        let directory = data.join(namespace);
        symlink(&outside, &directory).unwrap();
        let result = Host::try_new(HostPaths { data: data.clone(), downloads: None }, runtime.handle().clone());
        assert!(matches!(result, Err(error) if error.contains("cannot be symlinks")));
        std::fs::remove_file(&directory).unwrap();
        std::fs::create_dir(&directory).unwrap();
        symlink(&outside, directory.join("task-1")).unwrap();
        let result = Host::try_new(HostPaths { data: data.clone(), downloads: None }, runtime.handle().clone());
        assert!(matches!(result, Err(error) if error.contains("linked or non-directory entry")));
        std::fs::remove_dir_all(&directory).unwrap();
    }
    assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
    std::fs::remove_dir_all(root).unwrap();
}

impl Running {
    fn start(data: &PathBuf) -> Running {
        let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        let host = Host::new(HostPaths { data: data.clone(), downloads: None }, runtime.handle().clone());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        host.events().listen(move |envelope| sink.lock().unwrap().push(envelope.clone()));
        Running { host, runtime, seen }
    }

    fn call(&self, command: Value) -> Result<Value, String> {
        let command = Command::from_json(command)?;
        self.runtime.block_on(self.host.call(command))
    }

    fn events(&self) -> Vec<HostEvent> {
        self.seen.lock().unwrap().iter().map(|e| e.event.clone()).collect()
    }

    /// Wait up to `limit` for an event that `test` accepts.
    fn wait_for(&self, limit: Duration, test: impl Fn(&HostEvent) -> bool) -> bool {
        let start = Instant::now();
        while start.elapsed() < limit {
            if self.events().iter().any(&test) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }
}

fn scripted(id: &str, lines: &[&str]) -> Value {
    serde_json::to_value(ParticipantConfig {
        id: ParticipantId::new(id),
        display_name: id.to_string(),
        backend: Backend::Scripted { lines: lines.iter().map(|l| l.to_string()).collect() },
        persona: String::new(),
        access: Default::default(),
        effort: None,
        auto_effort: false,
        appearance: None, media: None
    })
    .unwrap()
}

#[test]
fn room_state_identifies_events_already_in_its_snapshot() {
    let data = std::env::temp_dir().join(format!("apex-host-boundary-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    let host = Running::start(&data);
    host.call(json!({"cmd":"room_create","args":{"id":"r","participants":[scripted("bot", &["reply"])],"options":RoomOptions::default()}})).unwrap();
    host.call(json!({"cmd":"room_post","args":{"id":"r","text":"@bot first"}})).unwrap();
    let state = host.call(json!({"cmd":"room_state","args":{"id":"r"}})).unwrap();
    let boundary = state["recovery_seq"].as_u64().expect("snapshot must carry its event boundary");
    let events: Vec<Value> = host.events().iter().filter(|e| e.name()=="room-event").map(|e| e.payload()).collect();
    assert!(!events.is_empty());
    assert!(events.iter().all(|e| e["recovery_seq"].as_u64().unwrap() <= boundary));
    host.call(json!({"cmd":"room_post","args":{"id":"r","text":"@bot second"}})).unwrap();
    let latest = host.events().iter().filter(|e| e.name()=="room-event").last().unwrap().payload();
    assert!(latest["recovery_seq"].as_u64().unwrap() > boundary);
    assert_eq!(state["snapshot"]["transcript"].as_array().unwrap().len(),2);
    host.host.shutdown();
    let _ = std::fs::remove_dir_all(data);
}

#[test]
fn forgetting_an_always_allowed_rule_returns_emits_and_persists() {
    let data = std::env::temp_dir().join(format!("apex-host-forget-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    let first = Running::start(&data);
    let mut snapshot = first.call(json!({"cmd":"room_create","args":{"id":"r","participants":[],"options":RoomOptions::default()}})).unwrap();
    first.host.shutdown();
    drop(first);
    let rule = json!({"by":"bot","kind":"command","title":"Run a command","what":"npm test","allowed_at":0,"risky":false});
    snapshot["allowed"] = json!([rule.clone()]);
    let store = apex_host::storage::Store::new(data.join("saved-chats-v1"));
    store.save_room("r", &apex_host::storage::SavedRoom { cwd: None, snapshot: serde_json::from_value(snapshot).unwrap() }).unwrap();

    let host = Running::start(&data);
    let opened = host.call(json!({"cmd":"room_create","args":{"id":"r","participants":[],"options":RoomOptions::default()}})).unwrap();
    assert_eq!(opened["allowed"].as_array().unwrap().len(), 1);
    let target = Arc::clone(&host.host);
    let runtime = host.runtime.handle().clone();
    let (send, receive) = std::sync::mpsc::channel();
    let to_forget = rule.clone();
    let worker = std::thread::spawn(move || {
        let command = Command::from_json(json!({"cmd":"room_forget_allowed","args":{"id":"r","rule":to_forget}})).unwrap();
        let _ = send.send(runtime.block_on(target.call(command)));
    });
    receive.recv_timeout(Duration::from_secs(2)).expect("forgetting must not deadlock on the rooms lock").unwrap();
    worker.join().unwrap();
    assert!(host.events().iter().any(|event| matches!(event, HostEvent::Room { room, event: apex_core::RoomEvent::AllowedChanged { allowed }, .. } if room == "r" && allowed.is_empty())));
    assert!(store.room("r").unwrap().unwrap().snapshot.allowed.is_empty(), "removal is persisted immediately");
    let state = host.call(json!({"cmd":"room_state","args":{"id":"r"}})).unwrap();
    assert!(state["snapshot"]["allowed"].as_array().map(|list| list.is_empty()).unwrap_or(true));
    assert_eq!(host.call(json!({"cmd":"room_forget_allowed","args":{"id":"r","rule":rule}})), Err("that was no longer always allowed".into()));
    host.host.shutdown();
    let _ = std::fs::remove_dir_all(data);
}

#[test]
fn a_chat_a_terminal_an_approval_and_a_restart() {
    let data = std::env::temp_dir().join(format!("apex-host-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    let options = serde_json::to_value(RoomOptions::default()).unwrap();

    let first = Running::start(&data);

    // A chat: the message is saved and answered, and the room goes idle last.
    let snapshot = first.call(json!({ "cmd": "room_create", "args": { "id": "t1", "participants": [scripted("null", &["hello human"])], "options": options, "cwd": null } })).unwrap();
    assert_eq!(snapshot["transcript"], json!([]));
    first.call(json!({ "cmd": "room_post", "args": { "id": "t1", "text": "@null hi" } })).unwrap();
    let room_events: Vec<Value> = first.events().into_iter().filter_map(|e| match e {
        HostEvent::Room { room, event, .. } if room == "t1" => Some(serde_json::to_value(event).unwrap()),
        _ => None,
    }).collect();
    let texts: Vec<&str> = room_events.iter().filter(|e| e["type"] == "message_added").filter_map(|e| e["message"]["text"].as_str()).collect();
    assert_eq!(texts, vec!["@null hi", "hello human"]);
    assert_eq!(room_events.last().unwrap()["type"], "idle", "idle comes after everything else");
    let seqs: Vec<u64> = first.seen.lock().unwrap().iter().map(|e| e.seq).collect();
    assert!(seqs.windows(2).all(|w| w[1] == w[0] + 1), "events are numbered without gaps: {seqs:?}");

    // An approval answer reaches the room's desk; with nothing waiting it is refused.
    assert_eq!(
        first.call(json!({ "cmd": "room_decide", "args": { "id": "t1", "request": "r-1", "approve": true } })),
        Err("that request is no longer waiting for an answer".into())
    );
    assert_eq!(first.call(json!({ "cmd": "room_decide", "args": { "id": "nope", "request": "r-1", "approve": true } })), Err("no group chat with id nope".into()));

    // A terminal: what it prints arrives as pty-data, and killing it ends it.
    first.call(json!({ "cmd": "pty_spawn", "args": { "id": "term", "agent": null, "cwd": null, "cols": 80, "rows": 24 } })).unwrap();
    first.call(json!({ "cmd": "pty_write", "args": { "id": "term", "data": "echo apex-$((40+2))\n" } })).unwrap();
    assert!(
        first.wait_for(Duration::from_secs(20), |e| matches!(e, HostEvent::PtyData { id, data } if id == "term" && data.contains("apex-42"))),
        "the terminal's output arrives"
    );
    first.call(json!({ "cmd": "pty_kill", "args": { "id": "term" } })).unwrap();

    first.call(json!({ "cmd": "session_save", "args": { "session": { "version": 1, "panes": [{ "id": "t1", "kind": "chat" }] } } })).unwrap();
    first.host.shutdown();
    drop(first);

    // A restart: the saved chat and session come back.
    let second = Running::start(&data);
    let restored = second.call(json!({ "cmd": "room_create", "args": { "id": "t1", "participants": [], "options": options, "cwd": null } })).unwrap();
    let texts: Vec<&str> = restored["transcript"].as_array().unwrap().iter().filter_map(|m| m["text"].as_str()).collect();
    assert_eq!(texts, vec!["@null hi", "hello human"]);
    assert_eq!(second.call(json!({ "cmd": "session_load" })), Ok(json!({ "version": 1, "panes": [{ "id": "t1", "kind": "chat" }] })));
    second.host.shutdown();

    let _ = std::fs::remove_dir_all(&data);
}

/// Whether `pid` is still a live process (a zombie waiting to be reaped is not).
fn alive(pid: &str) -> bool {
    let out = std::process::Command::new("ps").args(["-o", "stat=", "-p", pid]).output().unwrap();
    let state = String::from_utf8_lossy(&out.stdout).trim().to_string();
    !state.is_empty() && !state.starts_with('Z')
}

#[test]
fn winding_down_stops_running_agents_and_keeps_their_chat() {
    let data = std::env::temp_dir().join(format!("apex-host-wind-down-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(&data).unwrap();
    let pid_file = data.join("agent.pid");
    let options = serde_json::to_value(RoomOptions::default()).unwrap();
    let slow = serde_json::to_value(ParticipantConfig {
        id: ParticipantId::new("slow"),
        display_name: "slow".into(),
        backend: Backend::Cli { program: "sh".into(), args: vec!["-c".into(), format!("echo $$ > {}; exec sleep 30", pid_file.display())] },
        persona: String::new(),
        access: Default::default(),
        effort: None,
        auto_effort: false,
        appearance: None, media: None
    })
    .unwrap();

    let first = Running::start(&data);
    first.call(json!({ "cmd": "room_create", "args": { "id": "t1", "participants": [slow], "options": options, "cwd": null } })).unwrap();
    let host = Arc::clone(&first.host);
    first.runtime.spawn(async move { host.room_post("t1".into(), "@slow go".into()).await });
    let start = Instant::now();
    let pid = loop {
        if let Some(pid) = std::fs::read_to_string(&pid_file).ok().map(|p| p.trim().to_string()).filter(|p| !p.is_empty()) {
            break pid;
        }
        assert!(start.elapsed() < Duration::from_secs(20), "the agent never started");
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(alive(&pid));

    let start = Instant::now();
    first.runtime.block_on(first.host.wind_down(Duration::from_secs(10)));
    assert!(start.elapsed() < Duration::from_secs(5), "stopping doesn't wait for the agent to finish");
    let start = Instant::now();
    while alive(&pid) {
        assert!(start.elapsed() < Duration::from_secs(5), "the agent's process {pid} is still running");
        std::thread::sleep(Duration::from_millis(20));
    }
    drop(first);

    let second = Running::start(&data);
    let restored = second.call(json!({ "cmd": "room_create", "args": { "id": "t1", "participants": [], "options": options, "cwd": null } })).unwrap();
    let texts: Vec<&str> = restored["transcript"].as_array().unwrap().iter().filter_map(|m| m["text"].as_str()).collect();
    assert_eq!(texts.first(), Some(&"@slow go"));
    second.host.shutdown();
    let _ = std::fs::remove_dir_all(&data);
}

/// A window that reloads mid-turn opens its chats again; the turn running
/// in the host must be the one it then sees and can stop.
#[test]
fn opening_a_room_again_mid_turn_keeps_the_running_room() {
    let data = std::env::temp_dir().join(format!("apex-host-reopen-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(&data).unwrap();
    let pid_file = data.join("agent.pid");
    let options = serde_json::to_value(RoomOptions::default()).unwrap();
    let slow = serde_json::to_value(ParticipantConfig {
        id: ParticipantId::new("slow"),
        display_name: "slow".into(),
        backend: Backend::Cli { program: "sh".into(), args: vec!["-c".into(), format!("echo $$ > {}; exec sleep 30", pid_file.display())] },
        persona: String::new(),
        access: Default::default(),
        effort: None,
        auto_effort: false,
        appearance: None, media: None
    })
    .unwrap();

    let running = Running::start(&data);
    running.call(json!({ "cmd": "room_create", "args": { "id": "t1", "participants": [slow], "options": options, "cwd": null } })).unwrap();
    let host = Arc::clone(&running.host);
    running.runtime.spawn(async move { host.room_post("t1".into(), "@slow go".into()).await });
    let start = Instant::now();
    let pid = loop {
        if let Some(pid) = std::fs::read_to_string(&pid_file).ok().map(|p| p.trim().to_string()).filter(|p| !p.is_empty()) {
            break pid;
        }
        assert!(start.elapsed() < Duration::from_secs(20), "the agent never started");
        std::thread::sleep(Duration::from_millis(20));
    };

    let reopened = running.call(json!({ "cmd": "room_create", "args": { "id": "t1", "participants": [], "options": options, "cwd": null } })).unwrap();
    let texts: Vec<&str> = reopened["transcript"].as_array().unwrap().iter().filter_map(|m| m["text"].as_str()).collect();
    assert_eq!(texts, vec!["@slow go"]);
    assert_eq!(reopened["participants"][0]["id"], "slow");

    running.call(json!({ "cmd": "room_stop", "args": { "id": "t1", "participant": null } })).unwrap();
    let start = Instant::now();
    while alive(&pid) {
        assert!(start.elapsed() < Duration::from_secs(5), "Stop didn't reach the turn that was running: {pid} is still alive");
        std::thread::sleep(Duration::from_millis(20));
    }
    running.host.shutdown();
    let _ = std::fs::remove_dir_all(&data);
}

#[test]
fn room_state_is_read_only_and_restores_without_live_work() {
    let data = std::env::temp_dir().join(format!("apex-room-state-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    let first = Running::start(&data);
    first.call(json!({"cmd":"room_create","args":{"id":"r","participants":[scripted("bot", &["reply"])],"options":RoomOptions::default(),"cwd":null}})).unwrap();
    let state = first.call(json!({"cmd":"room_state","args":{"id":"r"}})).unwrap();
    assert_eq!(state["active"], json!([]));
    assert_eq!(state["approvals"], json!([]));
    assert_eq!(state["snapshot"]["transcript"], json!([]));
    assert!(first.events().is_empty(), "reading state must not run a participant");
    assert!(first.call(json!({"cmd":"room_state","args":{"id":"missing"}})).is_err());
    first.call(json!({"cmd":"room_post","args":{"id":"r","text":"@bot hi"}})).unwrap();
    drop(first);
    let second = Running::start(&data);
    second.call(json!({"cmd":"room_create","args":{"id":"r","participants":[],"options":RoomOptions::default(),"cwd":null}})).unwrap();
    let state = second.call(json!({"cmd":"room_state","args":{"id":"r"}})).unwrap();
    assert_eq!(state["snapshot"]["transcript"].as_array().unwrap().len(), 2);
    assert_eq!(state["active"], json!([]));
    assert_eq!(state["approvals"], json!([]));
    drop(second);
    std::fs::remove_dir_all(data).unwrap();
}

#[test]
fn importing_a_snapshot_makes_a_fresh_room_without_usage_rules_or_changes() {
    let data = std::env::temp_dir().join(format!("apex-host-import-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    let host = Running::start(&data);
    // A thread with history on "another machine": two messages, a pin, and things a fork leaves behind.
    host.call(json!({"cmd":"room_create","args":{"id":"source","participants":[scripted("bot", &["reply"])],"options":RoomOptions::default()}})).unwrap();
    host.call(json!({"cmd":"room_post","args":{"id":"source","text":"@bot first"}})).unwrap();
    assert!(host.wait_for(Duration::from_secs(5), |e| matches!(e, HostEvent::Room { room, event: apex_core::RoomEvent::Idle, .. } if room == "source")));
    host.call(json!({"cmd":"room_pin","args":{"id":"source","fact":"keep this"}})).unwrap();
    let state = host.call(json!({"cmd":"room_state","args":{"id":"source"}})).unwrap();
    let mut snapshot = state["snapshot"].clone();
    assert_eq!(snapshot["transcript"].as_array().unwrap().len(), 2);
    snapshot["usage"] = json!({"bot":{"input":5,"output":7,"turns":1}});
    snapshot["allowed"] = json!([{"by":"bot","kind":"command","title":"Run","what":"ls","allowed_at":0}]);
    snapshot["changes"] = json!([{"by":"bot","path":"a.txt","added":1,"removed":0,"seq":1}]);
    snapshot["baseline"] = json!("somewhere-else");

    host.call(json!({"cmd":"room_import","args":{"id":"fork","snapshot":snapshot,"cwd":data.to_string_lossy()}})).unwrap();
    let opened = host.call(json!({"cmd":"room_create","args":{"id":"fork","participants":[],"options":RoomOptions::default()}})).unwrap();
    assert_eq!(opened["transcript"], state["snapshot"]["transcript"]);
    assert_eq!(opened["participants"], state["snapshot"]["participants"]);
    assert_eq!(opened["pins"], json!(["keep this"]));
    assert!(opened.get("usage").map_or(true, |u| u.as_object().unwrap().is_empty()), "a fork starts without usage");
    assert!(opened.get("allowed").map_or(true, |a| a.as_array().unwrap().is_empty()), "nor Always allow rules");
    assert!(opened["changes"].as_array().map_or(true, |c| c.is_empty()), "its folder is another one");
    assert!(opened["baseline"].is_null());
    // The new room answers in its own folder.
    host.call(json!({"cmd":"room_post","args":{"id":"fork","text":"@bot again"}})).unwrap();
    assert!(host.wait_for(Duration::from_secs(5), |e| matches!(e, HostEvent::Room { room, event: apex_core::RoomEvent::Idle, .. } if room == "fork")));
    // An id already in use, open or saved, is refused.
    assert!(host.call(json!({"cmd":"room_import","args":{"id":"fork","snapshot":state["snapshot"],"cwd":null}})).is_err());
    assert!(host.call(json!({"cmd":"room_import","args":{"id":"source","snapshot":state["snapshot"],"cwd":null}})).is_err());
    host.host.shutdown();
    let _ = std::fs::remove_dir_all(data);
}

#[test]
fn importing_over_leftover_artifacts_is_refused_and_keeps_them() {
    let data = std::env::temp_dir().join(format!("apex-host-leftover-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    let host = Running::start(&data);
    // An earlier move left only this thread's artifacts behind.
    let artifacts = json!({"version":1,"artifacts":[{"id":"a1","title":"Page","kind":"html","versions":[{"n":1,"source":"<p>left</p>","by":"bot","seq":1,"at":0}]}]});
    host.call(json!({"cmd":"artifacts_save","args":{"room":"t","artifacts":artifacts}})).unwrap();
    let snapshot = host.call(json!({"cmd":"room_create","args":{"id":"other","participants":[],"options":RoomOptions::default()}})).unwrap();
    let refused = host.call(json!({"cmd":"room_import","args":{"id":"t","snapshot":snapshot,"cwd":null}}));
    assert!(refused.unwrap_err().contains("a thread with that id already exists"));
    // A failed move then deletes nothing it didn't make.
    assert_eq!(host.call(json!({"cmd":"artifacts_load","args":{"room":"t"}})).unwrap(), artifacts);
    let store = apex_host::storage::Store::new(data.join("saved-chats-v1"));
    assert!(store.room("t").unwrap().is_none());
    host.host.shutdown();
    let _ = std::fs::remove_dir_all(data);
}

#[test]
fn importing_with_replace_swaps_an_unstarted_room_for_one_in_another_folder() {
    let data = std::env::temp_dir().join(format!("apex-host-replace-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    let elsewhere = data.join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    let host = Running::start(&data);
    let draft = host.call(json!({"cmd":"room_create","args":{"id":"d","participants":[scripted("bot", &["hi"])],"options":RoomOptions::default(),"cwd":data.to_string_lossy()}})).unwrap();
    let artifacts = json!({"version":1,"artifacts":[{"id":"a1","title":"Page","kind":"html","versions":[{"n":1,"source":"<p>hi</p>","by":"bot","seq":1,"at":0}]}]});
    host.call(json!({"cmd":"artifacts_save","args":{"room":"d","artifacts":artifacts}})).unwrap();
    // Without replace, an open id is refused; with it, the room is swapped in one step.
    assert!(host.call(json!({"cmd":"room_import","args":{"id":"d","snapshot":draft,"cwd":elsewhere.to_string_lossy()}})).is_err());
    host.call(json!({"cmd":"room_import","args":{"id":"d","snapshot":draft,"cwd":elsewhere.to_string_lossy(),"replace":true}})).unwrap();
    // Same thread on the same machine: its artifacts stay with it.
    assert_eq!(host.call(json!({"cmd":"artifacts_load","args":{"room":"d"}})).unwrap(), artifacts);
    let opened = host.call(json!({"cmd":"room_create","args":{"id":"d","participants":[],"options":RoomOptions::default()}})).unwrap();
    assert_eq!(opened["participants"], draft["participants"]);
    // It answers in the new folder, and nothing of the old room writes the old one back.
    host.call(json!({"cmd":"room_post","args":{"id":"d","text":"@bot hello"}})).unwrap();
    assert!(host.wait_for(Duration::from_secs(5), |e| matches!(e, HostEvent::Room { room, event: apex_core::RoomEvent::Idle, .. } if room == "d")));
    let store = apex_host::storage::Store::new(data.join("saved-chats-v1"));
    let saved = store.room("d").unwrap().unwrap();
    assert_eq!(saved.cwd.as_deref(), Some(elsewhere.to_string_lossy().as_ref()));
    assert_eq!(saved.snapshot.transcript.len(), 2);
    host.host.shutdown();
    let _ = std::fs::remove_dir_all(data);
}

#[test]
fn a_replace_that_cannot_be_saved_leaves_the_thread_open_and_saved_where_it_was() {
    let data = std::env::temp_dir().join(format!("apex-host-replace-fails-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    let elsewhere = data.join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    let host = Running::start(&data);
    // An unstarted fork: history from its source, open in its first folder.
    host.call(json!({"cmd":"room_create","args":{"id":"source","participants":[scripted("bot", &["reply"])],"options":RoomOptions::default(),"cwd":data.to_string_lossy()}})).unwrap();
    host.call(json!({"cmd":"room_post","args":{"id":"source","text":"@bot first"}})).unwrap();
    assert!(host.wait_for(Duration::from_secs(5), |e| matches!(e, HostEvent::Room { room, event: apex_core::RoomEvent::Idle, .. } if room == "source")));
    let snapshot = host.call(json!({"cmd":"room_state","args":{"id":"source"}})).unwrap()["snapshot"].clone();
    host.call(json!({"cmd":"room_import","args":{"id":"fork","snapshot":snapshot,"cwd":data.to_string_lossy()}})).unwrap();
    host.call(json!({"cmd":"room_create","args":{"id":"fork","participants":[],"options":RoomOptions::default()}})).unwrap();

    // Force the atomic writer to fail opening its temporary file. A directory
    // at this path fails for root and ordinary users alike.
    let rooms = data.join("saved-chats-v1").join("rooms");
    let temp_file = rooms.join("666f726b.tmp");
    std::fs::create_dir(&temp_file).unwrap();
    let moved = host.call(json!({"cmd":"room_import","args":{"id":"fork","snapshot":snapshot,"cwd":elsewhere.to_string_lossy(),"replace":true}}));
    std::fs::remove_dir(&temp_file).unwrap();
    assert!(moved.is_err());

    // Still saved with its history in its first folder, and still open there.
    let store = apex_host::storage::Store::new(data.join("saved-chats-v1"));
    let saved = store.room("fork").unwrap().unwrap();
    assert_eq!(saved.cwd.as_deref(), Some(data.to_string_lossy().as_ref()));
    assert_eq!(saved.snapshot.transcript.len(), 2);
    host.call(json!({"cmd":"room_post","args":{"id":"fork","text":"@bot again"}})).unwrap();
    assert!(host.wait_for(Duration::from_secs(5), |e| matches!(e, HostEvent::Room { room, event: apex_core::RoomEvent::Idle, .. } if room == "fork")));
    assert_eq!(store.room("fork").unwrap().unwrap().snapshot.transcript.len(), 4);
    host.host.shutdown();
    let _ = std::fs::remove_dir_all(data);
}
