use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use apex_core::testing::ScriptedParticipant;
use apex_core::{
    Access, ActionKind, AgentTool, Approver, Backend, ContextUse, Decision, DeltaSink, FileChange, Participant, ParticipantConfig,
    ParticipantError, ParticipantId, PlanUsage, PlanWindow, Progress, ProgressSink, ProposedAction, Reply, Role, Room, RoomEvent,
    RoomOptions, Speaker, TurnPolicy, TurnRequest,
};
use futures::executor::block_on;

fn bot(id: &str, lines: &[&str]) -> Arc<ScriptedParticipant> {
    Arc::new(ScriptedParticipant::new(id, lines))
}

fn room(bots: &[&Arc<ScriptedParticipant>], policy: TurnPolicy, max_bot_hops: usize) -> Room {
    let roster: Vec<Arc<dyn Participant>> =
        bots.iter().map(|b| Arc::clone(*b) as Arc<dyn Participant>).collect();
    Room::new(roster, RoomOptions { policy, max_bot_hops })
}

fn say(room: &mut Room, text: &str) -> Vec<RoomEvent> {
    let events = Mutex::new(Vec::new());
    block_on(room.post_human(text, &|e| events.lock().unwrap().push(e)));
    events.into_inner().unwrap()
}

/// The transcript as "speaker: text" lines.
fn lines(room: &Room) -> Vec<String> {
    room.transcript()
        .iter()
        .map(|m| match &m.speaker {
            Speaker::Human => format!("human: {}", m.text),
            Speaker::Bot(id) => format!("{id}: {}", m.text),
        })
        .collect()
}

#[test]
fn restart_keeps_history_and_last_addressed_participant_without_running_a_turn() {
    let first = bot("first", &["wrong bot"]);
    let second = bot("second", &["original reply"]);
    let mut original = room(&[&first, &second], TurnPolicy::Mention, 2);
    say(&mut original, "@second remember this");

    let new_first = bot("first", &["wrong after restart"]);
    let new_second = bot("second", &["continued reply"]);
    let saved = serde_json::to_string(&original.snapshot()).unwrap();
    let snapshot = serde_json::from_str(&saved).unwrap();
    let mut restored = Room::restore(vec![new_first.clone(), new_second.clone()], snapshot);
    assert_eq!(lines(&restored), ["human: @second remember this", "second: original reply"]);
    assert!(new_first.requests().is_empty());
    assert!(new_second.requests().is_empty());
    say(&mut restored, "continue");
    assert_eq!(lines(&restored), ["human: @second remember this", "second: original reply", "human: continue", "second: continued reply"]);
    assert_eq!(new_second.requests()[0].turns.len(), 3);
    assert_eq!(restored.transcript()[3].seq, 3);
}

#[test]
fn a_mention_routes_to_only_that_bot() {
    let opus = bot("opus", &["opus answer"]);
    let grok = bot("grok", &["grok answer"]);
    let mut room = room(&[&opus, &grok], TurnPolicy::Mention, 3);

    say(&mut room, "@grok what do you think?");

    assert_eq!(lines(&room), ["human: @grok what do you think?", "grok: grok answer"]);
    assert!(opus.requests().is_empty());
}

#[test]
fn without_a_mention_the_first_bot_answers_and_then_it_sticks() {
    let opus = bot("opus", &["one", "four"]);
    let grok = bot("grok", &["two", "three"]);
    let mut room = room(&[&opus, &grok], TurnPolicy::Mention, 3);

    say(&mut room, "hello");
    say(&mut room, "@grok your turn");
    say(&mut room, "and again");

    assert_eq!(
        lines(&room),
        [
            "human: hello",
            "opus: one",
            "human: @grok your turn",
            "grok: two",
            "human: and again",
            "grok: three",
        ]
    );
}

