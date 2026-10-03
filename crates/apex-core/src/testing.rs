//! A participant that needs no model. It replies with prepared lines, which
//! makes it useful for tests and for trying the app without any API key.

use std::collections::VecDeque;
use std::sync::Mutex;

use async_trait::async_trait;

use crate::participant::{DeltaSink, Participant, ParticipantError, Reply, TurnRequest};
use crate::types::{Access, Backend, ParticipantConfig, ParticipantId};
use crate::view::PASS_TOKEN;

pub struct ScriptedParticipant {
    config: ParticipantConfig,
    lines: Mutex<VecDeque<String>>,
    requests: Mutex<Vec<TurnRequest>>,
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
        })
    }

    /// Build from a config whose backend is `Backend::Scripted`. Any other
    /// backend gives a participant with no lines, which always passes.
    pub fn from_config(config: ParticipantConfig) -> Self {
        let lines = match &config.backend {
            Backend::Scripted { lines } => lines.iter().cloned().collect(),
            _ => VecDeque::new(),
        };
        Self { config, lines: Mutex::new(lines), requests: Mutex::new(Vec::new()) }
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

    async fn respond(
        &self,
        request: TurnRequest,
        on_delta: DeltaSink<'_>,
    ) -> Result<Reply, ParticipantError> {
        self.requests.lock().unwrap().push(request);
        let line = self.lines.lock().unwrap().pop_front();
        let Some(line) = line else {
            return Ok(Reply::text(PASS_TOKEN));
        };
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
