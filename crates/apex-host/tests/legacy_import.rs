//! Legacy ledger import: snapshot, preview and UI-confirmed apply, driven the
//! way the daemon drives the host (JSON commands). The isolated fixture stands
//! in for the root broker and assumes verified UI admission; the refusal of a
//! plain apply call is covered by the unit tests in `legacy_import.rs`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use apex_host::test_support::{isolated_host_assuming_verified_ui, protected_fixture_path};
use apex_host::{Command, Host, HostPaths};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const TASKS: &str = "assistant-tasks-v1.json";
const CONVERSATIONS: &str = "assistant-conversations-v1.json";
const ROOMS: &str = "room-authority-v1.json";
const BROKER_MAX_BYTES: u64 = 16 * 1024 * 1024;

struct Fixture {
    root: PathBuf,
    data: PathBuf,
    runtime: tokio::runtime::Runtime,
    host: Arc<Host>,
}

impl Fixture {
    /// Legacy files are written before the host starts, as on an upgraded machine.
    fn new(name: &str, legacy: impl FnOnce(&Path)) -> Self {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "apex-legacy-import-{name}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&root);
        let data = root.join("data");
        std::fs::create_dir_all(data.join("saved-chats-v1/rooms")).unwrap();
        legacy(&data);
        let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        let host = isolated_host_assuming_verified_ui(HostPaths { data: data.clone(), downloads: None }, runtime.handle().clone());
        Fixture { root, data, runtime, host }
    }

    fn call(&self, value: Value) -> Result<Value, String> {
        let command = Command::from_json(value)?;
        self.runtime.block_on(self.host.call(command))
    }

    fn preview(&self) -> Value {
        self.call(json!({"cmd":"legacy_import_preview"})).expect("preview")
    }

    /// Exactly what a UI confirmation of `preview` binds: the snapshot and each importable hash.
    fn apply_args(preview: &Value) -> Value {
        let mut sources = serde_json::Map::new();
        for ledger in preview["ledgers"].as_array().unwrap() {
            if ledger["state"] == "ready" {
                sources.insert(ledger["ledger"].as_str().unwrap().into(), ledger["sha256"].clone());
            }
        }
        json!({"snapshot": preview["snapshot"]["id"], "sources": sources})
    }

    fn apply(&self, args: Value) -> Result<Value, String> {
        self.call(json!({"cmd":"legacy_import_apply","args":args}))
    }

    fn restart(&mut self) {
        self.host.shutdown();
        self.host = isolated_host_assuming_verified_ui(HostPaths { data: self.data.clone(), downloads: None }, self.runtime.handle().clone());
    }

