//! Each bot's work steps during a turn, held until its reply lands.

use std::collections::HashMap;
use std::sync::Mutex;

use apex_core::work_steps::{ReplySteps, StepStatus, TurnOutcome};
use apex_core::{ParticipantId, RoomEvent, Speaker};

#[derive(Default)]
pub(crate) struct StepBuffers {
    records: Mutex<HashMap<(String, ParticipantId), ReplySteps>>,
    /// The last transcript position seen per room, so a turn that ends without
    /// a reply can be filed at the position its reply would have had.
    last_seq: Mutex<HashMap<String, usize>>,
}

impl StepBuffers {
    pub(crate) fn snapshot(&self, room: &str) -> std::collections::BTreeMap<String, ReplySteps> {
        self.records.lock().unwrap().iter().filter(|((r, _), _)| r == room)
            .map(|((_, id), progress)| (id.to_string(), progress.clone())).collect()
    }
    pub(crate) fn get(&self, room: &str, id: &ParticipantId) -> Option<ReplySteps> {
        self.records.lock().unwrap().get(&(room.to_string(), id.clone())).cloned()
    }
    pub(crate) fn clear(&self, room: &str) { self.records.lock().unwrap().retain(|(r, _), _| r != room); }
    /// The turns that `event` ended without a reply, and that reported work:
    /// a bot that failed, or one stopped (an idle bot that never answered
    /// counts as stopped). Each record is handed out once, with `seq` set to
    /// the transcript position its reply would have taken, so it can be saved
    /// beside the replies' steps. A pass reports no work and is not kept.
    pub(crate) fn take_ended(&self, room: &str, event: &RoomEvent) -> Vec<ReplySteps> {
        let mut records = self.records.lock().unwrap();
        let ids: Vec<ParticipantId> = match event {
            RoomEvent::Failed { id, .. } | RoomEvent::ParticipantIdle { id } => vec![id.clone()],
            RoomEvent::Stopped => records.keys().filter(|(r, _)| r == room).map(|(_, id)| id.clone()).collect(),
            _ => return Vec::new(),
        };
        let next = self.last_seq.lock().unwrap().get(room).map_or(0, |seq| seq + 1);
        let mut out = Vec::new();
        for id in ids {
            let key = (room.to_string(), id);
            let ended = records.get(&key).is_some_and(|record| {
                matches!(record.outcome, Some(TurnOutcome::Failed | TurnOutcome::Stopped)) && (!record.steps.is_empty() || !record.todo.is_empty())
            });
            if !ended { continue; }
            let mut record = records.remove(&key).expect("checked just above");
            record.seq = next;
            record.fit();
            out.push(record);
        }
        out
    }
    /// Follow one room event. Returns the record to save when `event` is a
    /// bot's reply and that bot reported steps or a to-do list for it.
    pub(crate) fn observe(&self, room: &str, event: &RoomEvent) -> Option<ReplySteps> {
        let mut buffers = self.records.lock().unwrap();
        let key = |id: &ParticipantId| (room.to_string(), id.clone());
        match event {
            // A new turn starts from nothing, whatever an earlier one left.
            RoomEvent::TurnStarted { id } => { buffers.remove(&key(id)); }
            RoomEvent::Delta { id, text } => buffers.entry(key(id)).or_insert_with(|| empty(id)).append_text(text),
            RoomEvent::WorkStep { id, step } => {
                let record = buffers.entry(key(id)).or_insert_with(|| empty(id));
                if step.parent.is_none() && !record.has_activity(&step.key) { record.note_activity(&step.key); }
                record.push(step.clone());
            }
            RoomEvent::Todo { id, items } => buffers.entry(key(id)).or_insert_with(|| empty(id)).todo = items.clone(),
            RoomEvent::MessageAdded { message } => {
                self.last_seq.lock().unwrap().insert(room.to_string(), message.seq);
                let Speaker::Bot(id) = &message.speaker else { return None };
                let mut record = buffers.remove(&key(id))?;
                record.seq = message.seq;
                // A saved record never shows a step as still running.
                for step in record.steps.iter_mut().filter(|step| step.status == StepStatus::Running) {
                    step.status = StepStatus::Stopped;
                }
                // Transcript text is already stored by the room. A steps row
                // exists only when there is tool or checklist progress to show.
                if record.steps.is_empty() && record.todo.is_empty() { return None; }
                record.fit();
                return Some(record);
            }
            RoomEvent::Failed { id, .. } => { if let Some(record) = buffers.get_mut(&key(id)) { record.outcome = Some(TurnOutcome::Failed); stop_running(record, StepStatus::Stopped); } }
            RoomEvent::Passed { id } => { if let Some(record) = buffers.get_mut(&key(id)) { record.outcome = Some(TurnOutcome::Passed); stop_running(record, StepStatus::Stopped); } }
            RoomEvent::ParticipantIdle { id } => { if let Some(record) = buffers.get_mut(&key(id)) { record.outcome.get_or_insert(TurnOutcome::Stopped); stop_running(record, StepStatus::Stopped); } }
            RoomEvent::Stopped => for ((r, _), record) in buffers.iter_mut() { if r == room { record.outcome.get_or_insert(TurnOutcome::Stopped); stop_running(record, StepStatus::Stopped); } },
            _ => {}
        }
        None
    }
}

