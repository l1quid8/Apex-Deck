use apex_core::testing::ScriptedParticipant;
use apex_core::{
    ConcurrentRoom, DeltaSink, Participant, ParticipantConfig, ParticipantError, ParticipantId,
    Reply, Room, RoomEvent, RoomOptions, Speaker, TurnRequest,
};
use async_trait::async_trait;
use futures::{channel::oneshot, executor::block_on};
use std::sync::{Arc, Mutex};

struct Held {
    config: ParticipantConfig,
    release: Mutex<Option<oneshot::Receiver<()>>>,
    started: Option<Arc<std::sync::atomic::AtomicUsize>>,
    cleanup_error: bool,
}
#[async_trait]
impl Participant for Held {
    fn config(&self) -> &ParticipantConfig {
        &self.config
    }
    async fn respond(
        &self,
        request: TurnRequest,
        delta: DeltaSink<'_>,
    ) -> Result<Reply, ParticipantError> {
        if self.config.access != apex_core::Access::Read {
            assert_eq!(request.access, Some(self.config.access), "checkout contention must not silently downgrade writer access");
        }
        if let Some(started) = &self.started { started.fetch_add(1, std::sync::atomic::Ordering::SeqCst); }
        delta("unfinished");
        let release = self.release.lock().unwrap().take();
        if let Some(release) = release {
            let _ = release.await;
        }
        Ok(Reply::text("slow finished"))
    }
    async fn cancel_active_turn(&self) -> Result<bool, String> {
        if self.cleanup_error { Err("worker cleanup failed".into()) } else { Ok(false) }
    }
}
fn setup() -> (ConcurrentRoom, oneshot::Sender<()>) {
    let (tx, rx) = oneshot::channel();
    let slow = Arc::new(Held {
        config: ScriptedParticipant::new("null", &[]).config().clone(),
        release: Mutex::new(Some(rx)),
        started: None,
        cleanup_error: false,
    });
    let fast = Arc::new(ScriptedParticipant::new("jigga", &["fast finished"]));
    (
        ConcurrentRoom::new(Room::new(vec![slow, fast], RoomOptions::default())),
        tx,
    )
}

#[test]
fn checkout_gate_serializes_two_rooms_while_read_turns_continue() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    block_on(async {
        let gate = apex_core::CheckoutWriteGate::new();
        let started = Arc::new(AtomicUsize::new(0));
        let make_writer = |id: &str| {
            let (tx, rx) = oneshot::channel();
            let mut config = ScriptedParticipant::new(id, &[]).config().clone();
            config.access = apex_core::Access::Edits;
            let participant = Arc::new(Held { config, release: Mutex::new(Some(rx)), started: Some(started.clone()), cleanup_error: false });
            let runtime = ConcurrentRoom::new(Room::new(vec![participant], RoomOptions::default())).with_write_gate(gate.clone(), None);
            (runtime, tx)
        };
        let (first, release_first) = make_writer("first");
        let (second, release_second) = make_writer("second");
        let first_batch = first.begin_post("@first edit", None, &|_| {}).await.unwrap();
        let second_batch = second.begin_post("@second edit", None, &|_| {}).await.unwrap();
        let read_only = ConcurrentRoom::new(Room::new(vec![Arc::new(ScriptedParticipant::new("reader", &["read done"]))], RoomOptions::default())).with_write_gate(gate.clone(), None);
        let read_batch = read_only.begin_post("@reader inspect", None, &|_| {}).await.unwrap();
        let control = async {
            futures_timer::Delay::new(std::time::Duration::from_millis(30)).await;
            assert_eq!(started.load(Ordering::SeqCst), 1, "only one checkout writer may start");
            assert_eq!(gate.queued(), 1, "the second room must be queued");
            read_only.run(read_batch, &|_| {}).await;
            assert!(read_only.room().lock().await.transcript().iter().any(|m| m.text == "read done"));
            let _ = release_first.send(());
            let _ = release_second.send(());
        };
        futures::join!(first.run(first_batch, &|_| {}), second.run(second_batch, &|_| {}), control);
        assert_eq!(started.load(Ordering::SeqCst), 2);
    });
}