    fn snapshot_dir(&self, preview: &Value) -> PathBuf {
        self.data.join("legacy-import").join(preview["snapshot"]["id"].as_str().unwrap())
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.host.shutdown();
        make_writable(&self.root);
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn make_writable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let Ok(meta) = std::fs::symlink_metadata(path) else { return };
    if meta.is_dir() {
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
        for entry in std::fs::read_dir(path).into_iter().flatten().flatten() {
            make_writable(&entry.path());
        }
    } else if meta.is_file() {
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
}

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn owner() -> Value {
    json!({"workspaceId":"ws","cwd":"/proj","hostId":"local","conversationId":"monitor-1"})
}

fn task(id: &str, status: &str, attempts: Value, request: &str) -> Value {
    json!({
        "id": id, "workspaceId": "ws", "owner": owner(),
        "destination": {"threadId":"build","workers":["null"],"newThread":false},
        "origin": "human_request", "originalRequest": request, "brief": "brief",
        "parentThreadId": "build", "executionThreadId": null, "workers": ["null"],
        "attempts": attempts, "status": status, "result": null,
        "resultData": {"mode":"in_place","checks":[],"leaseHeld":true,"unknownCostAccepted":true,"workerProfiles":[]},
        "revision": 4, "mode": "in_place", "usage": null, "createdAtMs": 10, "updatedAtMs": 20
    })
}

fn legacy_tasks() -> Value {
    let open_attempt = json!([{"number":1,"runId":"run-1","status":"running","startedAtMs":11,"finishedAtMs":null,"reviewRevision":null,"usage":null}]);
    json!({
        "version": 1, "revision": 9, "nextTaskId": 3, "nextRunId": 1,
        "tasks": {
            "task-1": task("task-1", "queued", json!([]), "Fix the login form\nand add tests"),
            "task-2": task("task-2", "running", open_attempt, "Refactor the parser"),
            "task-3": task("task-3", "done", json!([]), "Write the changelog"),
        },
        "requests": {"req-a": {"requestId":"req-a","owner":owner(),"text":"Fix the login form","requestedDestination":null,"taskId":"task-1"}},
        "executions": {"exec-thread": {"taskId":"task-2","workspaceId":"ws","threadId":"exec-thread","mode":"in_place","tombstonedAtMs":null}},
        "handoffs": {}
    })
}

fn conversation(id: &str, status: &str, text: &str) -> Value {
    json!({
        "request": {"requestId": id, "owner": owner(), "text": text, "destination": null,
            "threads": [{"id":"build","label":"Build Room","cwd":"/proj","snapshot":{"participants":[],"transcript":[],"options":{"policy":"mention","max_bot_hops":0}}}]},
        "status": status, "response": format!("Answer to {id}"), "revision": 2
    })
}

fn legacy_conversations() -> Value {
    json!({"version": 1, "records": {
        "req-a": conversation("req-a", "completed", "Fix the login form"),
        "req-b": conversation("req-b", "pending", "What is the project status?"),
    }})
}

const ROOM_ID: &str = "legacy-room";

fn room_file(data: &Path, id: &str) -> PathBuf {
    let name: String = id.bytes().map(|b| format!("{b:02x}")).collect();
    data.join("saved-chats-v1/rooms").join(format!("{name}.json"))
}

/// A pre-broker saved room: an Always-allow rule and a fallback mount outside its own lineage.
fn legacy_room() -> Value {
    json!({
        "cwd": "/proj/tree",
        "snapshot": {
            "participants": [{"id":"null","display_name":"Null","backend":{"kind":"agent","tool":"claude_code"}}],
            "transcript": [], "options": {"policy":"mention","max_bot_hops":0},
            "allowed": [{"by":"null","kind":"command","title":"Always allow rm","what":"rm -rf","allowed_at":1}],
            "plan": false
        },
        "mounts": [
            {"seq":0,"from":"/outside","to":"/elsewhere"},
            {"seq":1,"from":"/proj","to":"/proj/tree"}
        ]
    })
}

fn write_json(path: &Path, value: &Value) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
}

fn write_all_legacy(data: &Path) {
    write_json(&data.join(TASKS), &legacy_tasks());
    write_json(&data.join(CONVERSATIONS), &legacy_conversations());
    write_json(&room_file(data, ROOM_ID), &legacy_room());
}

fn ledger<'a>(preview: &'a Value, name: &str) -> &'a Value {
    preview["ledgers"].as_array().unwrap().iter().find(|l| l["ledger"] == name).unwrap_or_else(|| panic!("no {name} in {preview}"))
}

fn record<'a>(ledger: &'a Value, id: &str) -> &'a Value {
    ledger["records"].as_array().unwrap().iter().find(|r| r["id"] == id).unwrap_or_else(|| panic!("no {id} in {ledger}"))
}