#[test]
fn everyone_policy_answers_in_parallel_without_seeing_each_other() {
    let opus = bot("opus", &["opus answer"]);
    let grok = bot("grok", &["grok answer"]);
    let mut room = room(&[&opus, &grok], TurnPolicy::Everyone, 3);

    say(&mut room, "compare notes");

    assert_eq!(lines(&room), ["human: compare notes", "opus: opus answer", "grok: grok answer"]);
    let grok_saw = &grok.requests()[0].turns;
    assert_eq!(grok_saw.len(), 1);
    assert_eq!(grok_saw[0].content, "[Human]: compare notes");
}

#[test]
fn round_robin_lets_each_bot_see_the_answers_before_it() {
    let opus = bot("opus", &["opus answer"]);
    let grok = bot("grok", &["grok answer"]);
    let mut room = room(&[&opus, &grok], TurnPolicy::RoundRobin, 3);

    say(&mut room, "debate");

    let grok_saw = &grok.requests()[0].turns;
    assert_eq!(grok_saw.len(), 1);
    assert_eq!(grok_saw[0].role, Role::User);
    assert_eq!(grok_saw[0].content, "[Human]: debate\n\n[opus]: opus answer");
}

#[test]
fn at_all_overrides_the_mention_policy() {
    let opus = bot("opus", &["a"]);
    let grok = bot("grok", &["b"]);
    let mut room = room(&[&opus, &grok], TurnPolicy::Mention, 3);

    say(&mut room, "@all sound off");

    assert_eq!(lines(&room), ["human: @all sound off", "opus: a", "grok: b"]);
}

#[test]
fn a_bot_can_bring_another_bot_in() {
    let opus = bot("opus", &["@grok can you check this?"]);
    let grok = bot("grok", &["looks right"]);
    let mut room = room(&[&opus, &grok], TurnPolicy::Mention, 3);

    say(&mut room, "@opus review the plan");

    assert_eq!(
        lines(&room),
        [
            "human: @opus review the plan",
            "opus: @grok can you check this?",
            "grok: looks right",
        ]
    );
}

#[test]
fn bots_that_keep_pinging_each_other_are_cut_off() {
    let opus = bot("opus", &["@grok 1", "@grok 3", "@grok 5", "@grok 7"]);
    let grok = bot("grok", &["@opus 2", "@opus 4", "@opus 6", "@opus 8"]);
    let mut room = room(&[&opus, &grok], TurnPolicy::Mention, 2);

    let events = say(&mut room, "@opus go");

    // One answer to the human, then two rounds of bots answering bots.
    assert_eq!(lines(&room), ["human: @opus go", "opus: @grok 1", "grok: @opus 2", "opus: @grok 3"]);
    assert!(events.contains(&RoomEvent::HopLimitReached { limit: 2 }));
    assert_eq!(events.last(), Some(&RoomEvent::Idle));
}

#[test]
fn zero_hops_means_bots_never_trigger_each_other() {
    let opus = bot("opus", &["@grok over to you"]);
    let grok = bot("grok", &["never said"]);
    let mut room = room(&[&opus, &grok], TurnPolicy::Mention, 0);

    let events = say(&mut room, "@opus go");

    assert_eq!(lines(&room), ["human: @opus go", "opus: @grok over to you"]);
    assert!(events.contains(&RoomEvent::HopLimitReached { limit: 0 }));
    assert!(grok.requests().is_empty());
}

#[test]
fn a_bot_mentioning_itself_does_not_trigger_itself() {
    let opus = bot("opus", &["as @opus I agree", "should not be said"]);
    let mut room = room(&[&opus], TurnPolicy::Mention, 3);

    say(&mut room, "thoughts?");

    assert_eq!(lines(&room), ["human: thoughts?", "opus: as @opus I agree"]);
}

#[test]
fn a_pass_is_reported_but_not_added_to_the_transcript() {
    let opus = bot("opus", &["[pass]"]);
    let grok = bot("grok", &["I have something"]);
    let mut room = room(&[&opus, &grok], TurnPolicy::Everyone, 3);

    let events = say(&mut room, "anything to add?");

    assert_eq!(lines(&room), ["human: anything to add?", "grok: I have something"]);
    assert!(events.contains(&RoomEvent::Passed { id: ParticipantId::new("opus") }));
}