#[test]
fn a_plan_batch_retains_its_stable_task_owner_after_the_read_only_turn() {
    block_on(async {
        let gate = apex_core::CheckoutWriteGate::new();
        let mut config = ScriptedParticipant::new("planner", &["plan ready"]).config().clone();
        config.access = apex_core::Access::Edits;
        let participant = Arc::new(ScriptedParticipant::from_config(config));
        let runtime = ConcurrentRoom::new(Room::new(vec![participant], RoomOptions::default())).with_write_gate(gate.clone(), Some("task-42".into()));
        runtime.room().lock().await.plan_handle().store(true, std::sync::atomic::Ordering::SeqCst);
        let batch = runtime.begin_post("@planner plan", None, &|_| {}).await.unwrap();
        runtime.run(batch, &|_| {}).await;
        assert_eq!(gate.owner().as_deref(), Some("task-42"), "Plan ownership must survive batch completion");
        assert!(gate.restore_hold("other-task").is_err(), "another writer cannot promote through the Plan hold");
        gate.release("task-42");

        let read_only = Arc::new(ScriptedParticipant::new("reader", &["plan ready"]));
        let read_runtime = ConcurrentRoom::new(Room::new(vec![read_only], RoomOptions::default())).with_write_gate(gate.clone(), Some("read-task".into()));
        read_runtime.room().lock().await.plan_handle().store(true, std::sync::atomic::Ordering::SeqCst);
        let read_batch = read_runtime.begin_post("@reader plan", None, &|_| {}).await.unwrap();
        read_runtime.run(read_batch, &|_| {}).await;
        assert_eq!(gate.owner(), None, "a purely Read profile can plan without acquiring the checkout gate");
    });
}

#[test]
fn incomplete_worker_cleanup_keeps_manual_checkout_ownership_blocked() {
    block_on(async {
        let gate = apex_core::CheckoutWriteGate::new();
        let (release, rx) = oneshot::channel();
        let mut config = ScriptedParticipant::new("worker", &[]).config().clone();
        config.access = apex_core::Access::Edits;
        let participant = Arc::new(Held { config, release: Mutex::new(Some(rx)), started: None, cleanup_error: true });
        let runtime = ConcurrentRoom::new(Room::new(vec![participant], RoomOptions::default())).with_write_gate(gate.clone(), None);
        let batch = runtime.begin_post("@worker edit", None, &|_| {}).await.unwrap();
        let sink = |event| {
            if matches!(event, RoomEvent::TurnStarted { .. }) { runtime.stop(None); }
        };
        runtime.run(batch, &sink).await;
        let held = gate.owner().expect("failed cleanup must preserve checkout ownership");
        assert!(held.starts_with("manual-"));
        assert!(runtime.release_cleanup_hold(&ParticipantId::new("worker")));
        assert_eq!(gate.owner(), None, "verified recovery releases the transient manual owner");
        let _ = release.send(());
    });
}

#[test]
fn cleanup_recovery_never_releases_a_durable_task_owner() {
    block_on(async {
        let gate = apex_core::CheckoutWriteGate::new();
        let (_release, rx) = oneshot::channel();
        let mut config = ScriptedParticipant::new("worker", &[]).config().clone();
        config.access = apex_core::Access::Edits;
        let participant = Arc::new(Held { config, release: Mutex::new(Some(rx)), started: None, cleanup_error: true });
        let runtime = ConcurrentRoom::new(Room::new(vec![participant], RoomOptions::default())).with_write_gate(gate.clone(), Some("task-42".into()));
        let batch = runtime.begin_post("@worker edit", None, &|_| {}).await.unwrap();
        let sink = |event| { if matches!(event, RoomEvent::TurnStarted { .. }) { runtime.stop(None); } };
        runtime.run(batch, &sink).await;
        assert_eq!(gate.owner().as_deref(), Some("task-42"));
        assert!(runtime.release_cleanup_hold(&ParticipantId::new("worker")));
        assert_eq!(gate.owner().as_deref(), Some("task-42"), "the host task lifecycle owns durable reservation release");
        gate.release("task-42");
    });
}