fn empty(id: &ParticipantId) -> ReplySteps {
    ReplySteps { by: id.clone(), seq: 0, steps: Vec::new(), todo: Vec::new(), dropped: 0, timeline: Vec::new(), outcome: None, timeline_cut: false }
}

fn stop_running(record: &mut ReplySteps, status: StepStatus) {
    for step in record.steps.iter_mut().filter(|step| step.status == StepStatus::Running) { step.status = status; }
}

#[cfg(test)]
mod tests {
    use super::*;
    use apex_core::work_steps::{StepKind, TodoItem, TodoStatus, WorkStep};
    use apex_core::Message;

    fn step(key: &str, status: StepStatus) -> WorkStep {
        WorkStep { key: key.into(), parent: None, kind: StepKind::Command, label: key.into(), folder: None, detail: String::new(), output: None, status, exit_code: None, duration_ms: None, output_cut: false }
    }

    #[test]
    fn a_failed_or_stopped_turn_with_work_is_handed_out_once_at_the_next_transcript_position() {
        let buffers = StepBuffers::default();
        let ada = ParticipantId::new("ada");
        let bob = ParticipantId::new("bob");
        // The human's message is at seq 4; the bots' replies would have been 5.
        buffers.observe("r", &RoomEvent::MessageAdded { message: Message { late_reply_from: None, origin_seq: None, origin: None, client_message_id: None, reply_to_client_message_id: None, servers: vec![], seq: 4, speaker: Speaker::Human, text: "go".into(), at: None } });
        buffers.observe("r", &RoomEvent::WorkStep { id: ada.clone(), step: step("ls", StepStatus::Running) });
        buffers.observe("r", &RoomEvent::WorkStep { id: bob.clone(), step: step("cat", StepStatus::Running) });
        buffers.observe("r", &RoomEvent::TurnStarted { id: ParticipantId::new("cy") });
        // Failed: handed out once, running steps marked stopped, filed at seq 5.
        buffers.observe("r", &RoomEvent::Failed { id: ada.clone(), error: "boom".into() });
        let ended = buffers.take_ended("r", &RoomEvent::Failed { id: ada.clone(), error: "boom".into() });
        assert_eq!(ended.len(), 1);
        assert_eq!((ended[0].seq, ended[0].outcome, ended[0].steps[0].status), (5, Some(TurnOutcome::Failed), StepStatus::Stopped));
        assert!(buffers.take_ended("r", &RoomEvent::ParticipantIdle { id: ada.clone() }).is_empty(), "the idle that follows a failure hands out nothing more");
        // Stop: every remaining turn with work, once; a bot with no work (cy) is not kept.
        buffers.observe("r", &RoomEvent::Stopped);
        let stopped = buffers.take_ended("r", &RoomEvent::Stopped);
        assert_eq!(stopped.iter().map(|r| (r.by.to_string(), r.outcome)).collect::<Vec<_>>(), vec![("bob".to_string(), Some(TurnOutcome::Stopped))]);
        assert!(buffers.take_ended("r", &RoomEvent::Stopped).is_empty());
        // A pass reports no work and is never kept.
        buffers.observe("r", &RoomEvent::WorkStep { id: ada.clone(), step: step("ls", StepStatus::Done) });
        buffers.observe("r", &RoomEvent::Passed { id: ada.clone() });
        assert!(buffers.take_ended("r", &RoomEvent::ParticipantIdle { id: ada.clone() }).is_empty());
    }

    fn reply(by: &str, seq: usize) -> RoomEvent {
        RoomEvent::MessageAdded { message: Message { late_reply_from: None, origin_seq: None, origin: None, client_message_id: None, reply_to_client_message_id: None, servers: vec![], seq, speaker: Speaker::Bot(ParticipantId::new(by)), text: "reply".into(), at: None } }
    }

    fn work(by: &str, step: WorkStep) -> RoomEvent {
        RoomEvent::WorkStep { id: ParticipantId::new(by), step }
    }