#[test]
fn a_failing_bot_is_reported_and_the_others_still_answer() {
    let opus = bot("opus", &["!fail rate limited"]);
    let grok = bot("grok", &["still here"]);
    let mut room = room(&[&opus, &grok], TurnPolicy::Everyone, 3);

    let events = say(&mut room, "hello");

    assert_eq!(lines(&room), ["human: hello", "grok: still here"]);
    assert!(events.contains(&RoomEvent::Failed {
        id: ParticipantId::new("opus"),
        error: "rate limited".into()
    }));
}

#[test]
fn replies_are_streamed_as_deltas_that_add_up_to_the_message() {
    let opus = bot("opus", &["three word reply"]);
    let mut room = room(&[&opus], TurnPolicy::Mention, 3);

    let events = say(&mut room, "hi");

    let streamed: String = events
        .iter()
        .filter_map(|e| match e {
            RoomEvent::Delta { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(streamed, "three word reply");
    assert_eq!(events[1], RoomEvent::TurnStarted { id: ParticipantId::new("opus") });
}

#[test]
fn unseen_holds_only_what_others_said_since_the_bots_last_turn() {
    let opus = bot("opus", &["first", "second"]);
    let grok = bot("grok", &["grok speaks"]);
    let mut room = room(&[&opus, &grok], TurnPolicy::Mention, 3);

    say(&mut room, "@opus start");
    say(&mut room, "@grok your go");
    say(&mut room, "@opus back to you");

    let requests = opus.requests();
    let unseen: Vec<&str> = requests[1].unseen.iter().map(|m| m.text.as_str()).collect();
    assert_eq!(unseen, ["@grok your go", "grok speaks", "@opus back to you"]);
    let first: Vec<&str> = requests[0].unseen.iter().map(|m| m.text.as_str()).collect();
    assert_eq!(first, ["@opus start"]);
}

#[test]
fn stopping_ends_the_round_and_discards_the_reply_in_flight() {
    let opus = bot("opus", &["opus answer"]);
    let grok = bot("grok", &["never added"]);
    let mut room = room(&[&opus, &grok], TurnPolicy::RoundRobin, 3);
    let stop = room.stop_handle();

    let events = Mutex::new(Vec::new());
    block_on(room.post_human("go", &|e| {
        // Press stop as soon as the second bot starts writing.
        if e == (RoomEvent::TurnStarted { id: ParticipantId::new("grok") }) {
            stop.store(true, Ordering::SeqCst);
        }
        events.lock().unwrap().push(e);
    }));
    let events = events.into_inner().unwrap();

    assert_eq!(lines(&room), ["human: go", "opus: opus answer"]);
    assert!(events.contains(&RoomEvent::Stopped));
}

#[test]
fn a_removed_bot_can_no_longer_be_addressed() {
    let opus = bot("opus", &["opus answer"]);
    let grok = bot("grok", &["never said"]);
    let mut room = room(&[&opus, &grok], TurnPolicy::Mention, 3);

    assert!(room.remove_participant(&ParticipantId::new("grok")));
    say(&mut room, "@grok are you there?");

    // The mention matches nobody, so the policy picks the first bot.
    assert_eq!(lines(&room), ["human: @grok are you there?", "opus: opus answer"]);
}

#[test]
fn the_same_id_cannot_join_twice() {
    let opus = bot("opus", &[]);
    let mut room = room(&[&opus], TurnPolicy::Mention, 3);
    let twin = bot("opus", &[]);
    assert!(!room.add_participant(twin as Arc<dyn Participant>));
    assert_eq!(room.configs().len(), 1);
}

#[test]
fn replacing_a_participant_keeps_its_place_and_uses_the_new_version() {
    let opus = bot("opus", &["old opus"]);
    let grok = bot("grok", &["grok"]);
    let mut room = room(&[&opus, &grok], TurnPolicy::Everyone, 0);

    let newer = bot("opus", &["new opus"]);
    assert!(room.replace_participant(Arc::clone(&newer) as Arc<dyn Participant>));
    let stranger = bot("nobody", &[]);
    assert!(!room.replace_participant(stranger as Arc<dyn Participant>));

    say(&mut room, "hello");

    assert_eq!(lines(&room), ["human: hello", "opus: new opus", "grok: grok"]);
    assert!(opus.requests().is_empty());
    assert_eq!(room.configs().len(), 2);
}

/// A participant that reports what it is doing and what the turn used,
/// the way a coding agent in its event mode does.
struct WorkingBot(ParticipantConfig);

#[async_trait::async_trait]
impl Participant for WorkingBot {
    fn config(&self) -> &ParticipantConfig {
        &self.0
    }

    async fn respond(&self, _: TurnRequest, on_delta: DeltaSink<'_>) -> Result<Reply, ParticipantError> {
        on_delta("plain");
        Ok(Reply::text("plain"))
    }

    async fn respond_with_progress(
        &self,
        _: TurnRequest,
        on_progress: ProgressSink<'_>,
    ) -> Result<Reply, ParticipantError> {
        on_progress(Progress::Activity("Reading notes.txt"));
        on_progress(Progress::Text("Done."));
        on_progress(Progress::Context(ContextUse { used_tokens: 36_000, window_tokens: 200_000 }));
        on_progress(Progress::Plan(&PlanUsage {
            provider: AgentTool::Codex,
            windows: vec![PlanWindow { name: "primary".into(), used_percent: 15, window_minutes: Some(10_080), resets_at: None }],
            partial: true,
        }));
        Ok(Reply { text: "Done.".into(), input_tokens: Some(120), output_tokens: Some(7) })
    }
}

#[test]
fn activity_and_token_use_are_reported_alongside_the_reply() {
    let id = ParticipantId::new("worker");
    let config = ParticipantConfig {
        id: id.clone(),
        display_name: "worker".into(),
        backend: Backend::Scripted { lines: vec![] },
        persona: String::new(),
        access: Access::Read,
        effort: None,
        appearance: None,
    };
    let quiet = bot("quiet", &["hello"]);
    let roster: Vec<Arc<dyn Participant>> = vec![Arc::new(WorkingBot(config)), quiet.clone()];
    let mut room = Room::new(roster, RoomOptions { policy: TurnPolicy::RoundRobin, max_bot_hops: 0 });
    let events = say(&mut room, "go");

    let about_worker: Vec<&RoomEvent> = events
        .iter()
        .filter(|e| match e {
            RoomEvent::TurnStarted { id: who }
            | RoomEvent::Activity { id: who, .. }
            | RoomEvent::Delta { id: who, .. }
            | RoomEvent::ContextUsage { id: who, .. }
            | RoomEvent::Usage { id: who, .. } => who == &id,
            RoomEvent::PlanUsage { .. } => true,
            RoomEvent::MessageAdded { message } => message.speaker == Speaker::Bot(id.clone()),
            _ => false,
        })
        .collect();
    assert_eq!(
        about_worker,
        [
            &RoomEvent::TurnStarted { id: id.clone() },
            &RoomEvent::Activity { id: id.clone(), text: "Reading notes.txt".into() },
            &RoomEvent::Delta { id: id.clone(), text: "Done.".into() },
            &RoomEvent::ContextUsage { id: id.clone(), used_tokens: 36_000, window_tokens: 200_000 },
            // The plan is the provider's, so it is not tied to the bot.
            &RoomEvent::PlanUsage {
                provider: AgentTool::Codex,
                windows: vec![PlanWindow { name: "primary".into(), used_percent: 15, window_minutes: Some(10_080), resets_at: None }],
                partial: true,
            },
            &RoomEvent::Usage { id: id.clone(), input_tokens: Some(120), output_tokens: Some(7) },
            &RoomEvent::MessageAdded {
                message: apex_core::Message { seq: 1, speaker: Speaker::Bot(id.clone()), text: "Done.".into() }
            },
        ]
    );
    // A participant that reports no token counts produces no usage event.
    assert!(!events.iter().any(|e| matches!(e, RoomEvent::Usage { id: who, .. } if who.as_str() == "quiet")));
    assert_eq!(lines(&room), ["human: go", "worker: Done.", "quiet: hello"]);
}

#[test]
fn clearing_forgets_the_conversation_but_keeps_the_participants() {
    let opus = bot("opus", &["one", "two"]);
    let grok = bot("grok", &["grok answer"]);
    let mut room = room(&[&opus, &grok], TurnPolicy::Mention, 3);
    say(&mut room, "@grok remember the password is swordfish");

    room.clear();
    assert!(room.transcript().is_empty());
    assert_eq!(room.configs().len(), 2);

    // Who was addressed last is forgotten too, so the first bot answers.
    say(&mut room, "what is the password?");
    assert_eq!(lines(&room), ["human: what is the password?", "opus: one"]);
    assert_eq!(room.transcript()[0].seq, 0);
    assert_eq!(opus.requests()[0].turns.len(), 1);
    assert_eq!(opus.requests()[0].unseen.len(), 1);
}

fn compact(room: &mut Room, summarizer: &ScriptedParticipant) -> (Result<(), String>, Vec<RoomEvent>) {
    let events = Mutex::new(Vec::new());
    let result = block_on(room.compact(summarizer, &|e| events.lock().unwrap().push(e)));
    (result, events.into_inner().unwrap())
}

#[test]
fn compacting_shows_the_models_a_summary_instead_of_the_older_messages() {
    let opus = bot("opus", &["sqlite it is", "noted"]);
    let mut room = room(&[&opus], TurnPolicy::Mention, 3);
    say(&mut room, "which database?");

    let writer = ScriptedParticipant::new("opus", &["Chose sqlite."]);
    let (result, events) = compact(&mut room, &writer);
    assert_eq!(result, Ok(()));
    assert!(events.contains(&RoomEvent::Compacted { id: ParticipantId::new("opus"), summary: "Chose sqlite.".into(), upto: 2 }));
    // The summarizer is shown every message, labelled, and then the ask.
    let asked = &writer.requests()[0];
    assert!(asked.turns[0].content.contains("[Human]: which database?"));
    assert!(asked.turns[0].content.contains("[opus]: sqlite it is"));
    assert!(asked.turns.last().unwrap().content.contains("summary"));

    // The person keeps the whole transcript; the models get the summary.
    say(&mut room, "thanks");
    assert_eq!(lines(&room).len(), 4);
    let seen = &opus.requests()[1];
    assert_eq!(seen.turns.len(), 1);
    assert!(seen.turns[0].content.contains("Chose sqlite."));
    assert!(seen.turns[0].content.ends_with("[Human]: thanks"));
    assert!(!seen.turns[0].content.contains("which database?"));
    assert_eq!(seen.unseen.len(), 1);

    // The summary is saved, and clearing drops it.
    let snapshot = room.snapshot();
    assert_eq!(snapshot.compaction.as_ref().map(|c| c.upto), Some(2));
    room.clear();
    assert!(room.snapshot().compaction.is_none());
}

#[test]
fn compacting_again_folds_the_last_summary_into_the_new_one() {
    let opus = bot("opus", &["a", "b"]);
    let mut room = room(&[&opus], TurnPolicy::Mention, 3);
    say(&mut room, "one");
    compact(&mut room, &ScriptedParticipant::new("opus", &["first summary"])).0.unwrap();

    // Nothing new since the last summary.
    assert!(compact(&mut room, &ScriptedParticipant::new("opus", &["x"])).0.is_err());

    say(&mut room, "two");
    let writer = ScriptedParticipant::new("opus", &["second summary"]);
    compact(&mut room, &writer).0.unwrap();
    let shown = &writer.requests()[0].turns[0].content;
    assert!(shown.contains("first summary") && shown.contains("[Human]: two") && !shown.contains("[Human]: one"));
}

#[test]
fn a_summarizer_that_passes_or_fails_leaves_the_chat_as_it_was() {
    let opus = bot("opus", &["a"]);
    let mut room = room(&[&opus], TurnPolicy::Mention, 3);
    say(&mut room, "hi");
    assert!(compact(&mut room, &ScriptedParticipant::new("opus", &[])).0.is_err());
    assert!(compact(&mut room, &ScriptedParticipant::new("opus", &["!fail offline"])).0.is_err());
    assert!(room.snapshot().compaction.is_none());
}

#[test]
fn the_last_addressed_bot_writes_the_summary() {
    let opus = bot("opus", &[]);
    let grok = bot("grok", &["hey"]);
    let mut room = room(&[&opus, &grok], TurnPolicy::Mention, 3);
    assert_eq!(room.summarizer().unwrap().id, ParticipantId::new("opus"));
    say(&mut room, "@grok hi");
    assert_eq!(room.summarizer().unwrap().id, ParticipantId::new("grok"));
}

/// A participant that proposes one edit and reports what it was told.
struct AskingBot(ParticipantConfig);

#[async_trait::async_trait]
impl Participant for AskingBot {
    fn config(&self) -> &ParticipantConfig {
        &self.0
    }

    async fn respond(&self, _: TurnRequest, _: DeltaSink<'_>) -> Result<Reply, ParticipantError> {
        Ok(Reply::text("did not ask"))
    }

    async fn respond_with_approvals(
        &self,
        _: TurnRequest,
        on_progress: ProgressSink<'_>,
        approver: &dyn Approver,
    ) -> Result<Reply, ParticipantError> {
        let action = ProposedAction { kind: ActionKind::Edit, title: "Edit a.txt".into(), detail: "-a\n+b\n".into() };
        match approver.decide(action).await {
            Decision::Approve => {
                on_progress(Progress::Change(&FileChange::new("a.txt", "-a\n+b\n")));
                Ok(Reply::text("Edited."))
            }
            Decision::Reject => Ok(Reply::text("Left it alone.")),
        }
    }
}

fn asking_room() -> (Room, ParticipantId) {
    let id = ParticipantId::new("asker");
    let config = ParticipantConfig {
        id: id.clone(),
        display_name: "asker".into(),
        backend: Backend::Scripted { lines: vec![] },
        persona: String::new(),
        access: Access::Ask,
        effort: None,
        appearance: None,
    };
    let roster: Vec<Arc<dyn Participant>> = vec![Arc::new(AskingBot(config))];
    (Room::new(roster, RoomOptions { policy: TurnPolicy::Mention, max_bot_hops: 0 }), id)
}

/// Run a round, answering every proposal with `approve` from another
/// thread, the way the desktop shell does while the room is busy.
fn say_and_answer(room: &mut Room, approve: Option<bool>) -> Vec<RoomEvent> {
    let desk = room.approvals_handle();
    let events = Mutex::new(Vec::new());
    let answer = |event: &RoomEvent| {
        if let RoomEvent::ApprovalRequested { request, .. } = event {
            let desk = Arc::clone(&desk);
            let request = request.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(20));
                match approve {
                    Some(yes) => assert!(desk.resolve(&request, if yes { Decision::Approve } else { Decision::Reject })),
                    // Pressing stop refuses whatever is waiting.
                    None => assert_eq!(desk.reject_all(), 1),
                }
            });
        }
    };
    block_on(room.post_human("go", &|event| {
        answer(&event);
        events.lock().unwrap().push(event);
    }));
    events.into_inner().unwrap()
}