#[test]
fn a_manual_write_batch_keeps_its_gate_across_bot_hops() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    block_on(async {
        let gate = apex_core::CheckoutWriteGate::new();
        let (release_second, rx_second) = oneshot::channel();
        let second_started = Arc::new(AtomicUsize::new(0));
        let mut first_config = ScriptedParticipant::new("first", &["@second continue"]).config().clone();
        first_config.access = apex_core::Access::Edits;
        let first = Arc::new(ScriptedParticipant::from_config(first_config));
        let mut second_config = ScriptedParticipant::new("second", &[]).config().clone();
        second_config.access = apex_core::Access::Edits;
        let second = Arc::new(Held { config: second_config, release: Mutex::new(Some(rx_second)), started: Some(second_started.clone()), cleanup_error: false });
        let runtime = ConcurrentRoom::new(Room::new(vec![first, second], RoomOptions::default())).with_write_gate(gate.clone(), None);
        let (release_other, rx_other) = oneshot::channel();
        let other_started = Arc::new(AtomicUsize::new(0));
        let mut other_config = ScriptedParticipant::new("other", &[]).config().clone();
        other_config.access = apex_core::Access::Edits;
        let other_participant = Arc::new(Held { config: other_config, release: Mutex::new(Some(rx_other)), started: Some(other_started.clone()), cleanup_error: false });
        let other = ConcurrentRoom::new(Room::new(vec![other_participant], RoomOptions::default())).with_write_gate(gate.clone(), None);
        let batch = runtime.begin_post("@first start", None, &|_| {}).await.unwrap();
        let other_batch = other.begin_post("@other start", None, &|_| {}).await.unwrap();
        let control = async {
            futures_timer::Delay::new(std::time::Duration::from_millis(30)).await;
            assert_eq!(second_started.load(Ordering::SeqCst), 1, "the next bot hop must start");
            assert_eq!(other_started.load(Ordering::SeqCst), 0, "another manual batch stays queued between hops");
            assert_eq!(gate.queued(), 1);
            let _ = release_second.send(());
            futures_timer::Delay::new(std::time::Duration::from_millis(30)).await;
            assert_eq!(other_started.load(Ordering::SeqCst), 1);
            let _ = release_other.send(());
        };
        futures::join!(runtime.run(batch, &|_| {}), other.run(other_batch, &|_| {}), control);
    });
}

#[test]
fn idle_model_finishes_before_another_models_turn_is_released() {
    block_on(async {
        let (runtime, release) = setup();
        let events = Mutex::new(Vec::new());
        let sink = |event| events.lock().unwrap().push(event);
        let slow = runtime
            .begin_post("@null build", None, &sink)
            .await
            .unwrap();
        let fast = runtime
            .begin_post("@jigga plan", None, &sink)
            .await
            .unwrap();
        let control = async {
            runtime.run(fast, &sink).await;
            assert!(events.lock().unwrap().iter().any(|e| matches!(e, RoomEvent::MessageAdded { message } if message.speaker == Speaker::Bot(ParticipantId::new("jigga")))));
            assert!(!events
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e, RoomEvent::Idle)));
            release.send(()).unwrap();
        };
        futures::join!(runtime.run(slow, &sink), control);
        let room = runtime.room();
        let room = room.lock().await;
        assert_eq!(room.transcript().len(), 4);
        for (index, message) in room.transcript().iter().enumerate() {
            assert_eq!(message.seq, index);
        }
    });
}
#[test]
fn stopping_null_preserves_jiggas_turn_and_partial_null_reply() {
    block_on(async {
        let (runtime, _release) = setup();
        let events = Mutex::new(Vec::new());
        let sink = |event| {
            if matches!(&event, RoomEvent::TurnStarted { id } if id == &ParticipantId::new("null"))
            {
                runtime.stop(Some(&ParticipantId::new("null")));
            }
            events.lock().unwrap().push(event);
        };
        let batch = runtime
            .begin_post("@everyone work", None, &sink)
            .await
            .unwrap();
        runtime.run(batch, &sink).await;
        let events = events.lock().unwrap();
        assert!(events.iter().any(
            |e| matches!(e, RoomEvent::MessageAdded { message } if message.text == "fast finished")
        ));
        assert!(events.iter().any(
            |e| matches!(e, RoomEvent::ParticipantIdle { id } if id == &ParticipantId::new("null"))
        ));
    });
}
#[test]
fn target_preview_does_not_change_sticky_recipient() {
    block_on(async {
        let (runtime, _) = setup();
        assert_eq!(
            runtime.targets("@jigga next").await,
            vec![ParticipantId::new("jigga")]
        );
        assert_eq!(
            runtime.targets("keep working").await,
            vec![ParticipantId::new("null")]
        );
    });
}

