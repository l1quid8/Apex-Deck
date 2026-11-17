use apex_core::work_steps::{StepKind, StepStatus, WorkStep};
use apex_core::{
    Access, Approver, ConcurrentRoom, DeltaSink, Participant, ParticipantConfig, ParticipantError,
    Progress, ProgressSink, Reply, Room, RoomEvent, RoomOptions, TurnRequest,
};
use async_trait::async_trait;
use futures::executor::block_on;
use std::sync::{Arc, Mutex};

struct TwoReplies {
    config: ParticipantConfig,
    requests: Mutex<Vec<TurnRequest>>,
    replies: Mutex<Vec<&'static str>>,
    statuses: Mutex<Vec<Option<StepStatus>>>,
}

impl TwoReplies {
    fn new(replies: &[&'static str]) -> Self {
        let config = apex_core::testing::ScriptedParticipant::new("worker", &[])
            .config()
            .clone();
        Self {
            config,
            requests: Mutex::new(Vec::new()),
            replies: Mutex::new(replies.iter().copied().collect()),
            statuses: Mutex::new(vec![None; replies.len()]),
        }
    }

    fn with_statuses(replies: &[&'static str], statuses: &[Option<StepStatus>]) -> Self {
        let participant = Self::new(replies);
        *participant.statuses.lock().unwrap() = statuses.to_vec();
        participant
    }
}

#[async_trait]
impl Participant for TwoReplies {
    fn config(&self) -> &ParticipantConfig {
        &self.config
    }

    async fn respond(
        &self,
        request: TurnRequest,
        delta: DeltaSink<'_>,
    ) -> Result<Reply, ParticipantError> {
        self.requests.lock().unwrap().push(request);
        let text = self.replies.lock().unwrap().remove(0);
        delta(text);
        Ok(Reply::text(text))
    }

    async fn respond_with_progress(
        &self,
        request: TurnRequest,
        progress: ProgressSink<'_>,
    ) -> Result<Reply, ParticipantError> {
        let (text, index, status) = {
            self.requests.lock().unwrap().push(request);
            let index = self.requests.lock().unwrap().len();
            let text = self.replies.lock().unwrap().remove(0);
            let status = self.statuses.lock().unwrap().remove(0);
            (text, index, status)
        };
        if let Some(status) = status {
            progress(Progress::Work(&WorkStep {
                key: format!("command-{index}"),
                parent: None,
                kind: StepKind::Command,
                label: "run requested work".into(),
                folder: None,
                detail: if index == 1 {
                    "git status".into()
                } else {
                    "npm run build".into()
                },
                output: Some("completed".into()),
                status,
                exit_code: (status == StepStatus::Done).then_some(0),
                duration_ms: Some(1),
                output_cut: false,
            }));
        }
        progress(Progress::Text(text));
        Ok(Reply::text(text))
    }

    async fn respond_with_approvals(
        &self,
        request: TurnRequest,
        progress: ProgressSink<'_>,
        _: &dyn Approver,
    ) -> Result<Reply, ParticipantError> {
        self.respond_with_progress(request, progress).await
    }
}

fn transcript(room: &Room) -> Vec<String> {
    room.transcript().iter().map(|m| m.text.clone()).collect()
}

#[test]
fn direct_work_promise_gets_one_private_follow_up_and_only_the_result_is_added() {
    block_on(async {
        let worker = Arc::new(TwoReplies::new(&[
            "I inspected the working tree. I’ll run the build next.",
            "The build passed and the requested fix is complete.",
        ]));
        worker.statuses.lock().unwrap()[1] = Some(StepStatus::Done);
        let room = ConcurrentRoom::new(Room::new(vec![worker.clone()], RoomOptions::default()));
        let events = Mutex::new(Vec::new());
        let batch = room
            .begin_post("@worker fix the bug and run the build", None, &|e| {
                events.lock().unwrap().push(e)
            })
            .await
            .unwrap();
        room.run(batch, &|e| events.lock().unwrap().push(e)).await;

        let requests = worker.requests.lock().unwrap();
        assert_eq!(
            requests.len(),
            2,
            "the promised work should run once more automatically"
        );
        assert!(requests[0].room_reply);
        assert!(!requests[1].room_reply);
        assert_eq!(
            requests[1].turns[0], requests[0].turns[0],
            "the follow-up retains the original request"
        );
        assert!(
            requests[1]
                .turns
                .iter()
                .any(|turn| turn.content.contains("run the build")),
            "the request-local follow-up should identify the actual remaining step"
        );
        assert!(
            !requests[1]
                .turns
                .iter()
                .any(|turn| turn.role == apex_core::Role::User
                    && turn.content.contains("I inspected the working tree")),
            "the promise must not be injected as a fake user message"
        );
        drop(requests);
        let room_state = room.room();
        let state = room_state.lock().await;
        assert_eq!(
            transcript(&state),
            [
                "@worker fix the bug and run the build",
                "The build passed and the requested fix is complete."
            ]
        );
        assert!(matches!(
            state.transcript()[0].speaker,
            apex_core::Speaker::Human
        ));
        assert!(matches!(
            state.transcript()[1].speaker,
            apex_core::Speaker::Bot(_)
        ));
        let added: Vec<_> = events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|event| match event {
                RoomEvent::MessageAdded { message } => Some(message.text.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(
            added,
            [
                "@worker fix the bug and run the build",
                "The build passed and the requested fix is complete."
            ]
        );
        let event_list = events.lock().unwrap();
        let work: Vec<_> = event_list
            .iter()
            .filter_map(|event| match event {
                RoomEvent::WorkStep { step, .. } => Some(step.detail.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(
            work,
            ["npm run build"],
            "the continuation should report the actual requested work"
        );
    });
}

#[test]
fn direct_work_follow_up_has_a_hard_one_retry_cap() {
    block_on(async {
        let worker = Arc::new(TwoReplies::with_statuses(
            &[
                "I’ll run the build next.",
                "I’ll run the build now.",
                "third response must never happen",
            ],
            &[None, None],
        ));
        let room = ConcurrentRoom::new(Room::new(vec![worker.clone()], RoomOptions::default()));
        let batch = room
            .begin_post("@worker run the build", None, &|_| {})
            .await
            .unwrap();
        room.run(batch, &|_| {}).await;
        assert_eq!(worker.requests.lock().unwrap().len(), 2);
        let room_state = room.room();
        let state = room_state.lock().await;
        assert!(state.transcript().last().unwrap().text.contains("Still outstanding: run the build"));
    });
}

#[test]
fn planning_context_does_not_trigger_direct_work_continuation() {
    block_on(async {
        let worker = Arc::new(TwoReplies::new(&[
            "I’ll run the build next.",
            "should not run",
        ]));
        let core = Room::new(vec![worker.clone()], RoomOptions::default());
        core.plan_handle()
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let room = ConcurrentRoom::new(core);
        let batch = room
            .begin_post("@worker run the build", None, &|_| {})
            .await
            .unwrap();
        room.run(batch, &|_| {}).await;
        assert_eq!(worker.requests.lock().unwrap().len(), 1);
        assert!(worker.requests.lock().unwrap()[0].plan);
        assert_eq!(
            worker.requests.lock().unwrap()[0].access,
            Some(Access::Read)
        );
    });
}

#[test]
fn an_in_progress_command_does_not_get_replayed_automatically() {
    block_on(async {
        let worker = Arc::new(TwoReplies::with_statuses(
            &[
                "I started the build; it is still in progress.",
                "should not run",
            ],
            &[Some(StepStatus::Running)],
        ));
        let room = ConcurrentRoom::new(Room::new(vec![worker.clone()], RoomOptions::default()));
        let batch = room
            .begin_post("@worker run the build", None, &|_| {})
            .await
            .unwrap();
        room.run(batch, &|_| {}).await;
        assert_eq!(worker.requests.lock().unwrap().len(), 1);
    });
}

#[test]
fn stopping_the_user_turn_prevents_a_follow_up() {
    block_on(async {
        let worker = Arc::new(TwoReplies::new(&[
            "I’ll run the build next.",
            "should not run after Stop",
        ]));
        let room = ConcurrentRoom::new(Room::new(vec![worker.clone()], RoomOptions::default()));
        let batch = room
            .begin_post("@worker run the build", None, &|_| {})
            .await
            .unwrap();
        room.run(batch, &|event| {
            if matches!(event, RoomEvent::Delta { .. }) {
                room.stop(None);
            }
        })
        .await;
        assert_eq!(worker.requests.lock().unwrap().len(), 1);
    });
}

#[test]
fn client_post_dedup_does_not_replay_a_continuation() {
    block_on(async {
        let worker = Arc::new(TwoReplies::new(&[
            "I’ll run the build next.",
            "The build passed.",
            "duplicate request must not run",
        ]));
        worker.statuses.lock().unwrap()[1] = Some(StepStatus::Done);
        let room = ConcurrentRoom::new(Room::new(vec![worker.clone()], RoomOptions::default()));
        let batch = room
            .begin_client_post(
                "@worker run the build",
                None,
                "client-request-1".into(),
                false,
                None,
                &|_| Ok(()),
                &|_| {},
            )
            .await
            .unwrap()
            .0
            .unwrap();
        room.run(batch, &|_| {}).await;
        let (duplicate, _) = room
            .begin_client_post(
                "@worker run the build",
                None,
                "client-request-1".into(),
                false,
                None,
                &|_| Ok(()),
                &|_| {},
            )
            .await
            .unwrap();
        assert!(duplicate.is_none());
        assert_eq!(worker.requests.lock().unwrap().len(), 2);
    });
}

#[test]
fn ordinary_chat_and_how_to_questions_do_not_trigger_continuation() {
    for prompt in ["@worker hello", "@worker how do I run the build?"] {
        block_on(async {
            let worker = Arc::new(TwoReplies::new(&[
                "I’ll run the build next.",
                "should not run",
            ]));
            let room = ConcurrentRoom::new(Room::new(vec![worker.clone()], RoomOptions::default()));
            let batch = room.begin_post(prompt, None, &|_| {}).await.unwrap();
            room.run(batch, &|_| {}).await;
            assert_eq!(worker.requests.lock().unwrap().len(), 1, "prompt: {prompt}");
        });
    }
}
