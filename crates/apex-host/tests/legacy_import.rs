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
fn imported_rooms_require_fresh_approval_for_saved_full_and_edit_access() {
    let mut f = Fixture::new("room-access", |data| {
        let mut room = legacy_room();
        room["cwd"] = json!(data.to_string_lossy());
        room["mounts"] = json!([]);
        room["snapshot"]["participants"] = json!([
            {"id":"full","display_name":"Full bot","access":"full","backend":{"kind":"scripted","lines":[]}},
            {"id":"edits","display_name":"Editing bot","access":"edits","backend":{"kind":"scripted","lines":[]}},
            {"id":"ask","display_name":"Asking bot","access":"ask","backend":{"kind":"scripted","lines":[]}},
            {"id":"read","display_name":"Reading bot","access":"read","backend":{"kind":"scripted","lines":[]}}
        ]);
        write_json(&room_file(data, ROOM_ID), &room);
    });
    let source = room_file(&f.data, ROOM_ID);
    let original = std::fs::read(&source).unwrap();
    let preview = f.preview();
    assert_eq!(f.apply(Fixture::apply_args(&preview)).unwrap()["complete"], true);
    assert_eq!(std::fs::read(source).unwrap(), original, "retain the original legacy file during import");

    // Admission to the ordinary room route is not a new access decision. The
    // protected manifest consumed by the adapters must require one after import.
    f.restart();
    let restored = f.host.room_create(ROOM_ID.into(), vec![], Default::default(), None).unwrap();
    let access: Vec<_> = restored.participants.iter().map(|p| (p.id.as_str(), p.access)).collect();
    assert_eq!(access, vec![
        ("full", apex_core::Access::Ask),
        ("edits", apex_core::Access::Ask),
        ("ask", apex_core::Access::Ask),
        ("read", apex_core::Access::Read),
    ], "import must not turn old Full or Edits labels into standing grants");
    assert!(restored.allowed.is_empty());

    // Opening/saving and another restart cannot recover the old editable grants.
    f.restart();
    let restored = f.host.room_create(ROOM_ID.into(), vec![], Default::default(), None).unwrap();
    assert_eq!(restored.participants[0].access, apex_core::Access::Ask);
    assert_eq!(restored.participants[1].access, apex_core::Access::Ask);
}

#[test]
fn custom_commands_stay_in_the_snapshot_until_added_again_from_the_ui() {
    let mut f = Fixture::new("room-custom-command", |data| {
        let mut room = legacy_room();
        room["cwd"] = json!(data.to_string_lossy());
        room["mounts"] = json!([]);
        room["snapshot"]["participants"] = json!([
            {"id":"custom","display_name":"My command","access":"ask",
             "backend":{"kind":"cli","program":"/bin/sh","args":["-c","exit 73"]}},
            {"id":"safe","display_name":"Regular bot","access":"read","backend":{"kind":"scripted","lines":[]}}
        ]);
        write_json(&room_file(data, ROOM_ID), &room);
    });
    let preview = f.preview();
    let result = f.apply(Fixture::apply_args(&preview)).unwrap();
    let rooms = result["ledgers"].as_array().unwrap().iter().find(|entry| entry["ledger"] == ROOMS).unwrap();
    assert_eq!(rooms["skipped"], 1);
    assert_eq!(rooms["skippedIds"], json!(["participant:legacy-room/custom"]));
    f.restart();
    let restored = f.host.room_create(ROOM_ID.into(), vec![], Default::default(), None).unwrap();
    let ids: Vec<_> = restored.participants.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(ids, vec!["safe"], "Ask cannot constrain an arbitrary custom executable; import must leave it inactive");

    let rows = ledger(&preview, ROOMS)["records"].as_array().unwrap();
    let command = rows.iter().find(|row| row["kind"] == "grant" && row["title"] == "My command").expect("preview the omitted command");
    assert_eq!(command["importStatus"], "notImported");
    assert!(command["reason"].as_str().unwrap().contains("add"), "{command}");
    let snapshot: Value = serde_json::from_slice(&std::fs::read(f.snapshot_dir(&preview).join("saved-chats-v1/rooms").join(room_file(&f.data, ROOM_ID).file_name().unwrap())).unwrap()).unwrap();
    assert_eq!(snapshot["snapshot"]["participants"][0]["backend"]["program"], "/bin/sh", "retain the original command for review");
}