#[test]
fn stop_all_prevents_a_reply_from_launching_a_new_bot_hop() {
    block_on(async {
        let null = Arc::new(ScriptedParticipant::new("null", &["should not start"]));
        let jigga = Arc::new(ScriptedParticipant::new("jigga", &["@null next"]));
        let runtime =
            ConcurrentRoom::new(Room::new(vec![null.clone(), jigga], RoomOptions::default()));
        let sink = |event| {
            if matches!(event, RoomEvent::MessageAdded { message } if message.speaker == Speaker::Bot(ParticipantId::new("jigga")))
            {
                runtime.stop(None);
            }
        };
        let batch = runtime
            .begin_post("@jigga work", None, &sink)
            .await
            .unwrap();
        runtime.run(batch, &sink).await;
        assert!(
            null.requests().is_empty(),
            "stopped chain must not restart in a later hop"
        );
    });
}

#[test]
fn busy_participant_runs_again_after_release_without_reposting_human_text() {
    block_on(async {
        let (runtime, release) = setup();
        let events = Mutex::new(Vec::new());
        let sink = |event| events.lock().unwrap().push(event);
        let first = runtime
            .begin_post("@null first", None, &sink)
            .await
            .unwrap();
        let second = runtime
            .begin_post("@null second", None, &sink)
            .await
            .unwrap();
        let control = async {
            futures_timer::Delay::new(std::time::Duration::from_millis(5)).await;
            assert_eq!(
                events
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|e| matches!(e, RoomEvent::TurnStarted { .. }))
                    .count(),
                1
            );
            release.send(()).unwrap();
        };
        futures::join!(
            runtime.run(first, &sink),
            runtime.run(second, &sink),
            control
        );
        let events = events.lock().unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e, RoomEvent::TurnStarted { .. }))
                .count(),
            2
        );
        assert_eq!(events.iter().filter(|e| matches!(e, RoomEvent::MessageAdded { message } if message.speaker == Speaker::Human)).count(), 2);
    });
}

#[test]
fn targeted_stop_keeps_streamed_text_and_does_not_poison_the_next_turn() {
    block_on(async {
        let (runtime, _release) = setup();
        let events = Mutex::new(Vec::new());
        let sink = |event| {
            if matches!(&event, RoomEvent::Delta { id, .. } if id == &ParticipantId::new("null")) {
                runtime.stop(Some(&ParticipantId::new("null")));
            }
            events.lock().unwrap().push(event);
        };
        let batch = runtime
            .begin_post("@null first", None, &sink)
            .await
            .unwrap();
        runtime.run(batch, &sink).await;
        assert!(events.lock().unwrap().iter().any(|e| matches!(e, RoomEvent::MessageAdded { message } if message.text == "unfinished\n\n[Interrupted]")));
        let next = runtime
            .begin_turn(vec![ParticipantId::new("jigga")], None)
            .await
            .unwrap();
        runtime.run(next, &sink).await;
        assert!(events.lock().unwrap().iter().any(
            |e| matches!(e, RoomEvent::MessageAdded { message } if message.text == "fast finished")
        ));
    });
}