#[test]
fn a_proposed_action_is_shown_and_the_turn_waits_for_the_answer() {
    let (mut room, id) = asking_room();
    let events = say_and_answer(&mut room, Some(true));
    let action = ProposedAction { kind: ActionKind::Edit, title: "Edit a.txt".into(), detail: "-a\n+b\n".into() };
    let about: Vec<&RoomEvent> = events
        .iter()
        .filter(|e| matches!(e, RoomEvent::ApprovalRequested { .. } | RoomEvent::ApprovalResolved { .. } | RoomEvent::Changed { .. }))
        .collect();
    assert_eq!(
        about,
        [
            &RoomEvent::ApprovalRequested { id: id.clone(), request: "ask-1".into(), action },
            &RoomEvent::ApprovalResolved { id: id.clone(), request: "ask-1".into(), approved: true },
            &RoomEvent::Changed { id: id.clone(), change: FileChange { path: "a.txt".into(), diff: "-a\n+b\n".into(), added: 1, removed: 1 } },
        ]
    );
    assert_eq!(lines(&room), ["human: go", "asker: Edited."]);
    assert_eq!(room.approvals_handle().waiting(), 0);
}

#[test]
fn a_rejected_or_abandoned_proposal_changes_nothing() {
    for answer in [Some(false), None] {
        let (mut room, id) = asking_room();
        let events = say_and_answer(&mut room, answer);
        assert!(events.contains(&RoomEvent::ApprovalResolved { id: id.clone(), request: "ask-1".into(), approved: false }));
        assert!(!events.iter().any(|e| matches!(e, RoomEvent::Changed { .. })));
        assert_eq!(lines(&room), ["human: go", "asker: Left it alone."]);
    }
}

