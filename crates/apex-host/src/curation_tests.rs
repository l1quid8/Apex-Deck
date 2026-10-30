use super::*;
use crate::journal;
use apex_core::Curation;
fn fixture(name: &str, curated: bool) -> (Arc<Host>, tokio::runtime::Runtime, PathBuf) {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    let data =
        std::env::temp_dir().join(format!("apex-curation-host-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    let host = Host::new(
        HostPaths {
            data: data.clone(),
            downloads: None,
        },
        runtime.handle().clone(),
    );
    let bot = apex_core::testing::ScriptedParticipant::new(
        "null",
        &[r#"{"hide":["0-4"],"reason":"done"}"#],
    );
    let mut snapshot = Room::new(vec![Arc::new(bot)], RoomOptions::default()).snapshot();
    snapshot.transcript=(0..40).map(|seq|serde_json::from_value(serde_json::json!({"seq":seq,"speaker":{"kind":"human"},"text":format!("message {seq}")})).unwrap()).collect();
    if curated {
        snapshot.curations = vec![Curation {
            by: ParticipantId::new("null"),
            at: 30,
            hidden: vec![[2, 5]],
            reason: "done".into(),
            when: 1,
            undone: None,
        }];
    }
    host.store
        .save_room(
            "r",
            &SavedRoom {
                snapshot,
                cwd: None,
                mounts: vec![],
            },
        )
        .unwrap();
    host.room_open("r".into(), vec![], RoomOptions::default(), None, true)
        .unwrap();
    (host, runtime, data)
}
fn path(data: &Path) -> PathBuf {
    journal::path_for(&data.join("attachments"), "r").unwrap()
}
#[test]
fn journal_open_rewind_append_clear_and_fork_lifecycle() {
    let (h, rt, data) = fixture("lifecycle", true);
    let p = path(&data);
    assert!(p.exists());
    assert!(std::fs::read_to_string(&p).unwrap().contains("message 39"));
    rt.block_on(async {
        let handle = h.handle("r").unwrap();
        handle.room.lock().await.rewind(35);
        checkpoint_room(&handle, &h.store, "r").await.unwrap();
    });
    assert!(!std::fs::read_to_string(&p).unwrap().contains("message 39"));
    rt.block_on(async {
        let handle = h.handle("r").unwrap();
        handle
            .room
            .lock()
            .await
            .append_assistant_note("new message".into(), &|_| {});
        checkpoint_room(&handle, &h.store, "r").await.unwrap();
    });
    assert!(std::fs::read_to_string(&p).unwrap().contains("new message"));
    let snap = rt.block_on(async { h.handle("r").unwrap().room.lock().await.snapshot() });
    h.room_import("fork".into(), snap, None, false).unwrap();
    h.room_open("fork".into(), vec![], RoomOptions::default(), None, true)
        .unwrap();
    assert!(journal::path_for(&data.join("attachments"), "fork")
        .unwrap()
        .is_file());
    rt.block_on(h.room_clear("r".into())).unwrap();
    assert!(!p.exists());
    h.shutdown();
    drop(h);
    drop(rt);
    let _ = std::fs::remove_dir_all(data);
}
#[test]
fn journal_rewrite_failure_invalidates_and_clears_live_hint() {
    let (h, rt, data) = fixture("rewrite", true);
    let p = path(&data);
    std::fs::create_dir(p.with_extension("md.tmp")).unwrap();
    rt.block_on(h.room_rewind("r".into(), 35)).unwrap();
    assert!(!p.exists());
    let req = rt.block_on(async {
        h.handle("r")
            .unwrap()
            .room
            .lock()
            .await
            .next_steps_request(&ParticipantId::new("null"))
            .unwrap()
            .1
    });
    assert!(req.system.contains("can't be read right now"));
    h.shutdown();
    drop(h);
    drop(rt);
    let _ = std::fs::remove_dir_all(data);
}
#[test]
fn journal_failed_snapshot_save_after_rewind_invalidates_old_text() {
    let (h, rt, data) = fixture("savefail", true);
    let p = path(&data);
    std::fs::create_dir(h.store.root().join("rooms/72.tmp")).unwrap();
    assert!(rt.block_on(h.room_rewind("r".into(), 35)).is_err());
    assert!(!p.exists());
    let req = rt.block_on(async {
        h.handle("r")
            .unwrap()
            .room
            .lock()
            .await
            .next_steps_request(&ParticipantId::new("null"))
            .unwrap()
            .1
    });
    assert!(req.system.contains("can't be read right now"));
    h.shutdown();
    drop(h);
    drop(rt);
    let _ = std::fs::remove_dir_all(data);
}
#[test]
fn journal_closed_replacement_does_not_leave_old_history_readable() {
    let (h, rt, data) = fixture("replace", true);
    let old = h.store.room("r").unwrap().unwrap().snapshot;
    h.room_close("r".into());
    assert!(path(&data).exists());
    h.room_import("r".into(), old.fork(10), None, true).unwrap();
    assert!(!path(&data).exists());
    h.shutdown();
    drop(h);
    drop(rt);
    let _ = std::fs::remove_dir_all(data);
}
#[test]
fn journal_deletion_handles_open_and_closed_threads_and_late_checkpoints() {
    for closed in [false, true] {
        let (h, rt, data) = fixture(if closed { "deleteclosed" } else { "deleteopen" }, true);
        let handle = h.handle("r").unwrap();
        if closed {
            h.room_close("r".into());
        }
        h.room_delete("r".into()).unwrap();
        rt.block_on(checkpoint_room(&handle, &h.store, "r"))
            .unwrap();
        assert!(!path(&data).exists());
        h.shutdown();
        drop(h);
        drop(rt);
        let _ = std::fs::remove_dir_all(data);
    }
}
#[test]
fn journal_open_surfaces_stale_failure() {
    let (h, rt, data) = fixture("openstale", true);
    h.room_close("r".into());
    let p = path(&data);
    std::fs::remove_file(&p).unwrap();
    std::fs::create_dir(&p).unwrap();
    std::fs::create_dir(p.with_extension("md.tmp")).unwrap();
    let err = h
        .room_open("r".into(), vec![], RoomOptions::default(), None, true)
        .unwrap_err();
    assert!(err.contains("may still be readable"));
    h.shutdown();
    drop(h);
    drop(rt);
    let _ = std::fs::remove_dir_all(data);
}
#[test]
fn journal_never_exists_for_threads_without_curation() {
    let (h, rt, data) = fixture("none", false);
    assert!(!path(&data).exists());
    h.shutdown();
    drop(h);
    drop(rt);
    let _ = std::fs::remove_dir_all(data);
}
#[test]
fn journal_failed_replacement_clears_the_open_rooms_hint() {
    let (h, rt, data) = fixture("replacefail", true);
    let old = h.store.room("r").unwrap().unwrap().snapshot;
    std::fs::create_dir(h.store.root().join("rooms/72.tmp")).unwrap();
    assert!(h.room_import("r".into(), old.fork(10), None, true).is_err());
    let req = rt.block_on(async {
        h.handle("r")
            .unwrap()
            .room
            .lock()
            .await
            .next_steps_request(&ParticipantId::new("null"))
            .unwrap()
            .1
    });
    assert!(req.system.contains("can't be read right now"));
    assert!(!req.system.contains(path(&data).to_str().unwrap()));
    h.shutdown();
    drop(h);
    drop(rt);
    let _ = std::fs::remove_dir_all(data);
}