#[test]
fn targeted_approval_rejection_leaves_the_other_participant_waiting() {
    let desk = apex_core::ApprovalDesk::default();
    let (_, null) = desk.open_for(ParticipantId::new("null"));
    let (jigga_id, jigga) = desk.open_for(ParticipantId::new("jigga"));
    assert_eq!(desk.reject_for(&ParticipantId::new("null")), 1);
    assert_eq!(block_on(null).unwrap(), apex_core::Decision::Reject);
    assert_eq!(desk.waiting(), 1);
    desk.resolve(&jigga_id, apex_core::Decision::Approve);
    assert_eq!(block_on(jigga).unwrap(), apex_core::Decision::Approve);
}

#[test]
fn parallel_wave_requests_do_not_see_each_others_replies() {
    block_on(async {
        let null = Arc::new(ScriptedParticipant::new("null", &["first answer"]));
        let jigga = Arc::new(ScriptedParticipant::new("jigga", &["second answer"]));
        let runtime = ConcurrentRoom::new(Room::new(
            vec![null.clone(), jigga.clone()],
            RoomOptions::default(),
        ));
        let batch = runtime
            .begin_post("@everyone work", None, &|_| {})
            .await
            .unwrap();
        runtime.run(batch, &|_| {}).await;
        assert_eq!(null.requests()[0].turns.len(), 1);
        assert!(!jigga.requests()[0]
            .turns
            .iter()
            .any(|t| t.content.contains("first answer")));
    });
}

#[test]
fn round_robin_requests_see_the_prior_reply_and_hops_keep_their_limit() {
    block_on(async {
        let null = Arc::new(ScriptedParticipant::new(
            "null",
            &["@jigga next", "@jigga again"],
        ));
        let jigga = Arc::new(ScriptedParticipant::new(
            "jigga",
            &["@null next", "@null again"],
        ));
        let runtime = ConcurrentRoom::new(Room::new(
            vec![null.clone(), jigga.clone()],
            RoomOptions {
                policy: apex_core::TurnPolicy::RoundRobin,
                max_bot_hops: 1,
            },
        ));
        let events = Mutex::new(Vec::new());
        let sink = |event| events.lock().unwrap().push(event);
        let batch = runtime.begin_post("work", None, &sink).await.unwrap();
        runtime.run(batch, &sink).await;
        assert!(jigga.requests()[0]
            .turns
            .iter()
            .any(|t| t.content.contains("@jigga next")));
        assert!(events
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, RoomEvent::HopLimitReached { limit: 1, next } if next == &vec![ParticipantId::new("null"), ParticipantId::new("jigga")])));
        assert_eq!(null.requests().len(), 2);
        assert_eq!(jigga.requests().len(), 2);
    });
}

#[test]
fn accepted_turns_keep_fifo_order_even_when_tasks_are_polled_in_reverse() {
    block_on(async {
        let (runtime, release) = setup();
        let events = Mutex::new(Vec::new());
        let sink = |event| events.lock().unwrap().push(event);
        let first = runtime
            .begin_post("@null first", None, &sink)
            .await
            .unwrap();
        let second = runtime
            .begin_post("@null second", None, &sink)
            .await
            .unwrap();
        let control = async {
            futures_timer::Delay::new(std::time::Duration::from_millis(5)).await;
            assert!(
                !events
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|e| matches!(e, RoomEvent::TurnStarted { .. })),
                "second task must wait for the first accepted turn"
            );
            let unblock = async {
                futures_timer::Delay::new(std::time::Duration::from_millis(5)).await;
                release.send(()).unwrap();
            };
            futures::join!(runtime.run(first, &sink), unblock);
        };
        futures::join!(runtime.run(second, &sink), control);
    });
}

