//! The content lane over a throwaway data folder, through `Host::call_from`.

use std::sync::Arc;

use serde_json::{json, Value};

use super::test_fixture::{caller, command, fixture, hits, Fixture, Gate};

fn targets(found: &[&Value]) -> Vec<Value> {
    found.iter().map(|hit| hit["target"].clone()).collect()
}

async fn seeded(name: &str) -> Fixture {
    let f = fixture(name);
    f.room("qa", "Installer QA", None, &[("", "Which checks are left?", 10)]);
    f.room("handoff", "Release handoff", None, &[
        ("", "Try the installer on a clean Mac before signing off.", 20),
        ("ada", "Done. The installer ran clean.", 30),
        ("", "Thanks", 40),
    ]);
    f.open("a").await;
    f
}

#[tokio::test(flavor = "multi_thread")]
async fn finds_message_newest_first() {
    let f = seeded("newest").await;
    let reply = f.find("a", "installer").await;
    let messages = hits(&reply, "message");
    assert_eq!(messages.iter().map(|hit| hit["at"].as_u64().unwrap()).collect::<Vec<_>>(), [30, 20]);
    let newest = messages[0];
    assert_eq!(newest["roomTitle"], "Release handoff");
    assert_eq!(newest["target"], json!({"type": "message", "room": "handoff", "roomKind": "work", "seq": 1, "originSeq": 101, "clientMessageId": "handoff-m1", "speaker": "ada"}));
    // The spans point at the word inside the snippet, in characters.
    let snippet: Vec<char> = newest["snippet"].as_str().unwrap().chars().collect();
    let span = &newest["ranges"][0];
    let word: String = snippet[span[0].as_u64().unwrap() as usize..span[1].as_u64().unwrap() as usize].iter().collect();
    assert_eq!(word, "installer");
    assert_eq!(messages[1]["target"]["speaker"], "You");
    assert_eq!(reply["totals"]["message"], json!({"count": 2, "exact": true}));
    // The thread named for the word is a name hit, not a message hit.
    assert_eq!(targets(&hits(&reply, "thread")), [json!({"type": "room", "room": "qa", "roomKind": "work"})]);
}

