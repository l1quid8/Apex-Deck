use apex_core::work_steps::{TodoItem, TodoStatus};
use apex_core::{testing::ScriptedParticipant, *};
use std::sync::{Arc, Mutex};

struct Bot {
    config: ParticipantConfig,
    requests: Mutex<Vec<TurnRequest>>,
}
impl Bot {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            config: ScriptedParticipant::new("bot", &[]).config().clone(),
            requests: Mutex::new(vec![]),
        })
    }
}
#[async_trait::async_trait]
impl Participant for Bot {
    fn config(&self) -> &ParticipantConfig {
        &self.config
    }
    async fn respond(&self, _: TurnRequest, _: DeltaSink<'_>) -> Result<Reply, ParticipantError> {
        unreachable!()
    }
    async fn respond_with_progress(
        &self,
        request: TurnRequest,
        sink: ProgressSink<'_>,
    ) -> Result<Reply, ParticipantError> {
        let mut requests = self.requests.lock().unwrap();
        requests.push(request);
        if requests.len() == 1 {
            sink(Progress::Todo(&[TodoItem {
                text: "Distinctive original wording".into(),
                status: TodoStatus::InProgress,
            }]));
        }
        Ok(Reply::text("Ready"))
    }
}
#[test]
fn checklist_context_survives_turns_and_restart_but_clear_removes_it() {
    futures::executor::block_on(async {
        let bot = Bot::new();
        let mut room = Room::new(vec![bot.clone()], RoomOptions::default());
        room.post_human("create", &|_| {}).await;
        let other = Arc::new(ScriptedParticipant::new("other", &["Ready"]));
        room.add_participant(other.clone());
        room.post_human("@other check", &|_| {}).await;
        assert!(!other.requests()[0]
            .system
            .contains("Distinctive original wording"));
        room.post_human("@bot update", &|_| {}).await;
        assert!(bot.requests.lock().unwrap()[1]
            .system
            .contains("Distinctive original wording"));
        assert!(room.snapshot().fork(0).checklists.is_empty());
        let mut rewound = Room::restore(vec![bot.clone()], room.snapshot());
        rewound.rewind(0);
        assert!(rewound.snapshot().checklists.is_empty());
        let saved = serde_json::from_slice(&serde_json::to_vec(&room.snapshot()).unwrap()).unwrap();
        let mut restored = Room::restore(vec![bot.clone()], saved);
        restored.post_human("update again", &|_| {}).await;
        assert!(bot.requests.lock().unwrap()[2]
            .system
            .contains("Distinctive original wording"));
        restored.clear();
        restored.post_human("new task", &|_| {}).await;
        assert!(!bot.requests.lock().unwrap()[3]
            .system
            .contains("Distinctive original wording"));
    });
}
#[test]
fn concurrent_turns_restore_checklist_context() {
    futures::executor::block_on(async {
        let bot = Bot::new();
        let runtime = ConcurrentRoom::new(Room::new(vec![bot.clone()], RoomOptions::default()));
        for text in ["create", "update"] {
            let batch = runtime.begin_post(text, None, &|_| {}).await.unwrap();
            runtime.run(batch, &|_| {}).await;
        }
        assert!(bot.requests.lock().unwrap()[1]
            .system
            .contains("Distinctive original wording"));
    });
}