#[test]
fn second_writer_is_read_only_until_editor_finishes() {
    block_on(async {
        let (tx, rx) = oneshot::channel();
        let mut config = ScriptedParticipant::new("null", &[]).config().clone();
        config.access = apex_core::Access::Full;
        let slow = Arc::new(Held { config, release: Mutex::new(Some(rx)), started: None, cleanup_error: false });
        let mut config = ScriptedParticipant::new("jigga", &["done", "done"]).config().clone();
        config.access = apex_core::Access::Full;
        let fast = Arc::new(ScriptedParticipant::from_config(config));
        let runtime = ConcurrentRoom::new(Room::new(vec![slow, fast.clone()], RoomOptions::default()));
        let first = runtime.begin_post("@null build", None, &|_| {}).await.unwrap();
        let second = runtime.begin_post("@jigga plan", None, &|_| {}).await.unwrap();
        let control = async {
            runtime.run(second, &|_| {}).await;
            assert!(fast.requests()[0].system.contains("must not change any files"));
            tx.send(()).unwrap();
        };
        futures::join!(runtime.run(first, &|_| {}), control);
        let next = runtime.begin_turn(vec![ParticipantId::new("jigga")], None).await.unwrap();
        runtime.run(next, &|_| {}).await;
        assert!(fast.requests()[1].system.contains("may edit files and run commands"));
    });
}

#[test]
fn explicit_queued_recipients_survive_a_later_sticky_mention() {
    block_on(async {
        let (runtime, _) = setup();
        let initial = runtime.begin_post("@null first", None, &|_| {}).await.unwrap();
        let recipients = runtime.targets("keep building").await;
        let other = runtime.begin_post("@jigga plan", None, &|_| {}).await.unwrap();
        assert!(runtime.begin_post("keep building", Some(recipients), &|_| {}).await.is_ok());
        drop(initial); drop(other);
    });
}

#[test]
fn a_turn_with_a_zero_budget_buys_exactly_one_reply() {
    block_on(async {
        let null = Arc::new(ScriptedParticipant::new("null", &["@jigga over to you"]));
        let jigga = Arc::new(ScriptedParticipant::new("jigga", &["never said"]));
        let runtime = ConcurrentRoom::new(Room::new(vec![null.clone(), jigga.clone()], RoomOptions::default()));
        let events = Mutex::new(Vec::new());
        let sink = |event| events.lock().unwrap().push(event);
        let batch = runtime.begin_turn(vec![ParticipantId::new("null")], Some(0)).await.unwrap();
        runtime.run(batch, &sink).await;
        assert_eq!(null.requests().len(), 1);
        assert!(jigga.requests().is_empty(), "a budget of 0 buys one reply, even though the room allows 3 rounds");
        let events = events.lock().unwrap();
        assert!(events.contains(&RoomEvent::HopLimitReached { limit: 0, next: vec![ParticipantId::new("jigga")] }));
        assert!(!events.iter().any(|e| matches!(e, RoomEvent::MessageAdded { message } if message.speaker == Speaker::Human)), "nothing is posted");
    });
}

#[test]
fn bots_let_answer_together_go_one_after_another() {
    block_on(async {
        let null = Arc::new(ScriptedParticipant::new("null", &["first"]));
        let jigga = Arc::new(ScriptedParticipant::new("jigga", &["second"]));
        let runtime = ConcurrentRoom::new(Room::new(vec![null.clone(), jigga.clone()], RoomOptions::default()));
        let batch = runtime.begin_turn(vec![ParticipantId::new("null"), ParticipantId::new("jigga")], Some(0)).await.unwrap();
        runtime.run(batch, &|_| {}).await;
        assert!(jigga.requests()[0].turns.iter().any(|t| t.content.contains("first")), "Jigga saw Null's reply");
    });
}

#[test]
fn a_turn_for_someone_who_left_is_refused() {
    block_on(async {
        let (runtime, _) = setup();
        let refused = runtime.begin_turn(vec![ParticipantId::new("ghost")], None).await;
        assert_eq!(refused.err(), Some("that participant is no longer in this room".to_string()));
    });
}