#[test]
fn snapshot_copies_hashes_read_only_keeps_originals_and_is_reused() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new("snapshot", write_all_legacy);
    let originals: Vec<(PathBuf, Vec<u8>)> = [f.data.join(TASKS), f.data.join(CONVERSATIONS), room_file(&f.data, ROOM_ID)]
        .into_iter().map(|p| { let bytes = std::fs::read(&p).unwrap(); (p, bytes) }).collect();

    let preview = f.preview();
    let dir = f.snapshot_dir(&preview);
    assert_eq!(preview["snapshot"]["reused"], false);
    let manifest: Value = serde_json::from_slice(&std::fs::read(dir.join("manifest.json")).unwrap()).unwrap();
    let files = manifest["files"].as_array().unwrap();
    assert_eq!(files.len(), 3, "{manifest}");
    for (path, bytes) in &originals {
        let entry = files.iter().find(|e| e["source"] == path.to_string_lossy().as_ref()).unwrap_or_else(|| panic!("{path:?} not in {manifest}"));
        assert_eq!(entry["sha256"], sha(bytes));
        assert_eq!(entry["size"], bytes.len());
        let copy = dir.join(entry["file"].as_str().unwrap());
        assert_eq!(&std::fs::read(&copy).unwrap(), bytes);
        assert_eq!(std::fs::metadata(&copy).unwrap().permissions().mode() & 0o222, 0, "{copy:?} is writable");
    }
    assert_eq!(ledger(&preview, TASKS)["sha256"], sha(&originals[0].1));

    let again = f.preview();
    assert_eq!(again["snapshot"]["id"], preview["snapshot"]["id"]);
    assert_eq!(again["snapshot"]["reused"], true);
    assert_eq!(std::fs::read_dir(f.data.join("legacy-import")).unwrap().count(), 1, "a matching snapshot is not copied again");
    for (path, bytes) in &originals {
        assert_eq!(&std::fs::read(path).unwrap(), bytes, "{path:?} changed");
    }
}

#[test]
fn preview_maps_statuses_reports_missing_files_and_writes_no_protected_ledger() {
    let f = Fixture::new("preview", write_all_legacy);
    let preview = f.preview();

    let tasks = ledger(&preview, TASKS);
    assert_eq!(tasks["state"], "ready");
    assert_eq!(tasks["counts"]["records"], 3);
    let queued = record(tasks, "task-1");
    assert_eq!((queued["originalStatus"].as_str(), queued["importStatus"].as_str()), (Some("queued"), Some("proposed")));
    assert_eq!(queued["title"], "Fix the login form");
    assert!(queued["reason"].as_str().unwrap().to_lowercase().contains("confirm"), "{queued}");
    let running = record(tasks, "task-2");
    assert_eq!((running["originalStatus"].as_str(), running["importStatus"].as_str()), (Some("running"), Some("interrupted")));
    assert_eq!(record(tasks, "task-3")["importStatus"], "done");
    assert!(tasks["problems"].as_array().unwrap().iter().any(|p| p["id"] == "exec-thread"), "execution bindings are reported as not restored: {tasks}");

    let conversations = ledger(&preview, CONVERSATIONS);
    assert_eq!(conversations["counts"]["records"], 2);
    let pending = record(conversations, "req-b");
    assert_eq!((pending["originalStatus"].as_str(), pending["importStatus"].as_str()), (Some("pending"), Some("legacy")));

    let rooms = ledger(&preview, ROOMS);
    assert_eq!(rooms["state"], "ready");
    let room = record(rooms, ROOM_ID);
    assert_eq!(room["importStatus"], "restorable");
    let reason = room["reason"].as_str().unwrap();
    assert!(reason.contains("1 remembered permission") && reason.contains("1 folder"), "{reason}");

    for missing in ["personal-assistants.json", "personal-machine.json"] {
        assert_eq!(ledger(&preview, missing)["state"], "missing");
    }
    for name in [f.data.join(TASKS), f.data.join(CONVERSATIONS), f.data.join("saved-chats-v1").join(ROOMS)] {
        assert!(!protected_fixture_path(&name).exists(), "preview wrote {name:?}");
    }
}