struct StreamingUntilStopped { config: ParticipantConfig }
#[async_trait::async_trait]
impl Participant for StreamingUntilStopped {
    fn config(&self) -> &ParticipantConfig { &self.config }
    async fn respond(&self, _: TurnRequest, on_delta: DeltaSink<'_>) -> Result<Reply, ParticipantError> {
        on_delta("unfinished thought");
        futures::future::pending().await
    }
}
#[test]
fn stop_cancels_an_active_response_and_keeps_partial_text_for_the_next_model() {
    let config = bot("first", &[]).config().clone();
    let next = bot("next", &["taking over"]);
    let mut room = Room::new(vec![Arc::new(StreamingUntilStopped { config }), next.clone()], RoomOptions::default());
    let stop = room.stop_handle();
    let thread = std::thread::spawn(move || { std::thread::sleep(std::time::Duration::from_millis(40)); stop.store(true, Ordering::SeqCst); });
    let started = std::time::Instant::now();
    let events = say(&mut room, "@first begin");
    thread.join().unwrap();
    assert!(started.elapsed() < std::time::Duration::from_secs(2));
    assert!(events.contains(&RoomEvent::Stopped));
    assert!(lines(&room)[1].contains("unfinished thought"));
    assert!(lines(&room)[1].contains("[Interrupted]"));
    say(&mut room, "@next take over");
    assert!(next.requests()[0].turns.iter().any(|t| t.content.contains("unfinished thought")));
}