#[test]
fn without_a_budget_a_turn_keeps_the_rooms_round_limit() {
    block_on(async {
        let null = Arc::new(ScriptedParticipant::new("null", &["@jigga one"]));
        let jigga = Arc::new(ScriptedParticipant::new("jigga", &["@null two"]));
        let runtime = ConcurrentRoom::new(Room::new(
            vec![null.clone(), jigga.clone()],
            RoomOptions { policy: apex_core::TurnPolicy::Mention, max_bot_hops: 1 },
        ));
        let events = Mutex::new(Vec::new());
        let sink = |event| events.lock().unwrap().push(event);
        let batch = runtime.begin_turn(vec![ParticipantId::new("null")], None).await.unwrap();
        runtime.run(batch, &sink).await;
        assert_eq!(jigga.requests().len(), 1);
        assert!(events.lock().unwrap().contains(&RoomEvent::HopLimitReached { limit: 1, next: vec![ParticipantId::new("null")] }));
    });
}

#[test]
fn turn_settings_change_during_reply_preserves_current_turn_and_next_context() {
    block_on(async {
        let (release, rx) = oneshot::channel();
        let mut config = ScriptedParticipant::new("null", &[]).config().clone();
        config.backend = apex_core::Backend::Agent { tool: apex_core::AgentTool::Codex, model: Some("old-model".into()) };
        config.effort = Some("low".into());
        let original = config.clone();
        let runtime = ConcurrentRoom::new(Room::new(vec![Arc::new(Held { config, release: Mutex::new(Some(rx)), started: None, cleanup_error: false })], RoomOptions::default()));
        let events = Mutex::new(Vec::new());
        let sink = |event| events.lock().unwrap().push(event);
        let batch = runtime.begin_post("@null remember this", None, &sink).await.unwrap();
        let control = async {
            let next = runtime.begin_post("@null next", None, &sink).await.unwrap();
            let mut config = original.clone();
            config.backend = apex_core::Backend::Agent { tool: apex_core::AgentTool::Codex, model: Some("new-model".into()) };
            config.effort = Some("high".into());
            let replacement = Arc::new(SettingsReply { config });
            let room = runtime.room();
            {
                let mut room = room.lock().await;
                assert!(room.replace_turn_settings(replacement));
                assert_eq!(room.transcript()[0].text, "@null remember this");
                assert_eq!(room.configs()[0].effort.as_deref(), Some("high"));
            }
            release.send(()).unwrap();
            runtime.run(next, &sink).await;
        };
        futures::join!(runtime.run(batch, &sink), control);
        let room = runtime.room();
        let room = room.lock().await;
        assert_eq!(room.transcript()[2].text, "slow finished");
        assert_eq!(room.transcript()[3].text, "new settings replied");
    });
}

struct SettingsReply { config: ParticipantConfig }
#[async_trait]
impl Participant for SettingsReply {
    fn config(&self) -> &ParticipantConfig { &self.config }
    async fn respond(&self, request: TurnRequest, _: DeltaSink<'_>) -> Result<Reply, ParticipantError> {
        assert!(format!("{request:?}").contains("remember this"));
        assert_eq!(self.config.effort.as_deref(), Some("high"));
        assert!(matches!(&self.config.backend, apex_core::Backend::Agent { model: Some(model), .. } if model == "new-model"));
        Ok(Reply::text("new settings replied"))
    }
}

