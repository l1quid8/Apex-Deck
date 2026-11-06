use crate::{client::Cursor, input::Editor};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};

#[derive(Default, Debug)]
pub struct HistoryScroll {
    top: Option<usize>,
    end: usize,
}
impl HistoryScroll {
    pub fn up(&mut self, rows: usize) {
        self.top = Some(self.top.unwrap_or(self.end).saturating_sub(rows));
    }
    pub fn down(&mut self, rows: usize) {
        if let Some(top) = self.top {
            self.top = top.checked_add(rows).filter(|n| *n < self.end);
        }
    }
    pub fn start(&mut self, end: usize) -> usize {
        self.end = end;
        self.top.unwrap_or(end).min(end)
    }
}

#[derive(Clone, Debug)]
pub struct Thread {
    pub id: String,
    pub title: String,
    pub updated: u64,
    pub kind: String,
}
#[derive(Clone, Debug)]
pub enum Action {
    Setup(String),
    Dismiss,
    Open(String),
    Submit(String),
    Insert(String),
    Rpc {
        cmd: String,
        args: Value,
        confirmation: Option<String>,
    },
    Model(String),
    Access(String),
    Add(Value),
    Remove(String),
    Answer {
        request: String,
        questions: Vec<Value>,
        answers: Vec<Vec<String>>,
    },
    TypeAnswer {
        request: String,
        questions: Vec<Value>,
        answers: Vec<Vec<String>>,
    },
}
#[derive(Clone, Debug)]
pub struct Choice {
    pub label: String,
    pub detail: String,
    pub action: Action,
}
#[derive(Clone, Debug)]
pub struct Menu {
    pub title: String,
    pub choices: Vec<Choice>,
    pub selected: usize,
    pub completion: bool,
}
#[derive(Default)]
pub struct AppState {
    pub setup: Option<String>,
    pub agent_wizard: Option<crate::agent_setup::Wizard>,
    pub pending_agent: Option<crate::agent_setup::Wizard>,
    pub workspace_prompt: bool,
    pub selected: Option<String>,
    pub generation: u64,
    pub rooms: HashMap<String, Value>,
    pub threads: Vec<Thread>,
    pub cursor: Option<Cursor>,
    pub editor: Editor,
    pub menu: Option<Menu>,
    pub notice: String,
    pub drafts: HashMap<String, Editor>,
    pub answering: bool,
    pub connected: bool,
    pub busy: bool,
    pub history: std::cell::RefCell<HistoryScroll>,
    pub streams: HashMap<String, String>,
    pub activity: HashMap<String, String>,
    pub pending_messages: HashMap<String, (String, String)>,
    pub view: u8,
    pub overflowed: bool,
    buffered: VecDeque<Value>,
    /// Highest recovery number already reflected in the selected room's live
    /// view. Set by the first snapshot installed after selection; events at or
    /// below it are already counted, snapshots below it would rewind.
    applied: Option<u64>,
}
impl AppState {
    pub fn reset_connection_state(&mut self) {
        self.rooms.clear();
        self.streams.clear();
        self.activity.clear();
        self.buffered.clear();
        self.applied = None;
        self.overflowed = false;
    }
    pub fn select(&mut self, id: String) {
        self.drafts.insert(
            self.selected.clone().unwrap_or_default(),
            std::mem::take(&mut self.editor),
        );
        self.editor = self.drafts.remove(&id).unwrap_or_default();
        self.answering = false;
        self.selected = Some(id);
        self.generation += 1;
        self.busy = false;
        self.streams.clear();
        self.activity.clear();
        self.buffered.clear();
        self.applied = None;
        self.history = Default::default();
        self.view = 1;
    }
    pub fn current(&self) -> Option<&Value> {
        self.selected.as_ref().and_then(|id| self.rooms.get(id))
    }
    pub fn snapshot(&self) -> Value {
        self.current()
            .map(|v| v["snapshot"].clone())
            .unwrap_or(json!({}))
    }
    pub fn members(&self) -> Vec<Value> {
        self.snapshot()["participants"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    }
    pub fn install_snapshot(&mut self, id: &str, generation: u64, state: Value) -> bool {
        if generation != self.generation || self.selected.as_deref() != Some(id) {
            return false;
        }
        let recovery = state["recovery_seq"].as_u64().unwrap_or(0);
        if self
            .rooms
            .get(id)
            .is_some_and(|old| old["recovery_seq"].as_u64().unwrap_or(0) > recovery)
        {
            return false;
        }
        if self.applied.is_some_and(|w| recovery < w) {
            return false;
        }
        // Hosts that report partial replies are the authority for them: take
        // their copy, then replay only newer events so no text is doubled.
        let live = state["streams"].is_object();
        if live {
            self.streams = text_map(&state["streams"]);
            self.activity = text_map(&state["activity"]);
        }
        self.rooms.insert(id.into(), state);
        self.overflowed = false;
        let buffered = std::mem::take(&mut self.buffered);
        let mut applied = recovery;
        for envelope in buffered {
            let n = envelope["payload"]["recovery_seq"].as_u64();
            if envelope["payload"]["room"] == id && n.is_some_and(|n| n > recovery) {
                applied = applied.max(n.unwrap_or(0));
                if live {
                    self.reduce(&envelope["payload"]);
                }
                self.reduce_state(&envelope["payload"]);
            }
        }
        self.applied = Some(applied);
        let active = self
            .current()
            .map(|v| v["active"].clone())
            .unwrap_or(json!([]));
        let busy = |p: &String| active.as_array().is_some_and(|a| a.iter().any(|v| v == p));
        self.streams.retain(|p, _| busy(p));
        self.activity.retain(|p, _| busy(p));
        // Keep uncertain submission IDs until the caller observes a definitive
        // acknowledgement or reconciles a human retry against this transcript.
        true
    }
    pub fn apply_event(&mut self, envelope: Value) -> bool {
        let seq = envelope["seq"].as_u64().unwrap_or(0);
        if let Some(cursor) = self.cursor.as_mut() {
            if seq <= cursor.seq {
                return false;
            }
            cursor.seq = seq;
        } else {
            self.cursor = Some(Cursor {
                boot_id: String::new(),
                seq,
            });
        }
        let payload = &envelope["payload"];
        if self.selected.as_deref() != payload["room"].as_str() {
            return false;
        }
        // Already in the installed snapshot (or replayed): drop, don't double.
        if let Some(n) = payload["recovery_seq"].as_u64() {
            if let Some(w) = self.applied.as_mut() {
                if n <= *w {
                    return false;
                }
                *w = n;
            }
        }
        self.reduce(payload);
        self.reduce_state(payload);
        if self.buffered.len() == 2048 {
            self.buffered.pop_front();
            self.overflowed = true;
            self.connected = false;
        }
        self.buffered.push_back(envelope);
        true
    }
    fn reduce_state(&mut self, payload: &Value) {
        let Some(room) = self.selected.as_ref().and_then(|id| self.rooms.get_mut(id)) else {
            return;
        };
        let event = &payload["event"];
        let id = &event["id"];
        match event["type"].as_str().unwrap_or("") {
            "message_added" => {
                if let Some(messages) = room["snapshot"]["transcript"].as_array_mut() {
                    let m = &event["message"];
                    if !messages.iter().any(|old| old["seq"] == m["seq"]) {
                        messages.push(m.clone());
                    }
                }
            }
            "turn_started" => {
                if let Some(active) = room["active"].as_array_mut() {
                    if !active.contains(id) {
                        active.push(id.clone());
                    }
                }
            }
            "participant_idle" | "failed" => {
                if let Some(active) = room["active"].as_array_mut() {
                    active.retain(|v| v != id);
                }
            }
            "idle" | "stopped" => {
                room["active"] = json!([]);
                room["approvals"] = json!([]);
                room["questions"] = json!([]);
            }
            "participants_changed" => {
                room["snapshot"]["participants"] = event["participants"].clone()
            }
            "plan_changed" => room["plan"] = event["on"].clone(),
            _ => {}
        }
    }
    fn reduce(&mut self, payload: &Value) {
        let event = &payload["event"];
        let id = event["id"].as_str().unwrap_or("").to_string();
        match event["type"].as_str().unwrap_or("") {
            "turn_started" => {
                self.streams.remove(&id);
                self.activity.insert(id, "thinking…".into());
            }
            "delta" => {
                let stream = self.streams.entry(id).or_default();
                let text = event["text"].as_str().unwrap_or("");
                if stream.len() + text.len() < 1024 * 1024 {
                    stream.push_str(text);
                }
            }
            "activity" => {
                self.activity
                    .insert(id, event["text"].as_str().unwrap_or("").into());
            }
            "message_added" => {
                if let Some(p) = event["message"]["speaker"]["id"].as_str() {
                    self.streams.remove(p);
                    self.activity.remove(p);
                }
            }
            "participant_idle" | "failed" => {
                self.streams.remove(&id);
                self.activity.remove(&id);
            }
            "idle" | "stopped" => {
                self.streams.clear();
                self.activity.clear();
            }
            _ => {}
        }
    }
    /// Agents to show as working: the host's busy list, else live activity.
    pub fn working(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .current()
            .and_then(|v| v["active"].as_array())
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(String::from))
            .collect();
        for id in self.activity.keys() {
            if !ids.contains(id) {
                ids.push(id.clone());
            }
        }
        ids
    }
    pub fn title(&self) -> String {
        self.selected
            .as_ref()
            .map(|id| {
                self.threads
                    .iter()
                    .find(|t| &t.id == id)
                    .map(|t| t.title.clone())
                    .unwrap_or_else(|| id.clone())
            })
            .unwrap_or_else(|| "Welcome".into())
    }
}

fn text_map(v: &Value) -> HashMap<String, String> {
    v.as_object()
        .into_iter()
        .flatten()
        .filter_map(|(k, v)| v.as_str().map(|t| (k.clone(), t.to_string())))
        .collect()
}

pub fn mention(p: &Value) -> String {
    serde_json::from_value::<apex_core::ParticipantConfig>(p.clone())
        .map(|p| apex_core::mention_for(&p))
        .unwrap_or_else(|_| p["id"].as_str().unwrap_or("").to_string())
}