#[test]
fn pins_reach_every_model_and_survive_clear_and_compact() {
    let a = bot("a", &["one", "two", "three"]);
    let mut room = room(&[&a], TurnPolicy::Everyone, 0);
    room.pin("We are on Tauri 2").unwrap();
    say(&mut room, "hi");
    assert!(a.requests()[0].system.contains("- We are on Tauri 2"));

    let writer = ScriptedParticipant::new("a", &["summary"]);
    compact(&mut room, &writer).0.unwrap();
    say(&mut room, "again");
    assert!(a.requests().last().unwrap().system.contains("- We are on Tauri 2"));

    room.clear();
    say(&mut room, "fresh");
    assert!(a.requests().last().unwrap().system.contains("- We are on Tauri 2"));
    assert_eq!(room.snapshot().pins, vec!["We are on Tauri 2".to_string()]);
}

#[test]
fn pins_reject_empty_duplicate_and_oversized_facts_and_unpin_by_index() {
    let mut room = room(&[], TurnPolicy::Mention, 0);
    assert!(room.pin("   ").is_err());
    room.pin("first").unwrap();
    room.pin("second").unwrap();
    assert!(room.pin(" first ").is_err());
    assert!(room.pin(&"x".repeat(501)).is_err());
    room.unpin(0).unwrap();
    assert_eq!(room.pins(), ["second".to_string()]);
    assert!(room.unpin(5).is_err());
}

#[test]
fn no_pins_leave_the_system_prompt_unchanged() {
    let a = bot("a", &["ok"]);
    let mut room = room(&[&a], TurnPolicy::Everyone, 0);
    say(&mut room, "hi");
    assert!(!a.requests()[0].system.contains("pinned"));
}
