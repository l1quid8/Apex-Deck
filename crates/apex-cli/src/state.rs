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
    Setting {
        agent: String,
        change: crate::settings::Change,
    },
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
impl Action {
    /// Approve/Reject (including its confirm step) and question answers.
    /// These must run while a message is still sending: a Work-thread post
    /// only returns when the agent's turn ends, and that turn is waiting on
    /// this very reply.
    pub fn replies_to_agent(&self) -> bool {
        matches!(self, Action::Rpc { cmd, .. } if cmd == "room_decide" || cmd == "room_answer")
    }
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
    pub composition: crate::composition::Composition,
    pub launch_folder: std::path::PathBuf,
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
    pub input_history: crate::history::History,
    pub menu: Option<Menu>,
    /// The approval card (`crate::approval_card`), when open.
    pub card: Option<crate::approval_card::Card>,
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
    pub settings: Option<crate::settings::Panel>,
    pub saves: crate::settings::Saves,
    buffered: VecDeque<Value>,
    /// Requests in the open thread the person has already been told about.
    announced: std::collections::HashSet<String>,
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
        self.announced.clear();
        self.card = None;
        self.overflowed = false;
    }
    /// Call on every (re)connect. A fresh backend or failed replay drops all
    /// live state; a resumed replay keeps it. Either way, waiting requests are
    /// announced again once the thread reloads.
    pub fn connected(&mut self, hello: &Value) {
        let boot = hello["boot_id"].as_str().unwrap_or("").to_string();
        if self.cursor.as_ref().is_none_or(|old| old.boot_id != boot) || hello["resumed"] != true {
            self.cursor = Some(Cursor { boot_id: boot, seq: hello["last_seq"].as_u64().unwrap_or(0) });
            self.reset_connection_state();
        }
        self.announced.clear();
    }
    pub fn select(&mut self, id: String) {
        self.input_history.restore_draft(&mut self.editor);
        self.drafts.insert(
            self.selected.clone().unwrap_or_default(),
            std::mem::take(&mut self.editor),
        );
        self.editor = self.drafts.remove(&id).unwrap_or_default();
        self.answering = false;
        self.settings = None;
        self.card = None;
        self.selected = Some(id);
        self.generation += 1;
        self.busy = false;
        self.streams.clear();
        self.activity.clear();
        self.buffered.clear();
        self.applied = None;
        self.announced.clear();
        self.history = Default::default();
        self.view = 1;
    }
    /// Approvals plus questions waiting in the open thread.
    pub fn pending_requests(&self) -> usize {
        self.current().map_or(0, |r| {
            ["approvals", "questions"].iter().map(|k| r[*k].as_array().map_or(0, Vec::len)).sum()
        })
    }
    /// Call after any event or snapshot. Returns true when the request list
    /// should open now. When a request is new but the person is typing, in a
    /// menu or panel, or answering, it only leaves a notice so no keystroke
    /// meant for something else can approve or reject it.
    pub fn announce_requests(&mut self, answering: bool) -> bool {
        let waiting: std::collections::HashSet<String> = self.current().map_or_else(Default::default, |r| {
            ["approvals", "questions"]
                .iter()
                .flat_map(|k| r[*k].as_array().into_iter().flatten())
                .map(|e| e["request"].to_string())
                .collect()
        });
        let fresh = waiting.iter().any(|k| !self.announced.contains(k));
        self.announced = waiting;
        if !fresh {
            return false;
        }
        // An open card already shows the queue ("1 of 2"); nothing to add.
        if self.card.is_some() {
            return false;
        }
        if self.menu.is_none() && self.settings.is_none() && !answering && self.editor.text.is_empty() {
            return true;
        }
        self.notice = "An agent is waiting for your approval or answer · F2 Requests".into();
        false
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
                for list in ["approvals", "questions"] {
                    if let Some(open) = room[list].as_array_mut() {
                        open.retain(|v| &v["id"] != id);
                    }
                }
            }
            // Mirror the host's live wait lists so F2 and the auto-prompt see
            // requests raised after the snapshot was loaded.
            "approval_requested" => {
                let entry = json!({"id":id,"request":event["request"],"action":event["action"]});
                upsert(&mut room["approvals"], entry);
            }
            "question_requested" => {
                let entry = json!({"id":id,"request":event["request"],"questions":event["questions"]});
                upsert(&mut room["questions"], entry);
            }
            "approval_resolved" => drop_request(&mut room["approvals"], &event["request"]),
            "question_resolved" => drop_request(&mut room["questions"], &event["request"]),
            "idle" | "stopped" => {
                room["active"] = json!([]);
                room["approvals"] = json!([]);
                room["questions"] = json!([]);
            }
            "participants_changed" => {
                room["snapshot"]["participants"] = event["participants"].clone()
            }
            "participant_changed" => {
                let next = &event["participant"];
                if let Some(slot) = room["snapshot"]["participants"]
                    .as_array_mut()
                    .and_then(|list| list.iter_mut().find(|p| p["id"] == next["id"]))
                {
                    *slot = next.clone();
                }
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
            "participant_idle" => {
                self.streams.remove(&id);
                self.activity.remove(&id);
            }
            "failed" => {
                self.streams.remove(&id);
                self.activity.remove(&id);
                self.notice = self.failure_notice(&id, event["error"].as_str().unwrap_or(""));
            }
            "idle" | "stopped" => {
                self.streams.clear();
                self.activity.clear();
            }
            _ => {}
        }
    }
    /// What the person sees when an agent's turn ends in an error, which the
    /// host doesn't keep in the transcript.
    fn failure_notice(&self, id: &str, error: &str) -> String {
        let name = self.members().into_iter().find(|p| p["id"] == id)
            .and_then(|p| p["display_name"].as_str().or_else(|| p["name"].as_str()).map(str::to_string))
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| id.to_string());
        let error = error.split_whitespace().collect::<Vec<_>>().join(" ");
        let lower = error.to_lowercase();
        let sign_in = lower.contains("not logged in") || lower.contains("not signed in")
            || lower.contains("token expired") || lower.contains("token has expired")
            || lower.contains("authentication token") || lower.contains("failed to refresh") && lower.contains("token")
            || lower.contains("connection needs refreshing");
        let hint = if sign_in && !lower.contains("/login") { " · Run /login to sign in again." } else { "" };
        let error = if error.chars().count() > 400 { format!("{}…", error.chars().take(400).collect::<String>()) } else { error };
        if error.is_empty() { format!("{name} couldn't reply.") } else { format!("{name} couldn't reply: {error}{hint}") }
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

fn upsert(list: &mut Value, entry: Value) {
    if !list.is_array() {
        *list = json!([]);
    }
    let open = list.as_array_mut().expect("array");
    open.retain(|v| v["request"] != entry["request"]);
    open.push(entry);
}
fn drop_request(list: &mut Value, request: &Value) {
    if let Some(open) = list.as_array_mut() {
        open.retain(|v| &v["request"] != request);
    }
}
