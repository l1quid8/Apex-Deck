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
fn journal_open_warns_about_stale_text_without_blocking_the_thread() {
    let (h, rt, data) = fixture("openstale", true);
    h.room_close("r".into());
    let p = path(&data);
    std::fs::remove_file(&p).unwrap();
    std::fs::create_dir(&p).unwrap();
    std::fs::create_dir(p.with_extension("md.tmp")).unwrap();
    let warnings = Arc::new(Mutex::new(Vec::new()));
    let seen = warnings.clone();
    h.events().listen(move |envelope| seen.lock().unwrap().push(serde_json::to_value(&envelope.event).unwrap()));
    h
        .room_open("r".into(), vec![], RoomOptions::default(), None, true)
        .unwrap();
    assert!(h.handle("r").is_ok());
    assert!(warnings.lock().unwrap().iter().any(|e| e["payload"]["event"]["type"] == "journal_warning"
        && e["payload"]["event"]["error"].as_str().is_some_and(|s| s.contains("may still be readable"))));
    let req = rt.block_on(async { h.handle("r").unwrap().room.lock().await.next_steps_request(&ParticipantId::new("null")).unwrap().1 });
    assert!(req.system.contains("can't be read right now"));
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
#[test]
fn curate_and_undo_are_durable_across_restart() {
    let (h, rt, data) = fixture("curate", false);
    let reply = rt.block_on(h.room_curate("r".into())).unwrap();
    assert_eq!(
        serde_json::to_value(reply).unwrap(),
        serde_json::json!({"by":"null","status":"hidden","count":5,"unchecked":0})
    );
    assert!(path(&data).exists());
    h.room_close("r".into());
    h.room_open("r".into(), vec![], RoomOptions::default(), None, true)
        .unwrap();
    assert_eq!(
        h.store.room("r").unwrap().unwrap().snapshot.curations.len(),
        1
    );
    let undo = rt.block_on(h.room_curate_undo("r".into())).unwrap();
    assert_eq!(undo.restored, 5);
    assert!(!path(&data).exists());
    assert!(h.store.room("r").unwrap().unwrap().snapshot.curations[0]
        .undone
        .is_some());
    h.shutdown();
    drop(h);
    drop(rt);
    let _ = std::fs::remove_dir_all(data);
}
#[test]
fn curate_refuses_talk_only_and_custom_cli_without_tool_free_mode() {
    for chat in [true, false] {
        let (h, rt, data) = fixture(if chat { "chatrefuse" } else { "clirefuse" }, false);
        h.room_close("r".into());
        let mut saved = h.store.room("r").unwrap().unwrap();
        if chat {
            saved.snapshot.kind = apex_core::RoomKind::Chat;
        } else {
            saved.snapshot.participants[0].backend = apex_core::Backend::Cli {
                program: "never-run".into(),
                args: vec![],
            };
        }
        h.store.save_room("r", &saved).unwrap();
        h.room_open("r".into(), vec![], RoomOptions::default(), None, true)
            .unwrap();
        let err = rt.block_on(h.room_curate("r".into())).err().unwrap();
        if chat {
            assert_eq!(err, "Move to a Work thread to use /curate.");
            assert!(rt.block_on(h.room_curate_undo("r".into())).is_err());
        } else {
            assert!(err.contains("can't pick without tools"));
        }
        assert!(!path(&data).exists());
        h.shutdown();
        drop(h);
        drop(rt);
        let _ = std::fs::remove_dir_all(data);
    }
}
#[test]
fn curate_and_undo_refuse_a_running_turn() {
    let (h, rt, data) = fixture("busy", false);
    let handle = h.handle("r").unwrap();
    rt.block_on(async {
        let batch = handle
            .runtime
            .begin_post("go", None, &|_| {})
            .await
            .unwrap();
        assert!(h.room_curate("r".into()).await.is_err());
        assert!(h.room_curate_undo("r".into()).await.is_err());
        handle.runtime.run(batch, &|_| {}).await;
    });
    h.shutdown();
    drop(h);
    drop(rt);
    let _ = std::fs::remove_dir_all(data);
}
#[test]
fn curate_unwritable_journal_hides_nothing() {
    let (h, rt, data) = fixture("preflight", false);
    std::fs::create_dir_all(data.join("attachments/deck-journals")).unwrap();
    std::fs::write(path(&data).parent().unwrap(), "block").unwrap();
    let err = rt.block_on(h.room_curate("r".into())).err().unwrap();
    assert!(err.to_lowercase().contains("journal"));
    assert!(h
        .store
        .room("r")
        .unwrap()
        .unwrap()
        .snapshot
        .curations
        .is_empty());
    h.shutdown();
    drop(h);
    drop(rt);
    let _ = std::fs::remove_dir_all(data);
}
#[test]
fn curate_model_and_checkpoint_errors_are_both_returned() {
    let (h, rt, data) = fixture("doublefail", false);
    h.room_close("r".into());
    let mut saved = h.store.room("r").unwrap().unwrap();
    saved.snapshot.participants[0].backend = apex_core::Backend::Scripted {
        lines: vec!["!fail CURATOR_OFFLINE".into()],
    };
    h.store.save_room("r", &saved).unwrap();
    h.room_open("r".into(), vec![], RoomOptions::default(), None, true)
        .unwrap();
    std::fs::create_dir(h.store.root().join("rooms/72.tmp")).unwrap();
    let err = rt.block_on(h.room_curate("r".into())).err().unwrap();
    assert!(err.contains("CURATOR_OFFLINE"));
    assert!(err.contains("save data"), "{err}");
    assert!(!path(&data).exists());
    h.shutdown();
    drop(h);
    drop(rt);
    let _ = std::fs::remove_dir_all(data);
}
#[test]
fn curate_empty_and_failed_runs_leave_no_journal() {
    for fail in [true, false] {
        let (h, rt, data) = fixture(if fail { "modelerr" } else { "empty" }, false);
        h.room_close("r".into());
        let mut saved = h.store.room("r").unwrap().unwrap();
        saved.snapshot.participants[0].backend = apex_core::Backend::Scripted {
            lines: vec![if fail {
                "!fail offline"
            } else {
                r#"{"hide":[]}"#
            }
            .into()],
        };
        h.store.save_room("r", &saved).unwrap();
        h.room_open("r".into(), vec![], RoomOptions::default(), None, true)
            .unwrap();
        let result = rt.block_on(h.room_curate("r".into()));
        assert_eq!(result.is_err(), fail);
        assert!(!path(&data).exists());
        h.shutdown();
        drop(h);
        drop(rt);
        let _ = std::fs::remove_dir_all(data);
    }
}

#[test]
fn curate_stopped_runs_leave_no_journal() {
    let (h, rt, data) = fixture("stop", false);
    let stop = h.handle("r").unwrap().stop;
    h.events().listen(move |envelope| {
        if matches!(
            envelope.event,
            HostEvent::Room {
                event: RoomEvent::TurnStarted { .. },
                ..
            }
        ) {
            stop.store(true, Ordering::SeqCst);
        }
    });
    let reply = rt.block_on(h.room_curate("r".into())).unwrap();
    assert!(matches!(reply.outcome, apex_core::CurateOutcome::Stopped));
    assert!(!path(&data).exists());
    h.shutdown();
    drop(h);
    drop(rt);
    let _ = std::fs::remove_dir_all(data);
}

#[test]
fn curate_does_not_mask_a_stale_journal_warning_with_a_model_error() {
    let (h, rt, data) = fixture("staleandmodel", false);
    h.room_close("r".into());
    let mut saved = h.store.room("r").unwrap().unwrap();
    saved.snapshot.participants[0].backend = apex_core::Backend::Scripted {
        lines: vec!["!fail CURATOR_OFFLINE".into()],
    };
    h.store.save_room("r", &saved).unwrap();
    h.room_open("r".into(), vec![], RoomOptions::default(), None, true)
        .unwrap();
    let p = path(&data);
    let warnings = Arc::new(Mutex::new(Vec::new()));
    let seen = warnings.clone();
    h.events().listen(move |envelope| {
        seen.lock().unwrap().push(serde_json::to_value(&envelope.event).unwrap());
        if matches!(
            envelope.event,
            HostEvent::Room {
                event: RoomEvent::TurnStarted { .. },
                ..
            }
        ) {
            std::fs::remove_file(&p).unwrap();
            std::fs::create_dir(&p).unwrap();
        }
    });
    let err = rt.block_on(h.room_curate("r".into())).unwrap_err();
    assert!(
        err.contains("CURATOR_OFFLINE"),
        "{err}"
    );
    assert!(warnings.lock().unwrap().iter().any(|e| e["payload"]["event"]["type"] == "journal_warning"
        && e["payload"]["event"]["error"].as_str().is_some_and(|s| s.contains("may still be readable"))));
    h.shutdown();
    drop(h);
    drop(rt);
    let _ = std::fs::remove_dir_all(data);
}

#[test]
fn journal_warning_does_not_block_accepted_posts_or_terminal_idle() {
    let (h, rt, data) = fixture("poststale", true);
    let p = path(&data);
    std::fs::remove_file(&p).unwrap();
    std::fs::create_dir(&p).unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let seen = events.clone();
    h.events().listen(move |e| seen.lock().unwrap().push(serde_json::to_value(&e.event).unwrap()));
    let handle = h.handle("r").unwrap();
    rt.block_on(async {
        let batch = h.prepare_post("r", &handle, "continue", None).await.unwrap();
        h.run_batch("r", &handle, batch).await.unwrap();
    });
    assert!(h.store.room("r").unwrap().unwrap().snapshot.transcript.iter().any(|m| m.text == "continue"));
    let events = events.lock().unwrap();
    assert!(events.iter().any(|e| e["payload"]["event"]["type"] == "journal_warning"));
    assert!(events.iter().any(|e| e["payload"]["event"]["type"] == "idle"));
    assert!(!events.iter().any(|e| e["payload"]["event"]["type"] == "failed"));
    assert!(!handle.runtime.busy());
    drop(events);
    h.shutdown();
    drop(h);
    drop(rt);
    let _ = std::fs::remove_dir_all(data);
}

#[test]
fn per_bot_stop_cancels_compaction_without_setting_a_summary() {
    per_bot_stop_cancels_context_operation(true);
}

#[test]
fn per_bot_stop_cancels_curation_without_hiding_messages() {
    per_bot_stop_cancels_context_operation(false);
}

fn per_bot_stop_cancels_context_operation(compact: bool) {
    struct Waiting {
        config: ParticipantConfig,
        started: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    }
    #[async_trait::async_trait]
    impl apex_core::Participant for Waiting {
        fn config(&self) -> &ParticipantConfig { &self.config }
        async fn respond(&self, _: apex_core::TurnRequest, _: apex_core::DeltaSink<'_>) -> Result<apex_core::Reply, apex_core::ParticipantError> {
            if let Some(started) = self.started.lock().unwrap().take() { let _ = started.send(()); }
            std::future::pending().await
        }
    }
    let (h, rt, data) = fixture(if compact { "compactstop" } else { "curatestop" }, false);
    let handle = h.handle("r").unwrap();
    let (tx, rx) = tokio::sync::oneshot::channel();
    let bot = Waiting {
        config: handle.checkpoint.lock().unwrap().snapshot.participants[0].clone(),
        started: Mutex::new(Some(tx)),
    };
    rt.block_on(async {
        let operation = async {
            let mut room = handle.room.lock().await;
            let sink = |event| h.room_event_for("r", &handle, event);
            if compact { room.compact(&bot, &sink).await.unwrap(); }
            else { assert_eq!(room.curate(&bot, &sink).await.unwrap(), apex_core::CurateOutcome::Stopped); }
            assert!(room.snapshot().curations.is_empty());
            assert!(room.snapshot().compaction.is_none());
        };
        let stop = async {
            rx.await.unwrap();
            h.room_stop("r".into(), Some(ParticipantId::new("null")));
        };
        tokio::time::timeout(std::time::Duration::from_secs(2), async { tokio::join!(operation, stop); }).await
            .expect("per-bot Stop must interrupt a context operation while it holds the room lock");
    });
    h.shutdown();
    drop(h);
    drop(rt);
    let _ = std::fs::remove_dir_all(data);
}

#[test]
fn per_bot_stop_during_a_normal_turn_does_not_stop_the_whole_room() {
    let (h, rt, data) = fixture("normalstop", false);
    let handle = h.handle("r").unwrap();
    rt.block_on(async {
        let batch = handle.runtime.begin_post("go", None, &|_| {}).await.unwrap();
        h.room_stop("r".into(), Some(ParticipantId::new("null")));
        assert!(!handle.stop.load(Ordering::SeqCst));
        handle.runtime.run(batch, &|_| {}).await;
    });
    h.shutdown();
    drop(h);
    drop(rt);
    let _ = std::fs::remove_dir_all(data);
}

#[test]
fn compact_refreshes_the_curated_journal_and_seals_undo() {
    let (h, rt, data) = fixture("compact", true);
    rt.block_on(h.room_compact("r".into())).unwrap();
    let saved = h.store.room("r").unwrap().unwrap();
    assert_eq!(saved.snapshot.compaction.unwrap().upto, 40);
    assert!(std::fs::read_to_string(path(&data))
        .unwrap()
        .contains("message 39"));
    let undo = rt.block_on(h.room_curate_undo("r".into())).unwrap();
    assert_eq!((undo.restored, undo.sealed), (0, 4));
    assert!(path(&data).exists());
    h.shutdown();
    drop(h);
    drop(rt);
    let _ = std::fs::remove_dir_all(data);
}

#[test]
fn curate_events_from_a_retired_handle_cannot_change_a_reopened_thread() {
    let (h, rt, data) = fixture("retired", false);
    let old = h.handle("r").unwrap();
    let snapshot = h.store.room("r").unwrap().unwrap().snapshot;
    h.room_import("r".into(), snapshot.fork(10), None, true)
        .unwrap();
    h.room_open("r".into(), vec![], RoomOptions::default(), None, true)
        .unwrap();
    let before = h.events().last_seq();
    h.room_event_for(
        "r",
        &old,
        RoomEvent::CurationsChanged {
            curations: vec![Curation {
                by: ParticipantId::new("null"),
                at: 40,
                hidden: vec![[0, 4]],
                reason: "late reply".into(),
                when: 1,
                undone: None,
            }],
        },
    );
    assert_eq!(h.events().last_seq(), before);
    assert!(h
        .handle("r")
        .unwrap()
        .checkpoint
        .lock()
        .unwrap()
        .snapshot
        .curations
        .is_empty());
    assert!(rt
        .block_on(h.save_curation(&old, "r"))
        .unwrap_err()
        .contains("replaced"));
    assert!(!path(&data).exists());
    h.shutdown();
    drop(h);
    drop(rt);
    let _ = std::fs::remove_dir_all(data);
}