    #[test]
    fn running_steps_saved_as_stopped() {
        let buffers = StepBuffers::default();
        buffers.observe("r", &work("bot", step("a", StepStatus::Done)));
        buffers.observe("r", &work("bot", step("b", StepStatus::Running)));
        let todo = vec![TodoItem { text: "ship".into(), status: TodoStatus::InProgress }];
        buffers.observe("r", &RoomEvent::Todo { id: ParticipantId::new("bot"), items: todo.clone() });
        let record = buffers.observe("r", &reply("bot", 4)).unwrap();
        assert_eq!(record.seq, 4);
        assert_eq!(record.steps.iter().map(|s| s.status).collect::<Vec<_>>(), [StepStatus::Done, StepStatus::Stopped]);
        assert_eq!(record.todo, todo);
        assert!(buffers.observe("r", &reply("bot", 5)).is_none(), "saved once, then forgotten");
    }

    #[test]
    fn failed_turn_keeps_progress_and_marks_running_step_failed() {
        let buffers = StepBuffers::default();
        buffers.observe("r", &work("bot", step("a", StepStatus::Running)));
        buffers.observe("r", &RoomEvent::Delta { id: ParticipantId::new("bot"), text: "partial".into() });
        buffers.observe("r", &RoomEvent::Failed { id: ParticipantId::new("bot"), error: "oops".into() });
        let progress = buffers.snapshot("r");
        assert_eq!(progress["bot"].outcome, Some(TurnOutcome::Failed));
        assert_eq!(progress["bot"].steps[0].status, StepStatus::Stopped, "generic turn failure does not claim the tool itself failed");
        assert_eq!(progress["bot"].timeline[1], apex_core::work_steps::TurnSegment::Text { text: "partial".into() });
        buffers.observe("r", &RoomEvent::Stopped);
        assert_eq!(buffers.snapshot("r")["bot"].outcome, Some(TurnOutcome::Failed), "global stop does not overwrite a prior failure");
    }

    #[test]
    fn text_only_reply_does_not_create_a_saved_steps_record() {
        let buffers = StepBuffers::default();
        buffers.observe("r", &RoomEvent::Delta { id: ParticipantId::new("bot"), text: "hello".into() });
        assert!(buffers.observe("r", &reply("bot", 1)).is_none());
        assert!(buffers.snapshot("r").is_empty());
    }

    #[test]
    fn rooms_bots_and_ended_turns_are_kept_apart() {
        let buffers = StepBuffers::default();
        buffers.observe("r", &work("ada", step("a", StepStatus::Done)));
        buffers.observe("other", &work("ada", step("x", StepStatus::Done)));
        buffers.observe("r", &work("bob", step("b", StepStatus::Done)));
        buffers.observe("r", &RoomEvent::Passed { id: ParticipantId::new("bob") });
        let passed = buffers.snapshot("r");
        assert_eq!(passed["bob"].steps[0].key, "b");
        assert_eq!(passed["bob"].outcome, Some(TurnOutcome::Passed));
        assert_eq!(buffers.observe("r", &reply("ada", 3)).unwrap().steps[0].key, "a");
        buffers.observe("r", &work("ada", step("c", StepStatus::Done)));
        buffers.observe("r", &RoomEvent::Stopped);
        assert_eq!(buffers.snapshot("r")["ada"].outcome, Some(TurnOutcome::Stopped));
        assert_eq!(buffers.observe("other", &reply("ada", 1)).unwrap().steps[0].key, "x");
    }

    #[test]
    fn reply_record_over_limit_drops_oldest_outputs() {
        use apex_core::work_steps::{cut_output, REPLY_STEPS_BYTES_MAX};
        let buffers = StepBuffers::default();
        // 200 steps of ~12 KB output each: about 2.4 MB before fitting.
        let output = cut_output(&"x".repeat(64 * 1024));
        for n in 0..200 {
            let mut s = step(&n.to_string(), StepStatus::Done);
            s.output = Some(output.clone());
            buffers.observe("r", &work("bot", s));
        }
        let record = buffers.observe("r", &reply("bot", 9)).unwrap();
        assert!(serde_json::to_vec(&record).unwrap().len() <= REPLY_STEPS_BYTES_MAX);
        assert_eq!(record.steps.len(), 200);
        assert_eq!(record.steps[0].output, None);
        assert!(record.steps[0].output_cut);
        let newest = record.steps.last().unwrap();
        assert_eq!(newest.output.as_deref(), Some(output.as_str()));
        assert!(!newest.output_cut);
    }
}
