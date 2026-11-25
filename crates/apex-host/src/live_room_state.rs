use apex_core::RoomEvent;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashSet};

const LIVE_STREAM_CAP: usize = 1024 * 1024;

#[derive(Default)]
pub(super) struct LiveRoomState {
    worker: WorkerActivity,
    pub(super) view: RoomView,
}

#[derive(Default)]
struct WorkerActivity {
    last_activity_ms: u64,
    running_commands: HashSet<String>,
}

#[derive(Default)]
pub(super) struct RoomView {
    pub(super) active: BTreeSet<String>,
    pub(super) approvals: Vec<Value>,
    pub(super) questions: Vec<Value>,
    pub(super) next_steps: Option<Value>,
    pub(super) streams: BTreeMap<String, String>,
    pub(super) activity: BTreeMap<String, String>,
}

impl LiveRoomState {
    pub(super) fn worker_activity(&self) -> (u64, bool) {
        (
            self.worker.last_activity_ms,
            !self.worker.running_commands.is_empty(),
        )
    }

    /// Record the event and report whether the approved card ended planning.
    pub(super) fn observe(&mut self, event: &RoomEvent) -> bool {
        let plan_approved = match event {
            RoomEvent::ApprovalResolved {
                request,
                approved: true,
                ..
            } => self.view.approvals.iter().any(|a| {
                a["request"].as_str() == Some(request.as_str()) && a["action"]["kind"] == "plan"
            }),
            _ => false,
        };
        self.worker.observe(event);
        self.view.observe(event);
        plan_approved
    }
}

impl WorkerActivity {
    fn observe(&mut self, event: &RoomEvent) {
        if matches!(
            event,
            RoomEvent::TurnStarted { .. }
                | RoomEvent::Delta { .. }
                | RoomEvent::Activity { .. }
                | RoomEvent::WorkStep { .. }
                | RoomEvent::Todo { .. }
                | RoomEvent::MessageAdded { .. }
                | RoomEvent::Usage { .. }
                | RoomEvent::ApprovalResolved { .. }
                | RoomEvent::QuestionResolved { .. }
        ) {
            self.last_activity_ms = crate::personal::now();
        }
        if let RoomEvent::WorkStep { id, step } = event {
            let key = format!("{id}:{}", step.key);
            if step.status == apex_core::work_steps::StepStatus::Running {
                self.running_commands.insert(key);
            } else {
                self.running_commands.remove(&key);
            }
        }
        if let RoomEvent::TurnStarted { id } = event {
            let own = format!("{id}:");
            self.running_commands.retain(|key| !key.starts_with(&own));
        }
        if matches!(event, RoomEvent::Idle | RoomEvent::Stopped) {
            self.running_commands.clear();
        }
    }
}

impl RoomView {
    fn observe(&mut self, event: &RoomEvent) {
        match event {
            RoomEvent::TurnStarted { id } => {
                self.streams.remove(id.as_str());
                self.activity.remove(id.as_str());
            }
            RoomEvent::Delta { id, text } => {
                let stream = self.streams.entry(id.as_str().to_string()).or_default();
                if stream.len() + text.len() < LIVE_STREAM_CAP {
                    stream.push_str(text);
                }
            }
            RoomEvent::Activity { id, text } => {
                self.activity.insert(id.as_str().to_string(), text.clone());
            }
            RoomEvent::MessageAdded { message } => {
                if let apex_core::Speaker::Bot(id) = &message.speaker {
                    self.streams.remove(id.as_str());
                    self.activity.remove(id.as_str());
                }
            }
            RoomEvent::ParticipantIdle { id } | RoomEvent::Failed { id, .. } => {
                self.streams.remove(id.as_str());
                self.activity.remove(id.as_str());
            }
            RoomEvent::Idle | RoomEvent::Stopped => {
                self.streams.clear();
                self.activity.clear();
            }
            _ => {}
        }
        match event {
            RoomEvent::TurnStarted { id } => {
                self.active.insert(id.as_str().to_string());
                self.next_steps = None;
            }
            RoomEvent::QuestionRequested {
                id,
                request,
                questions,
            } => {
                self.questions
                    .retain(|q| q["request"].as_str() != Some(request.as_str()));
                self.questions
                    .push(serde_json::json!({"id":id,"request":request,"questions":questions}));
                self.next_steps = None;
            }
            RoomEvent::QuestionResolved { request, .. } => {
                self.questions
                    .retain(|q| q["request"].as_str() != Some(request.as_str()));
            }
            RoomEvent::NextSteps { id, steps, pending } => {
                self.next_steps = (*pending || !steps.is_empty())
                    .then(|| serde_json::json!({"id":id,"steps":steps,"pending":pending}));
            }
            RoomEvent::MessageAdded { message } if message.speaker == apex_core::Speaker::Human || matches!(&message.speaker, apex_core::Speaker::Bot(id) if id.as_str() == "deck") => {
                self.next_steps = None;
            }
            RoomEvent::ApprovalRequested {
                id,
                request,
                action,
            } => {
                self.approvals
                    .retain(|a| a["request"].as_str() != Some(request.as_str()));
                self.approvals
                    .push(serde_json::json!({"id":id,"request":request,"action":action}));
            }
            RoomEvent::ApprovalResolved { request, .. } => {
                self.approvals
                    .retain(|a| a["request"].as_str() != Some(request.as_str()));
            }
            RoomEvent::ParticipantIdle { id } | RoomEvent::Failed { id, .. } => {
                self.active.remove(id.as_str());
                self.approvals
                    .retain(|a| a["id"].as_str() != Some(id.as_str()));
                self.questions
                    .retain(|q| q["id"].as_str() != Some(id.as_str()));
            }
            // Next steps are worked out after Idle, so only Stop clears them.
            RoomEvent::Idle => {
                self.active.clear();
                self.approvals.clear();
                self.questions.clear();
            }
            RoomEvent::Stopped => {
                self.active.clear();
                self.approvals.clear();
                self.questions.clear();
                self.next_steps = None;
            }
            _ => {}
        }
    }
}
