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
}
#[async_trait]
impl Participant for Held {
    fn config(&self) -> &ParticipantConfig {
        &self.config
    }
    async fn respond(
        &self,
        _: TurnRequest,
        delta: DeltaSink<'_>,
    ) -> Result<Reply, ParticipantError> {
        delta("unfinished");
        let release = self.release.lock().unwrap().take();
        if let Some(release) = release {
            let _ = release.await;
        }
        Ok(Reply::text("slow finished"))
    }
}
fn setup() -> (ConcurrentRoom, oneshot::Sender<()>) {
    let (tx, rx) = oneshot::channel();
    let slow = Arc::new(Held {
        config: ScriptedParticipant::new("null", &[]).config().clone(),
        release: Mutex::new(Some(rx)),
    });
    let fast = Arc::new(ScriptedParticipant::new("jigga", &["fast finished"]));
    (
        ConcurrentRoom::new(Room::new(vec![slow, fast], RoomOptions::default())),
        tx,
    )
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
        let slow = Arc::new(Held { config, release: Mutex::new(Some(rx)) });
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