#[tokio::test(flavor = "multi_thread")]
async fn duplicate_phrase_yields_two_hits_with_distinct_targets() {
    let f = fixture("duplicate");
    f.room("r", "Release handoff", None, &[("", "run the installer", 1), ("ada", "ok", 2), ("", "run the installer", 3)]);
    f.open("a").await;
    let reply = f.find("a", "\"run the installer\"").await;
    let found = targets(&hits(&reply, "message"));
    assert_eq!(found.len(), 2);
    assert_eq!((found[0]["seq"].clone(), found[1]["seq"].clone()), (json!(2), json!(0)));
    assert_ne!(found[0]["clientMessageId"], found[1]["clientMessageId"]);
    assert_ne!(found[0]["originSeq"], found[1]["originSeq"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_limit_caps_rows_and_the_total_stays_exact() {
    let f = fixture("limit");
    let said: Vec<(&str, String, u64)> = (0..7).map(|n| ("", format!("installer note {n}"), n as u64)).collect();
    let said: Vec<(&str, &str, u64)> = said.iter().map(|(who, text, at)| (*who, text.as_str(), *at)).collect();
    f.room("r", "Notes", None, &said);
    f.open("a").await;
    let reply = f.search("a", json!({"lane": "content", "query": "installer", "limit": 3})).await.unwrap();
    assert_eq!(hits(&reply, "message").len(), 3);
    assert_eq!(reply["totals"]["message"], json!({"count": 7, "exact": true}));
    // The limit is clamped, never trusted.
    let reply = f.search("a", json!({"lane": "content", "query": "installer", "limit": 100000})).await.unwrap();
    assert_eq!(hits(&reply, "message").len(), 7);
}

#[tokio::test(flavor = "multi_thread")]
async fn archived_and_trashed_hidden_until_asked() {
    let f = seeded("visibility").await;
    f.meta("qa", |meta| meta.archived = true);
    f.meta("handoff", |meta| meta.trashed_at = Some(99));
    let plain = f.find("a", "installer").await;
    assert_eq!(plain["hits"], json!([]));
    let archived = f.search("a", json!({"lane": "content", "query": "installer", "includeArchived": true})).await.unwrap();
    assert_eq!(hits(&archived, "thread").len(), 1);
    assert_eq!(hits(&archived, "thread")[0]["archived"], true);
    assert_eq!(hits(&archived, "message").len(), 0, "the trashed thread stays out");
    let trashed = f.search("a", json!({"lane": "content", "query": "installer", "includeTrashed": true})).await.unwrap();
    assert_eq!(hits(&trashed, "message").len(), 2);
    assert!(hits(&trashed, "message").iter().all(|hit| hit["trashed"] == true));
    assert_eq!(hits(&trashed, "thread").len(), 0, "the archived thread stays out");
}

#[tokio::test(flavor = "multi_thread")]
async fn trashing_a_thread_hides_it_on_a_warm_cache() {
    let f = seeded("warm-trash").await;
    assert_eq!(hits(&f.find("a", "installer").await, "message").len(), 2);
    assert!(f.host.search().cached_bytes() > 0, "the text is warm");
    f.meta("handoff", |meta| meta.trashed_at = Some(99));
    assert_eq!(hits(&f.find("a", "installer").await, "message").len(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn deleted_thread_never_returned() {
    let f = seeded("deleted").await;
    f.host.store().delete_room("handoff").unwrap();
    let reply = f.search("a", json!({"lane": "content", "query": "installer", "includeArchived": true, "includeTrashed": true})).await.unwrap();
    assert_eq!(hits(&reply, "message").len(), 0);
    assert_eq!(hits(&reply, "thread").len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn same_size_rewrite_is_reread() {
    let f = fixture("rewrite");
    f.room("r", "Notes", None, &[("", "alpha word", 1)]);
    f.open("a").await;
    assert_eq!(hits(&f.find("a", "alpha").await, "message").len(), 1);
    f.room("r", "Notes", None, &[("", "omega word", 1)]);
    assert_eq!(hits(&f.find("a", "alpha").await, "message").len(), 0);
    assert_eq!(hits(&f.find("a", "omega").await, "message").len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn half_written_file_is_skipped_and_reported() {
    let f = seeded("half").await;
    let file = f.host.store().room_reader().unwrap().file("handoff");
    let whole = std::fs::read(&file).unwrap();
    std::fs::write(&file, &whole[..whole.len() / 2]).unwrap();
    let reply = f.find("a", "installer").await;
    assert_eq!(hits(&reply, "message").len(), 0);
    assert_eq!(reply["skipped"], json!([{"source": "handoff", "reason": "being_written"}]));
    assert_eq!(reply["totals"]["message"]["exact"], false, "a skipped thread makes the count a lower bound");
    // Whole again: found on the next query.
    std::fs::write(&file, &whole).unwrap();
    let reply = f.find("a", "installer").await;
    assert_eq!(hits(&reply, "message").len(), 2);
    assert_eq!(reply["skipped"], json!([]));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_file_swapped_during_the_read_is_never_served_stale() {
    let f = fixture("swap");
    f.room("r", "Notes", None, &[("", "the old text", 1)]);
    f.open("a").await;
    let swap = {
        let host = Arc::clone(&f.host);
        let once = std::sync::atomic::AtomicBool::new(true);
        move |_: &std::path::Path| {
            if once.swap(false, std::sync::atomic::Ordering::SeqCst) {
                let mut saved = host.store().room("r").unwrap().unwrap();
                saved.snapshot.transcript[0].text = "the new text".into();
                host.store().save_room("r", &saved).unwrap();
            }
        }
    };
    f.host.search().set_hooks(super::Hooks { before_room: None, before_read: Some(Arc::new(swap)) });
    let reply = f.find("a", "old").await;
    assert_eq!(hits(&reply, "message").len(), 0, "the old text is gone from disk and must not be answered");
    f.host.search().set_hooks(Default::default());
    assert_eq!(hits(&f.find("a", "new").await, "message").len(), 1);
    assert_eq!(hits(&f.find("a", "old").await, "message").len(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn remote_style_names_found() {
    let f = fixture("names");
    let project = f.data.join("apex-installer");
    std::fs::create_dir_all(&project).unwrap();
    let project = project.canonicalize().unwrap().to_string_lossy().into_owned();
    f.host.store().change_project(project.clone(), Some("Installer tools".into()), "add").unwrap();
    f.host.store().save_session(&json!({"version": 1, "workspaces": [], "panes": [{"id": "pane-thread", "title": "Installer pane title"}],
        "profiles": [{"id": "inst", "display_name": "Installer Bot"}, {"id": "ada", "display_name": "Ada"}]})).unwrap();
    f.room("pane-thread", "", Some(&project), &[("", "nothing relevant", 1)]);
    f.room("qa", "Installer QA", Some(&project), &[("", "nothing relevant", 2)]);
    f.room("exact", "installer", None, &[("", "nothing relevant", 3)]);
    f.open("a").await;
    let reply = f.find("a", "installer").await;
    assert_eq!(hits(&reply, "message").len(), 0);
    assert_eq!(targets(&hits(&reply, "project")), [json!({"type": "project", "path": project})]);
    assert_eq!(targets(&hits(&reply, "agent")), [json!({"type": "agent", "id": "inst"})]);
    // Exact name, then names that start with it; a title kept only by the window's session counts too.
    let threads: Vec<&str> = hits(&reply, "thread").iter().map(|hit| hit["title"].as_str().unwrap()).collect();
    assert_eq!(threads[0], "installer");
    assert_eq!(threads.len(), 3);
    assert!(threads.contains(&"Installer pane title") && threads.contains(&"Installer QA"));
    assert_eq!(hits(&reply, "thread").iter().find(|hit| hit["title"] == "Installer QA").unwrap()["project"], json!(project));

    // Scoped to the project: its two threads only, and no machine-wide names.
    let scoped = f.search("a", json!({"lane": "content", "query": "installer", "project": project})).await.unwrap();
    assert_eq!(hits(&scoped, "thread").len(), 2);
    assert_eq!(hits(&scoped, "project").len() + hits(&scoped, "agent").len(), 0);
    // A folder that is not a registered project is refused, not opened.
    let error = f.search("a", json!({"lane": "content", "query": "installer", "project": "/etc"})).await.unwrap_err();
    assert!(error.contains("isn't registered"), "{error}");
    // Kinds filter.
    let only = f.search("a", json!({"lane": "content", "query": "installer", "kinds": ["agent"]})).await.unwrap();
    assert_eq!(only["hits"].as_array().unwrap().len(), 1);
    assert_eq!(only["totals"].as_object().unwrap().keys().collect::<Vec<_>>(), ["agent"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn task_note_library_and_assistant_hits_carry_their_ids() {
    use crate::assistant_conversation::ConversationRequest;
    use crate::assistant_tasks::{HumanRequest, TaskOwner};
    use crate::personal_workspace::ProjectRef;
    let f = fixture("ids");
    let owner = TaskOwner { workspace_id: "ws".into(), cwd: "/work/app".into(), host_id: "host".into(), conversation_id: "conv-1".into() };
    let task = f.host.assistant_tasks.submit_human_request(
        HumanRequest { request_id: "req-1".into(), owner: owner.clone(), text: "Check the installer on Windows".into(), destination: None },
        "Verify the installer signs correctly".into(), None).unwrap();
    let note = f.host.project_memory.save(crate::project_memory::SaveNote {
        project: ProjectRef { host_id: "host".into(), workspace_id: "ws".into(), cwd: "/work/app".into() },
        id: None, expected_version: None, text: "The installer needs notarization before release.".into(),
        kind: crate::personal::FactKind::Fact, author: None, source: Default::default(), expires_at: None, now: 5,
    }).unwrap();
    let library = f.data.join("library");
    std::fs::create_dir_all(&library).unwrap();
    std::fs::write(library.join("shot-1.png"), b"png").unwrap();
    std::fs::write(library.join("index.json"), json!([{"file": "shot-1.png", "name": "Installer splash", "kind": "image", "source": "/tmp/x.png", "room": "r", "created": 7}]).to_string()).unwrap();
    f.host.assistant_conversations.begin(ConversationRequest {
        request_id: "ask-1".into(), owner: owner.clone(), text: "Where is the installer log kept?".into(), destination: None,
        new_worker_profiles: vec![], worker_profiles: vec![], threads: vec![], evidence: vec![], source_chats: vec![],
    }, false).unwrap();
    f.open("a").await;
    let reply = f.find("a", "installer").await;
    assert_eq!(targets(&hits(&reply, "task")), [json!({"type": "task", "id": task.id})]);
    assert_eq!(hits(&reply, "task")[0]["title"], "Verify the installer signs correctly");
    assert_eq!(targets(&hits(&reply, "note")), [json!({"type": "note", "id": note.id, "project": "/work/app"})]);
    assert_eq!(targets(&hits(&reply, "library")), [json!({"type": "library", "file": "shot-1.png"})]);
    assert_eq!(targets(&hits(&reply, "message")), [json!({"type": "message", "room": "conv-1", "roomKind": "assistant", "seq": 0, "originSeq": null, "clientMessageId": "ask-1", "speaker": "You"})]);
}

#[tokio::test(flavor = "multi_thread")]
async fn newer_request_cancels_older() {
    let f = seeded("newer").await;
    let gate = Gate::install(&f);
    let ask = |query: &'static str| {
        let host = Arc::clone(&f.host);
        tokio::spawn(async move { host.call_from(command("search", json!({"lane": "content", "query": query})), caller("a")).await })
    };
    let older = ask("instal");
    let gate = tokio::task::spawn_blocking(move || { gate.held(); gate }).await.unwrap();
    let newer = ask("installer");
    // The newer one is now the connection's request; the older is cancelled.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    gate.release();
    let older = older.await.unwrap().unwrap();
    assert_eq!(older["hits"], json!([]));
    assert_eq!(older["skipped"][0]["reason"], "busy");
    assert_eq!(hits(&newer.await.unwrap().unwrap(), "message").len(), 2);
    assert_eq!(f.host.search().scans(), 0, "nothing left running once the last answer arrived");
}

#[tokio::test(flavor = "multi_thread")]
async fn searching_never_writes() {
    let f = seeded("no-writes").await;
    fn listing(dir: &std::path::Path, out: &mut Vec<(std::path::PathBuf, u64, std::time::SystemTime)>) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let meta = entry.metadata().unwrap();
            if meta.is_dir() { listing(&entry.path(), out) } else { out.push((entry.path(), meta.len(), meta.modified().unwrap())) }
        }
    }
    let before = { let mut all = Vec::new(); listing(&f.data, &mut all); all.sort(); all };
    f.find("a", "installer").await;
    f.search("a", json!({"lane": "content", "query": "installer", "includeArchived": true, "includeTrashed": true})).await.unwrap();
    let after = { let mut all = Vec::new(); listing(&f.data, &mut all); all.sort(); all };
    assert_eq!(before, after, "a search changes no file and adds none");
}

#[tokio::test(flavor = "multi_thread")]
async fn bad_queries_and_unbuilt_lanes_say_so() {
    let f = seeded("bad").await;
    assert!(f.search("a", json!({"lane": "content", "query": "i"})).await.unwrap_err().contains("at least 2"));
    assert_eq!(f.search("a", json!({"lane": "files", "query": "installer"})).await.unwrap_err(), super::LANE_UNAVAILABLE);
    assert_eq!(f.search("a", json!({"lane": "steps", "query": "installer"})).await.unwrap_err(), super::LANE_UNAVAILABLE);
}
