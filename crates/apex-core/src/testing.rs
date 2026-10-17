//! A participant that needs no model. It replies with prepared lines, which
//! makes it useful for tests and for trying the app without any API key.

use std::collections::VecDeque;
use std::sync::Mutex;

use async_trait::async_trait;

use crate::participant::{DeltaSink, Participant, ParticipantError, Progress, ProgressSink, Reply, TurnRequest};
use crate::types::{Access, Backend, ParticipantConfig, ParticipantId};
use crate::view::PASS_TOKEN;

pub struct ScriptedParticipant {
    config: ParticipantConfig,
    lines: Mutex<VecDeque<String>>,
    requests: Mutex<Vec<TurnRequest>>,
    named_only: bool,
}

impl ScriptedParticipant {
    /// Replies with each of `lines` in turn, then passes.
    pub fn new(id: &str, lines: &[&str]) -> Self {
        let lines: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
        Self::from_config(ParticipantConfig {
            id: ParticipantId::new(id),
            display_name: id.to_string(),
            backend: Backend::Scripted { lines: lines.clone() },
            persona: String::new(),
            access: Access::Read,
            effort: None,
            auto_effort: false, speed: None,
            appearance: None, media: None
        })
    }

    /// Build from a config whose backend is `Backend::Scripted`. Any other
    /// backend gives a participant with no lines, which always passes.
    pub fn from_config(config: ParticipantConfig) -> Self {
        let lines = match &config.backend {
            Backend::Scripted { lines } => lines.iter().cloned().collect(),
            _ => VecDeque::new(),
        };
        Self { config, lines: Mutex::new(lines), requests: Mutex::new(Vec::new()), named_only: false }
    }

    /// Answer only a person's message that names it, like a picture bot.
    pub fn named_only(mut self) -> Self {
        self.named_only = true;
        self
    }

    /// Every request this participant has been sent, oldest first.
    pub fn requests(&self) -> Vec<TurnRequest> {
        self.requests.lock().unwrap().clone()
    }
}

#[async_trait]
impl Participant for ScriptedParticipant {
    fn config(&self) -> &ParticipantConfig {
        &self.config
    }

    fn named_only(&self) -> bool {
        self.named_only
    }

    async fn respond(
        &self,
        request: TurnRequest,
        on_delta: DeltaSink<'_>,
    ) -> Result<Reply, ParticipantError> {
        self.answer(request, &|_| {}, on_delta)
    }

    /// A line that starts `!work a,b,c ` reports one finished step per key
    /// before the rest of the line is handled.
    async fn respond_with_progress(
        &self,
        request: TurnRequest,
        on_progress: ProgressSink<'_>,
    ) -> Result<Reply, ParticipantError> {
        self.answer(request, on_progress, &|text: &str| on_progress(Progress::Text(text)))
    }
}

impl ScriptedParticipant {
    fn answer(&self, request: TurnRequest, on_progress: ProgressSink<'_>, on_delta: DeltaSink<'_>) -> Result<Reply, ParticipantError> {
        self.requests.lock().unwrap().push(request);
        let line = self.lines.lock().unwrap().pop_front();
        let Some(mut line) = line else {
            return Ok(Reply::text(PASS_TOKEN));
        };
        if let Some(rest) = line.strip_prefix("!work ") {
            let (keys, rest) = rest.split_once(' ').unwrap_or((rest, ""));
            for key in keys.split(',').filter(|k| !k.is_empty()) {
                on_progress(Progress::Work(&work_step(key)));
            }
            line = rest.to_string();
        }
        if let Some(message) = line.strip_prefix("!fail ") {
            return Err(ParticipantError::Failed(message.to_string()));
        }
        for (i, word) in line.split(' ').enumerate() {
            if i > 0 {
                on_delta(" ");
            }
            on_delta(word);
        }
        Ok(Reply::text(line))
    }
}

fn work_step(key: &str) -> crate::work_steps::WorkStep {
    crate::work_steps::WorkStep {
        key: key.to_string(),
        parent: None,
        kind: crate::work_steps::StepKind::Command,
        label: key.to_string(),
        folder: None,
        detail: String::new(),
        output: None,
        status: crate::work_steps::StepStatus::Done,
        exit_code: None,
        duration_ms: None,
        output_cut: false,
    }
}
