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
        appearance: None,
    })
    .unwrap()
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
        HostEvent::Room { room, event } if room == "t1" => Some(serde_json::to_value(event).unwrap()),
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
        appearance: None,
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