#[test]
fn active_settings_cannot_change_access_identity_or_provider() {
    block_on(async {
        let mut config = ScriptedParticipant::new("null", &[]).config().clone();
        config.backend = apex_core::Backend::Agent { tool: apex_core::AgentTool::Codex, model: Some("old-model".into()) };
        let runtime = ConcurrentRoom::new(Room::new(vec![Arc::new(SettingsReply { config: config.clone() })], RoomOptions::default()));
        let room = runtime.room();
        let mut room = room.lock().await;
        let mut changed = config.clone();
        changed.access = apex_core::Access::Full;
        assert!(!room.replace_turn_settings(Arc::new(SettingsReply { config: changed })));
        let mut changed = config.clone();
        changed.display_name = "Renamed".into();
        assert!(!room.replace_turn_settings(Arc::new(SettingsReply { config: changed })));
        let mut changed = config.clone();
        changed.backend = apex_core::Backend::Agent { tool: apex_core::AgentTool::ClaudeCode, model: Some("new-model".into()) };
        assert!(!room.replace_turn_settings(Arc::new(SettingsReply { config: changed })));
        assert_eq!(room.configs()[0], config);
    });
}

struct HeldAdvice {
    release: Mutex<Option<oneshot::Receiver<()>>>,
}
impl apex_core::decision::TurnAdvisor for HeldAdvice {
    fn advise<'a>(&'a self, config: &'a ParticipantConfig, _: Vec<apex_core::Message>, _: Vec<ParticipantConfig>) -> futures::future::BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            if !config.auto_effort { return None; }
            let release = self.release.lock().unwrap().take();
            if let Some(release) = release { let _ = release.await; }
            Some("low".into())
        })
    }
}

#[test]
fn fixed_bot_starts_and_can_edit_while_auto_is_waiting() {
    block_on(async {
        let base = ScriptedParticipant::new("auto", &["auto reply"]);
        let mut config = base.config().clone();
        config.auto_effort = true;
        config.effort = Some("xhigh".into());
        config.access = apex_core::Access::Full;
        let auto = Arc::new(ScriptedParticipant::from_config(config));
        let base = ScriptedParticipant::new("fixed", &["fixed reply"]);
        let mut config = base.config().clone();
        config.access = apex_core::Access::Full;
        let fixed = Arc::new(ScriptedParticipant::from_config(config));
        let room = ConcurrentRoom::new(Room::new(vec![auto.clone(), fixed.clone()], RoomOptions::default()));
        let (release, ready) = oneshot::channel();
        let advisor = Arc::new(HeldAdvice { release: Mutex::new(Some(ready)) });
        let batch = room.begin_post("@all do the work", None, &|_| {}).await.unwrap().with_advisor(advisor);
        let (started, fixed_started) = oneshot::channel();
        let started = Mutex::new(Some(started));
        let sink = |event| {
            if matches!(event, RoomEvent::TurnStarted { id } if id.as_str() == "fixed") {
                if let Some(started) = started.lock().unwrap().take() { let _ = started.send(()); }
            }
        };
        let run = room.run(batch, &sink);
        let check = async {
            fixed_started.await.unwrap();
            assert!(auto.requests().is_empty());
            assert_eq!(fixed.requests()[0].access, Some(apex_core::Access::Full));
            release.send(()).unwrap();
        };
        futures::join!(run, check);
        assert_eq!(auto.requests()[0].effort_override.as_deref(), Some("low"));
        assert_eq!(auto.config().effort.as_deref(), Some("xhigh"));
        assert_eq!(fixed.requests()[0].effort_override, None);
    });
}

#[test]
fn stop_during_auto_wait_never_starts_the_old_reply() {
    block_on(async {
        let base = ScriptedParticipant::new("auto", &["must not run"]);
        let mut config = base.config().clone();
        config.auto_effort = true;
        let auto = Arc::new(ScriptedParticipant::from_config(config));
        let room = ConcurrentRoom::new(Room::new(vec![auto.clone()], RoomOptions::default()));
        let (release, ready) = oneshot::channel();
        let advisor = Arc::new(HeldAdvice { release: Mutex::new(Some(ready)) });
        let batch = room.begin_post("@auto work", None, &|_| {}).await.unwrap().with_advisor(advisor);
        let mut run = Box::pin(room.run(batch, &|_| {}));
        use futures::FutureExt;
        assert!(run.as_mut().now_or_never().is_none());
        room.stop(None);
        release.send(()).unwrap();
        run.await;
        assert!(auto.requests().is_empty());
        assert!(!room.busy());
    });
}