#[test]
fn room_preview_explains_that_saved_access_needs_a_new_decision() {
    let f = Fixture::new("room-access-preview", |data| {
        let mut room = legacy_room();
        room["snapshot"]["participants"][0]["access"] = json!("full");
        write_json(&room_file(data, ROOM_ID), &room);
    });
    let preview = f.preview();
    let reason = record(ledger(&preview, ROOMS), ROOM_ID)["reason"].as_str().unwrap();
    assert!(reason.contains("Ask") && reason.contains("Full") && reason.contains("Edits"),
        "the access reset must be visible before confirming import: {reason}");
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
    assert!(error.starts_with("[LEGACY_IMPORT_PREVIEW_CHANGED]"), "{error}");
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
    assert!(error.starts_with("[LEGACY_IMPORT_PREVIEW_CHANGED]"), "{error}");
    assert!(error.contains("changed"), "{error}");
    let missing = json!({"snapshot": preview["snapshot"]["id"], "sources": {}});
    assert!(f.apply(missing).is_err(), "an apply naming no ledger is refused");
    let traversal = json!({"snapshot": "../../etc", "sources": {TASKS: ledger(&preview, TASKS)["sha256"]}});
    assert!(f.apply(traversal).is_err());
}

#[test]
fn room_state_labels_imported_rooms_from_protected_authority_after_restart_and_save() {
    let mut f = Fixture::new("room-marker", |data| {
        let mut room = legacy_room();
        room["cwd"] = json!(data.to_string_lossy());
        room["mounts"] = json!([]);
        room["snapshot"]["participants"] = json!([]);
        // Editable room files cannot establish the label's protected identity.
        room["legacy"] = json!({"verified":true,"sourceSha256":"forged"});
        write_json(&room_file(data, ROOM_ID), &room);
    });
    let preview = f.preview();
    f.apply(Fixture::apply_args(&preview)).unwrap();
    f.restart();
    f.host.room_create(ROOM_ID.into(), vec![], Default::default(), None).unwrap();
    let state = f.host.room_state(ROOM_ID.into()).unwrap();
    assert_eq!(state["legacy"]["verified"], false, "{state}");
    assert_eq!(state["legacy"]["sourceSha256"], ledger(&preview, ROOMS)["sha256"]);
    assert_eq!(state["legacy"]["originalId"], ROOM_ID);
    f.call(json!({"cmd":"room_set_plan","args":{"id":ROOM_ID,"on":true}})).unwrap();
    f.restart();
    f.host.room_create(ROOM_ID.into(), vec![], Default::default(), None).unwrap();
    assert_eq!(f.host.room_state(ROOM_ID.into()).unwrap()["legacy"], state["legacy"]);

    f.host.room_create("new-room".into(), vec![], Default::default(), None).unwrap();
    assert!(f.host.room_state("new-room".into()).unwrap()["legacy"].is_null());
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
    for name in [TASKS, CONVERSATIONS, ROOMS] {
        let entry = second["ledgers"].as_array().unwrap().iter().find(|l| l["ledger"] == name).unwrap();
        assert_eq!(entry["state"], "alreadyImported", "{second}");
        let original = first["ledgers"].as_array().unwrap().iter().find(|l| l["ledger"] == name).unwrap();
        assert_eq!(entry["imported"], original["imported"]);
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
fn newly_discovered_rooms_can_be_imported_after_an_earlier_room_import() {
    let f = Fixture::new("incremental-rooms", |data| write_json(&room_file(data, ROOM_ID), &legacy_room()));
    let first = f.preview();
    let original_args = Fixture::apply_args(&first);
    assert_eq!(f.apply(original_args.clone()).unwrap()["complete"], true);
    let authority = protected_fixture_path(&f.data.join("saved-chats-v1").join(ROOMS));
    let before: Value = serde_json::from_slice(&std::fs::read(&authority).unwrap()).unwrap();

    write_json(&room_file(&f.data, "later-room"), &legacy_room());
    let second = f.preview();
    assert_eq!(ledger(&second, ROOMS)["state"], "ready");
    assert_eq!(ledger(&second, ROOMS)["counts"]["importable"], 1);
    assert_eq!(ledger(&second, ROOMS)["records"][0]["id"], "later-room");
    let result = f.apply(Fixture::apply_args(&second)).unwrap();
    assert_eq!(result["complete"], true, "{result}");
    assert_eq!(result["ledgers"][0]["imported"], 1);
    let after: Value = serde_json::from_slice(&std::fs::read(&authority).unwrap()).unwrap();
    assert_eq!(after[ROOM_ID], before[ROOM_ID], "the earlier manifest is preserved");
    assert_eq!(after["later-room"]["legacy"]["verified"], false);
    assert_eq!(ledger(&f.preview(), ROOMS)["state"], "imported");
    let bytes = std::fs::read(&authority).unwrap();
    assert_eq!(f.apply(original_args).unwrap()["ledgers"][0]["state"], "alreadyImported");
    assert_eq!(std::fs::read(&authority).unwrap(), bytes);
}

#[test]
fn machine_grant_preview_counts_every_grant_as_not_imported() {
    const MACHINE: &str = "personal-machine.json";
    let f = Fixture::new("machine-grants", |data| {
        write_json(&data.join("saved-chats-v1").join(MACHINE), &json!({"allows": [
            {"hostId":"local","assistantHostId":"owner","assistantId":"asst-1","folder":"/one"},
            {"hostId":"local","assistantHostId":"owner","assistantId":"asst-1","folder":"/two"}
        ]}));
    });
    let preview = f.preview();
    let grants = ledger(&preview, MACHINE);
    assert_eq!(grants["state"], "notSupported");
    assert_eq!(grants["counts"]["records"], 2);
    assert_eq!(grants["counts"]["importable"], 0);
    assert_eq!(grants["counts"]["notImported"], 2);
    let rows = grants["records"].as_array().unwrap();
    assert_ne!(rows[0]["id"], rows[1]["id"], "each grant needs its own preview identity");
    assert!(rows.iter().all(|row| row["importStatus"] == "notImported"));
    assert!(!protected_fixture_path(&f.data.join("saved-chats-v1").join(MACHINE)).exists());
}

fn legacy_personal_assistant() -> Value {
    let task = |id: &str, status: &str| json!({
        "id":id,"goal":"Old command","completionCriteria":[],"targetHost":"owner","status":status,
        "operation":{"tool":"host.command","host":"owner","cwd":"/proj","argv":["true"]},
        "decision":{"id":format!("pd-{}", id.strip_prefix("pt-").unwrap()),"kind":"approve","paramsHash":"old-hash","prompt":"Run it?","status":"approved","openedAt":1},"fromEvent":"pe-1","maxAttempts":3,"createdAt":1,"updatedAt":2,
        "receipts":[{"opId":"op-1","paramsHash":"old-hash","phase":"attempted","startedAt":1,
            "process":{"pgid":4294967295u32,"started":1}}]
    });
    json!({
        "id":"asst-1","name":"Original","style":"Keep this style","hostId":"owner","profile":null,
        "allowedFolders":["/proj"],"paused":false,"revision":4,"createdAt":1,
        "counters":{"message":1,"event":1,"task":3,"decision":1},
        "look":{"color":"#123456","seed":"original"},"typeLabel":"legacy helper",
        "modes":{"read":"auto","write":"auto","send":"auto","spend":"auto"},
        "budget":{"unknownCostOk":true},
        "rules":[{"id":"pr-1","text":"Always ask before sending","class":"send","mode":"ask","createdAt":1}],
        "messages":[{"id":"pm-1","role":"human","kind":"chat","text":"Old request","at":1}],
        "events":[{"id":"pe-1","requestId":"req-old","source":{"kind":"human","text":"Old request"},"receivedAt":1,"state":"held","spendApproved":true}],
        "tasks":[task("pt-1","queued"),task("pt-2","running"),task("pt-3","done")],
        "facts":[
            {"id":"f-1","text":"Earlier","kind":"fact","explicit":true,"confidence":90,"source":{"messageId":"pm-1"},"createdAt":1,"supersededBy":"f-2","deletedAt":3},
            {"id":"f-2","text":"Corrected","kind":"fact","explicit":true,"confidence":90,"source":{"messageId":"pm-1"},"createdAt":2,"deletedAt":3}
        ],
        "schedules":[{"id":"ps-1","goal":"Check status","argv":["true"],"everyMs":60000,"nextAt":1,"status":"active","createdAt":1,"paramsHash":"old-hash","decision":{"id":"pd-4","kind":"schedule","paramsHash":"old-hash","prompt":"Schedule it?","status":"approved","openedAt":1}}],
        "machines":[{"hostId":"other","name":"Other Mac","folder":"/remote"}]
    })
}

#[test]
fn personal_import_preserves_identity_and_memory_chains_but_never_revives_authority() {
    const PERSONAL: &str = "personal-assistants.json";
    let f = Fixture::new("personal", |data| write_json(&data.join("saved-chats-v1").join(PERSONAL), &json!({"version":1,"assistants":[legacy_personal_assistant()]})));
    let preview = f.preview();
    let personal = ledger(&preview, PERSONAL);
    assert_eq!(personal["state"], "ready", "{personal}");
    let rows = personal["records"].as_array().unwrap();
    for kind in ["assistant", "memory", "schedule", "rule", "approval", "grant"] {
        assert!(rows.iter().any(|row| row["kind"] == kind), "missing {kind}: {personal}");
    }
    let result = f.apply(Fixture::apply_args(&preview)).unwrap();
    assert_eq!(result["complete"], true, "{result}");
    let path = protected_fixture_path(&f.data.join("saved-chats-v1").join(PERSONAL));
    let bytes = std::fs::read(&path).unwrap();
    let stored: Value = serde_json::from_slice(&bytes).unwrap();
    let assistant = &stored["assistants"][0];
    assert_eq!(assistant["name"], "Original");
    assert_eq!(assistant["look"]["seed"], "original");
    assert_eq!(assistant["typeLabel"], "legacy helper");
    assert_eq!(assistant["legacy"]["verified"], false);
    assert_eq!(assistant["facts"][0]["supersededBy"], "f-2");
    for fact in assistant["facts"].as_array().unwrap() {
        assert_eq!(fact["deletedAt"], 3);
        assert_eq!(fact["explicit"], false);
        assert_eq!(fact["legacy"]["verified"], false);
    }
    for class in ["read", "write", "send", "spend"] { assert_eq!(assistant["modes"][class], "ask"); }
    assert_eq!(assistant["allowedFolders"], json!(["/proj"]), "scope survives; all actions still ask");
    assert_eq!(assistant["legacy"]["originalAllowedFolders"], json!(["/proj"]));
    assert_eq!(assistant["messages"][0]["legacy"]["verified"], false);
    assert_eq!(assistant["budget"]["unknownCostOk"], false);
    assert!(assistant["machines"].as_array().unwrap().is_empty());
    assert_eq!(assistant["schedules"][0]["status"], "proposed");
    assert_eq!(assistant["schedules"][0]["nextAt"], Value::Null);
    assert_eq!(assistant["schedules"][0]["decision"]["status"], "open");
    assert_eq!(assistant["events"][0]["state"], "failed");
    assert_eq!(assistant["events"][0]["spendApproved"], false);
    for task in assistant["tasks"].as_array().unwrap() {
        assert_ne!(task["status"], "queued");
        assert_ne!(task["status"], "running");
        for receipt in task["receipts"].as_array().unwrap() {
            assert_ne!(receipt["phase"], "attempted", "legacy receipts cannot trigger recovery: {task}");
            assert_eq!(receipt["process"], Value::Null, "legacy process ids must never be signalled: {task}");
        }
    }
    let again = f.apply(Fixture::apply_args(&preview)).unwrap();
    assert_eq!(again["ledgers"][0]["state"], "alreadyImported");
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}

#[test]
fn personal_import_repairs_stale_counters_before_allocating_decisions() {
    const PERSONAL: &str = "personal-assistants.json";
    let f = Fixture::new("personal-counters", |data| {
        let mut assistant = legacy_personal_assistant();
        assistant["counters"] = json!({"message":0,"event":0,"task":0,"decision":0});
        assistant["schedules"][0].as_object_mut().unwrap().remove("decision");
        write_json(&data.join("saved-chats-v1").join(PERSONAL), &json!({"version":1,"assistants":[assistant]}));
    });
    let preview = f.preview();
    assert_eq!(f.apply(Fixture::apply_args(&preview)).unwrap()["complete"], true);
    let stored: Value = serde_json::from_slice(&std::fs::read(protected_fixture_path(&f.data.join("saved-chats-v1").join(PERSONAL))).unwrap()).unwrap();
    let assistant = &stored["assistants"][0];
    assert_eq!(assistant["schedules"][0]["decision"]["id"], "pd-4");
    for (counter, expected) in [("message",1),("event",1),("task",3),("decision",4),("fact",2),("schedule",1),("rule",1)] {
        assert_eq!(assistant["counters"][counter], expected, "{counter}");
    }
}

#[test]
fn personal_preview_rejects_duplicate_ids_and_exhausted_counters() {
    const PERSONAL: &str = "personal-assistants.json";
    for invalid in ["duplicate", "exhausted"] {
        let f = Fixture::new(invalid, |data| {
            let mut assistant = legacy_personal_assistant();
            if invalid == "duplicate" { assistant["tasks"][1]["decision"]["id"] = json!("pd-1"); }
            else { assistant["counters"]["message"] = json!(u64::MAX); }
            write_json(&data.join("saved-chats-v1").join(PERSONAL), &json!({"version":1,"assistants":[assistant]}));
        });
        let preview = f.preview();
        let personal = ledger(&preview, PERSONAL);
        assert_eq!(personal["counts"]["importable"], 0, "{personal}");
        assert!(!personal["problems"].as_array().unwrap().is_empty(), "{personal}");
        assert!(!protected_fixture_path(&f.data.join("saved-chats-v1").join(PERSONAL)).exists());
    }
}

#[test]
fn rooms_are_still_imported_when_the_task_document_cannot_be_written() {
    let f = Fixture::new("partial-write", write_all_legacy);
    let preview = f.preview();
    std::fs::create_dir_all(protected_fixture_path(&f.data.join(TASKS))).unwrap();
    let result = f.apply(Fixture::apply_args(&preview)).unwrap();
    assert_eq!(result["complete"], false, "{result}");
    let entries = result["ledgers"].as_array().unwrap();
    assert_eq!(entries.iter().find(|l| l["ledger"] == TASKS).unwrap()["state"], "failed");
    assert_eq!(entries.iter().find(|l| l["ledger"] == CONVERSATIONS).unwrap()["state"], "notAttempted");
    assert_eq!(entries.iter().find(|l| l["ledger"] == ROOMS).unwrap()["verified"], true);
    assert!(apex_host::storage::Store::new(f.data.join("saved-chats-v1")).room(ROOM_ID).unwrap().is_some());
}

#[test]
fn apply_reports_requests_and_handoffs_that_are_not_imported() {
    let f = Fixture::new("skipped-receipts", |data| {
        let mut legacy = legacy_tasks();
        legacy["handoffs"]["handoff-old"] = json!({"task_id":"task-1","payload":{
            "requestId":"handoff-old","batchId":"batch-old","owner":owner(),"revision":1,
            "originalRequest":"Old request","brief":"Old brief","destination":{"threadId":"build","workers":["null"],"newThread":false},
            "mode":"isolated","reviewCriteria":[]
        }});
        write_json(&data.join(TASKS), &legacy);
        let mut protected = legacy_tasks();
        protected["tasks"] = json!({});
        protected["executions"] = json!({});
        protected["requests"]["req-a"]["text"] = json!("Protected request");
        write_json(&protected_fixture_path(&data.join(TASKS)), &protected);
    });
    let preview = f.preview();
    let result = f.apply(Fixture::apply_args(&preview)).unwrap();
    assert_eq!(result["complete"], true, "{result}");
    let entry = &result["ledgers"][0];
    let skipped = entry["skippedIds"].as_array().unwrap();
    assert!(skipped.contains(&json!("request:req-a")), "{entry}");
    assert!(skipped.contains(&json!("handoff:handoff-old")), "{entry}");
    let stored: Value = serde_json::from_slice(&std::fs::read(protected_fixture_path(&f.data.join(TASKS))).unwrap()).unwrap();
    assert_eq!(stored["requests"]["req-a"]["text"], "Protected request");
    assert!(stored["handoffs"].as_object().unwrap().is_empty(), "legacy receipts must not be replayable");
}

#[test]
fn personal_apply_reports_assistants_rejected_in_preview() {
    const PERSONAL: &str = "personal-assistants.json";
    let f = Fixture::new("personal-skipped", |data| {
        let valid = legacy_personal_assistant();
        let mut invalid = valid.clone();
        invalid["id"] = json!("asst-2");
        invalid["tasks"][1]["decision"]["id"] = json!("pd-1");
        write_json(&data.join("saved-chats-v1").join(PERSONAL), &json!({"version":1,"assistants":[valid,invalid]}));
    });
    let preview = f.preview();
    assert_eq!(ledger(&preview, PERSONAL)["counts"]["importable"], 1);
    assert_eq!(ledger(&preview, PERSONAL)["problems"].as_array().unwrap().len(), 1);
    let result = f.apply(Fixture::apply_args(&preview)).unwrap();
    assert_eq!(result["complete"], true, "{result}");
    let entry = &result["ledgers"][0];
    assert_eq!(entry["imported"], 1);
    assert_eq!(entry["skipped"], 1, "{entry}");
    assert_eq!(entry["skippedIds"], json!(["assistant:asst-2"]));
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