#[test]
fn apply_imports_legacy_records_restores_rooms_without_permissions_and_dispatches_nothing() {
    let mut f = Fixture::new("apply", write_all_legacy);
    let preview = f.preview();
    let result = f.apply(Fixture::apply_args(&preview)).expect("apply");
    assert_eq!(result["complete"], true, "{result}");
    for name in [TASKS, CONVERSATIONS, ROOMS] {
        let entry = result["ledgers"].as_array().unwrap().iter().find(|l| l["ledger"] == name).unwrap();
        assert_eq!(entry["state"], "imported", "{result}");
        assert!(entry["verified"].as_bool().unwrap(), "{entry}");
    }

    // A restart runs the startup redispatch of queued work; legacy work stays put.
    f.restart();
    let listed = f.call(json!({"cmd":"assistant_tasks_list","args":{"owner":owner(),"requestId":"req-a"}})).unwrap();
    let tasks = listed["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 3, "{listed}");
    for task in tasks {
        assert!(task["id"].as_str().unwrap().starts_with("legacy-"), "{task}");
        assert_eq!(task["legacy"]["sourceSha256"], ledger(&preview, TASKS)["sha256"], "{task}");
        assert_eq!(task["legacy"]["verified"], false);
        assert_eq!(task["resultData"]["leaseHeld"], false);
        assert_eq!(task["resultData"]["unknownCostAccepted"], false, "remembered approvals are imported ungranted");
    }
    let queued = tasks.iter().find(|t| t["legacy"]["originalId"] == "task-1").unwrap();
    assert_eq!(queued["status"], "proposed");
    assert!(queued["attempts"].as_array().unwrap().is_empty(), "legacy queued work was dispatched");
    let running = tasks.iter().find(|t| t["legacy"]["originalId"] == "task-2").unwrap();
    assert_eq!(running["status"], "interrupted");
    assert!(running["attempts"][0]["finishedAtMs"].is_u64());
    assert_eq!(listed["request"]["status"], "legacy");

    let saved = apex_host::storage::Store::new(f.data.join("saved-chats-v1")).room(ROOM_ID).unwrap().expect("the legacy room restores");
    assert!(saved.snapshot.allowed.is_empty());
    assert_eq!(saved.cwd.as_deref(), Some("/proj/tree"));
    assert_eq!(saved.snapshot.participants.len(), 1);
    assert_eq!(saved.mounts.len(), 1);
    assert_eq!(saved.mounts[0].from, "/proj");

    // Full transcripts stay readable, from the hashed snapshot, labelled unverified.
    let history = f.call(json!({"cmd":"legacy_import_history","args":{"snapshot":preview["snapshot"]["id"],"requestId":"req-b"}})).unwrap();
    assert_eq!(history["verified"], false);
    assert_eq!(history["record"]["request"]["text"], "What is the project status?");
    assert_eq!(history["record"]["request"]["threads"][0]["label"], "Build Room");
    assert_eq!(history["sourceSha256"], ledger(&preview, CONVERSATIONS)["sha256"]);

    let again = f.preview();
    assert_eq!(ledger(&again, TASKS)["state"], "imported");
}

#[test]
fn apply_refuses_a_snapshot_changed_after_preview_and_writes_nothing() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new("tamper", write_all_legacy);
    let preview = f.preview();
    let copy = f.snapshot_dir(&preview).join(TASKS);
    std::fs::set_permissions(&copy, std::fs::Permissions::from_mode(0o600)).unwrap();
    let mut forged = legacy_tasks();
    forged["tasks"]["task-3"]["status"] = json!("queued");
    write_json(&copy, &forged);
    let error = f.apply(Fixture::apply_args(&preview)).unwrap_err();
    assert!(error.contains("changed"), "{error}");
    for name in [f.data.join(TASKS), f.data.join(CONVERSATIONS), f.data.join("saved-chats-v1").join(ROOMS)] {
        assert!(!protected_fixture_path(&name).exists(), "a refused apply wrote {name:?}");
    }
}

#[test]
fn apply_refuses_hashes_the_preview_did_not_show() {
    let f = Fixture::new("hash", write_all_legacy);
    let preview = f.preview();
    let mut args = Fixture::apply_args(&preview);
    args["sources"][TASKS] = json!(sha(b"something else"));
    let error = f.apply(args).unwrap_err();
    assert!(error.contains("changed"), "{error}");
    let missing = json!({"snapshot": preview["snapshot"]["id"], "sources": {}});
    assert!(f.apply(missing).is_err(), "an apply naming no ledger is refused");
    let traversal = json!({"snapshot": "../../etc", "sources": {TASKS: ledger(&preview, TASKS)["sha256"]}});
    assert!(f.apply(traversal).is_err());
}

