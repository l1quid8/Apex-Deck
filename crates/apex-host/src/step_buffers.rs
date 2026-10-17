//! Each bot's work steps during a turn, held until its reply lands.

use std::collections::HashMap;
use std::sync::Mutex;

use apex_core::work_steps::{ReplySteps, StepStatus};
use apex_core::{ParticipantId, RoomEvent, Speaker};

#[derive(Default)]
pub(crate) struct StepBuffers(Mutex<HashMap<(String, ParticipantId), ReplySteps>>);

impl StepBuffers {
    /// Follow one room event. Returns the record to save when `event` is a
    /// bot's reply and that bot reported steps or a to-do list for it.
    pub(crate) fn observe(&self, room: &str, event: &RoomEvent) -> Option<ReplySteps> {
        let mut buffers = self.0.lock().unwrap();
        let key = |id: &ParticipantId| (room.to_string(), id.clone());
        match event {
            // A new turn starts from nothing, whatever an earlier one left.
            RoomEvent::TurnStarted { id } => { buffers.remove(&key(id)); }
            RoomEvent::WorkStep { id, step } => buffers.entry(key(id)).or_insert_with(|| empty(id)).push(step.clone()),
            RoomEvent::Todo { id, items } => buffers.entry(key(id)).or_insert_with(|| empty(id)).todo = items.clone(),
            RoomEvent::MessageAdded { message } => {
                let Speaker::Bot(id) = &message.speaker else { return None };
                let mut record = buffers.remove(&key(id))?;
                record.seq = message.seq;
                // A saved record never shows a step as still running.
                for step in record.steps.iter_mut().filter(|step| step.status == StepStatus::Running) {
                    step.status = StepStatus::Stopped;
                }
                record.fit();
                return Some(record);
            }
            RoomEvent::Failed { id, .. } | RoomEvent::Passed { id } | RoomEvent::ParticipantIdle { id } => { buffers.remove(&key(id)); }
            RoomEvent::Stopped => buffers.retain(|(r, _), _| r != room),
            _ => {}
        }
        None
    }
}

fn empty(id: &ParticipantId) -> ReplySteps {
    ReplySteps { by: id.clone(), seq: 0, steps: Vec::new(), todo: Vec::new(), dropped: 0 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use apex_core::work_steps::{StepKind, TodoItem, TodoStatus, WorkStep};
    use apex_core::Message;

    fn step(key: &str, status: StepStatus) -> WorkStep {
        WorkStep { key: key.into(), parent: None, kind: StepKind::Command, label: key.into(), folder: None, detail: String::new(), output: None, status, exit_code: None, duration_ms: None, output_cut: false }
    }

    fn reply(by: &str, seq: usize) -> RoomEvent {
        RoomEvent::MessageAdded { message: Message { servers: vec![], seq, speaker: Speaker::Bot(ParticipantId::new(by)), text: "reply".into(), at: None } }
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
    fn rooms_bots_and_ended_turns_are_kept_apart() {
        let buffers = StepBuffers::default();
        buffers.observe("r", &work("ada", step("a", StepStatus::Done)));
        buffers.observe("other", &work("ada", step("x", StepStatus::Done)));
        buffers.observe("r", &work("bob", step("b", StepStatus::Done)));
        buffers.observe("r", &RoomEvent::Passed { id: ParticipantId::new("bob") });
        assert!(buffers.observe("r", &reply("bob", 2)).is_none(), "a pass drops the steps");
        assert_eq!(buffers.observe("r", &reply("ada", 3)).unwrap().steps[0].key, "a");
        buffers.observe("r", &work("ada", step("c", StepStatus::Done)));
        buffers.observe("r", &RoomEvent::Stopped);
        assert!(buffers.observe("r", &reply("ada", 4)).is_none(), "Stop drops every bot's steps in the room");
        assert_eq!(buffers.observe("other", &reply("ada", 1)).unwrap().steps[0].key, "x");
    }
}