#[test]
fn exact_retry_is_idempotent_and_changed_content_under_the_same_ledger_is_rejected() {
    let f = Fixture::new("retry", write_all_legacy);
    let preview = f.preview();
    let args = Fixture::apply_args(&preview);
    let first = f.apply(args.clone()).unwrap();
    let ledgers = [f.data.join(TASKS), f.data.join(CONVERSATIONS), f.data.join("saved-chats-v1").join(ROOMS)];
    let written: Vec<Vec<u8>> = ledgers.iter().map(|p| std::fs::read(protected_fixture_path(p)).unwrap()).collect();

    let second = f.apply(args).unwrap();
    for (name, path) in [TASKS, CONVERSATIONS, ROOMS].iter().zip(&ledgers) {
        let entry = second["ledgers"].as_array().unwrap().iter().find(|l| l["ledger"] == *name).unwrap();
        assert_eq!(entry["state"], "alreadyImported", "{second}");
        let original = first["ledgers"].as_array().unwrap().iter().find(|l| l["ledger"] == *name).unwrap();
        assert_eq!(entry["imported"], original["imported"]);
        let _ = path;
    }
    let after: Vec<Vec<u8>> = ledgers.iter().map(|p| std::fs::read(protected_fixture_path(p)).unwrap()).collect();
    assert_eq!(after, written, "an exact retry wrote again");

    let mut changed = legacy_tasks();
    changed["tasks"]["task-3"]["brief"] = json!("edited after the import");
    write_json(&f.data.join(TASKS), &changed);
    let newer = f.preview();
    assert_ne!(newer["snapshot"]["id"], preview["snapshot"]["id"]);
    assert_eq!(ledger(&newer, TASKS)["state"], "conflict");
    let sources = json!({TASKS: ledger(&newer, TASKS)["sha256"]});
    let result = f.apply(json!({"snapshot": newer["snapshot"]["id"], "sources": sources}));
    let refused = match result { Err(error) => error, Ok(value) => value.to_string() };
    assert!(refused.contains("different legacy content"), "{refused}");
    assert_eq!(std::fs::read(protected_fixture_path(&ledgers[0])).unwrap(), written[0]);
}

#[test]
fn an_oversized_conversations_source_imports_capped_envelopes_under_the_broker_limit() {
    let big = "x".repeat(1024 * 1024);
    let f = Fixture::new("oversized", |data| {
        let mut records = serde_json::Map::new();
        for n in 0..20 {
            let id = format!("req-{n}");
            records.insert(id.clone(), conversation(&id, "completed", &format!("Request {n}\n{big}")));
        }
        write_json(&data.join(CONVERSATIONS), &json!({"version":1,"records":records}));
    });
    let source = std::fs::metadata(f.data.join(CONVERSATIONS)).unwrap().len();
    assert!(source > BROKER_MAX_BYTES, "the synthetic source must exceed one broker document");
    let preview = f.preview();
    assert_eq!(ledger(&preview, CONVERSATIONS)["counts"]["records"], 20);
    let result = f.apply(Fixture::apply_args(&preview)).unwrap();
    assert_eq!(result["complete"], true, "{result}");
    let written = std::fs::metadata(protected_fixture_path(&f.data.join(CONVERSATIONS))).unwrap().len();
    assert!(written < BROKER_MAX_BYTES, "protected conversations are {written} bytes");
    let history = f.call(json!({"cmd":"legacy_import_history","args":{"snapshot":preview["snapshot"]["id"],"requestId":"req-7"}})).unwrap();
    assert_eq!(history["record"]["request"]["text"].as_str().unwrap().len(), big.len() + "Request 7\n".len());
}
