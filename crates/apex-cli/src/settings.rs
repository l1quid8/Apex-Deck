//! Per-agent, per-thread settings panel (mockups/apex-cli-v6.html).
//!
//! Pure state and key handling live here so they can be tested without a
//! terminal or daemon. The runtime performs the saves and model lookups.
use crate::state::AppState;
use crossterm::event::KeyCode;
use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Row {
    Model,
    Reasoning,
    Speed,
    Access,
}
const ROWS: [Row; 4] = [Row::Model, Row::Reasoning, Row::Speed, Row::Access];

/// One setting change. `Some(None)` puts the value back to its default.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Change {
    pub model: Option<Option<String>>,
    pub effort: Option<Option<String>>,
    pub speed: Option<Option<String>>,
    pub access: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelOption {
    /// `None` is "Default": the tool's own choice.
    pub id: Option<String>,
    pub label: String,
    /// `None` = not known; `Some([])` = no reasoning setting.
    pub efforts: Option<Vec<String>>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PanelIntent {
    None,
    Save { agent: String, change: Change },
    ModelMenu(String),
}

#[derive(Clone, Debug, Default)]
pub struct Panel {
    pub agent: String,
    pub row: Option<Row>,
    pub pending_access: Option<String>,
    pub confirm_full: bool,
    pub error: Option<String>,
    pub models: HashMap<String, Vec<ModelOption>>,
    /// Model lists asked for, stamped with the connection generation they were
    /// asked on. A reply from an older generation is dropped, so an older stamp
    /// means "ask again".
    pub requested: HashMap<String, u64>,
}

/// Saves in flight, kept on `AppState` so closing the panel can't forget them.
/// Each is stamped with the generation it was sent on: switching threads or
/// reconnecting bumps the generation and drops the reply, so an older stamp
/// no longer counts as in flight.
pub type Saves = HashMap<String, (u64, Row)>;
fn in_flight(saves: &Saves, generation: u64, agent: &str) -> Option<Row> {
    saves.get(agent).filter(|(g, _)| *g == generation).map(|(_, row)| *row)
}
pub fn saving(s: &AppState, agent: &str) -> Option<Row> {
    in_flight(&s.saves, s.generation, agent)
}
/// Mark a save as started. False if one is already in flight for this agent.
pub fn begin_save(s: &mut AppState, agent: &str, row: Row) -> bool {
    if saving(s, agent).is_some() {
        return false;
    }
    s.saves.insert(agent.to_string(), (s.generation, row));
    true
}
/// Whether the model list for this agent still needs asking for.
pub fn needs_models(panel: &mut Panel, generation: u64, agent: &str) -> bool {
    if panel.models.contains_key(agent) || panel.requested.get(agent) == Some(&generation) {
        return false;
    }
    panel.requested.insert(agent.to_string(), generation);
    true
}
impl Panel {
    pub fn row(&self) -> Row {
        self.row.unwrap_or(Row::Reasoning)
    }
}

pub const ACCESS: [(&str, &str); 4] = [("read", "Read"), ("ask", "Ask"), ("edits", "Edits"), ("full", "Full")];
const EFFORT_ORDER: [&str; 8] = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
// Same fallbacks as src/models.ts (AGENT_EFFORTS / API_EFFORTS).
fn fallback_efforts(p: &Value) -> Option<Vec<String>> {
    let list: &[&str] = match (p["backend"]["kind"].as_str(), p["backend"]["tool"].as_str()) {
        (Some("agent"), Some("claude_code")) => &["low", "medium", "high", "xhigh", "max"],
        (Some("agent"), Some("codex")) => &["low", "medium", "high", "xhigh", "max", "ultra"],
        (Some("agent"), Some("gemini")) => &["low", "medium", "high", "xhigh", "max"],
        (Some("agent"), Some("grok")) => &["low", "medium", "high", "xhigh"],
        (Some("agent"), Some("muse")) => &["minimal", "low", "medium", "high", "xhigh", "max"],
        (Some("open_ai_compatible"), _) => &["none", "minimal", "low", "medium", "high", "xhigh"],
        _ => return None,
    };
    Some(list.iter().map(|s| s.to_string()).collect())
}
fn least_first(mut list: Vec<String>) -> Vec<String> {
    let rank = |e: &String| EFFORT_ORDER.iter().position(|o| o == e).unwrap_or(EFFORT_ORDER.len());
    list.sort_by_key(rank);
    list
}

/// Port of src/speed.ts::supportsSpeed.
pub fn speed_ok(p: &Value) -> bool {
    let b = &p["backend"];
    match b["kind"].as_str() {
        Some("agent") => matches!(b["tool"].as_str(), Some("codex" | "claude_code")),
        Some("open_ai_compatible") => {
            let url = b["base_url"].as_str().unwrap_or("").trim();
            url.trim_end_matches('/') == "https://api.openai.com/v1"
        }
        _ => false,
    }
}

pub fn is_chat(s: &AppState) -> bool {
    s.snapshot()["kind"] == "chat"
}

/// ★ agents first, in thread order, then everyone else.
pub fn order(s: &AppState) -> Vec<Value> {
    let stars = s.current().and_then(|v| v["untagged_responders"].as_array().cloned()).unwrap_or_default();
    let members = s.members();
    let (mut first, rest): (Vec<_>, Vec<_>) = members.into_iter().partition(|p| stars.contains(&p["id"]));
    first.extend(rest);
    first
}
pub fn agent(s: &AppState) -> Option<Value> {
    let panel = s.settings.as_ref()?;
    s.members().into_iter().find(|p| p["id"] == panel.agent.as_str())
}

pub fn model_of(p: &Value) -> Option<String> {
    p["backend"]["model"].as_str().map(str::to_string)
}
fn model_info<'a>(panel: &'a Panel, p: &Value) -> Option<&'a ModelOption> {
    let id = model_of(p);
    panel.models.get(p["id"].as_str()?)?.iter().find(|m| m.id == id)
}
/// Reasoning levels this agent's model takes, or `None` when not offered.
pub fn efforts(panel: &Panel, p: &Value) -> Option<Vec<String>> {
    let list = match model_info(panel, p).and_then(|m| m.efforts.clone()) {
        Some(list) => list,
        None => fallback_efforts(p)?,
    };
    (!list.is_empty()).then(|| least_first(list))
}

/// Text for one row, or `None` with a reason when the row can't change.
pub fn value(s: &AppState, panel: &Panel, p: &Value, row: Row) -> Result<String, &'static str> {
    match row {
        Row::Model => Ok(model_of(p).unwrap_or_else(|| "default".into())),
        Row::Reasoning => {
            efforts(panel, p).ok_or("not offered")?;
            Ok(p["effort"].as_str().unwrap_or("default").to_string())
        }
        Row::Speed => {
            if !speed_ok(p) {
                return Err("not offered");
            }
            Ok(p["speed"].as_str().unwrap_or("default").to_string())
        }
        Row::Access => {
            if is_chat(s) {
                return Err("Read · talk-only chat");
            }
            let level = panel.pending_access.clone().unwrap_or_else(|| access_of(p));
            Ok(label(&level).to_string())
        }
    }
}
pub fn access_of(p: &Value) -> String {
    p["access"].as_str().unwrap_or("read").to_string()
}
pub fn label(level: &str) -> &str {
    ACCESS.iter().find(|(k, _)| *k == level).map(|(_, v)| *v).unwrap_or(level)
}

fn step<T: PartialEq + Clone>(list: &[T], current: &T, forward: bool) -> Option<T> {
    let at = list.iter().position(|v| v == current);
    let next = match (at, forward) {
        (None, _) => 0,
        (Some(i), true) => (i + 1).min(list.len().checked_sub(1)?),
        (Some(i), false) => i.saturating_sub(1),
    };
    let v = list.get(next)?.clone();
    (Some(&v) != list.get(at.unwrap_or(usize::MAX))).then_some(v)
}

/// Open (or close, if open) the panel. Starts on the first ★ agent and the
/// Reasoning row unless a row/agent is given (from /model or /access).
pub fn toggle(s: &mut AppState) {
    if s.settings.take().is_some() {
        return;
    }
    open(s, None, None);
}
pub fn open(s: &mut AppState, row: Option<Row>, agent: Option<String>) {
    if s.selected.is_none() || s.view == 0 {
        s.notice = "Open a thread first.".into();
        return;
    }
    let cast = order(s);
    let Some(first) = agent.or_else(|| cast.first().and_then(|p| p["id"].as_str().map(str::to_string))) else {
        s.notice = "No agents in this thread. /add one first.".into();
        return;
    };
    let mut panel = s.settings.take().unwrap_or_default();
    panel.agent = first;
    panel.row = row.or(panel.row);
    panel.pending_access = None;
    panel.confirm_full = false;
    panel.error = None;
    s.menu = None;
    s.view = 1;
    s.settings = Some(panel);
}

/// Route one key to the open panel. Returns `None` when the panel doesn't use it.
pub fn handle_key(s: &mut AppState, code: KeyCode) -> Option<PanelIntent> {
    let chat = is_chat(s);
    let cast = order(s);
    let p = agent(s);
    let generation = s.generation;
    let panel = s.settings.as_mut()?;
    let Some(p) = p else {
        // The agent left the thread; fall back to the first one.
        match cast.first() {
            Some(first) => panel.agent = first["id"].as_str().unwrap_or("").into(),
            None => s.settings = None,
        }
        return Some(PanelIntent::None);
    };
    if code != KeyCode::Esc {
        panel.error = None;
    }
    let row = panel.row();
    let id = panel.agent.clone();
    let busy = in_flight(&s.saves, generation, &id).is_some();
    match code {
        KeyCode::Esc => {
            if panel.confirm_full {
                panel.confirm_full = false;
            } else if panel.pending_access.is_some() {
                panel.pending_access = None;
            } else if panel.error.take().is_none() {
                s.settings = None;
            }
        }
        KeyCode::Tab => {
            let at = cast.iter().position(|c| c["id"] == id.as_str()).unwrap_or(0);
            if let Some(next) = cast.get((at + 1) % cast.len().max(1)) {
                panel.agent = next["id"].as_str().unwrap_or("").into();
            }
            panel.pending_access = None;
            panel.confirm_full = false;
        }
        KeyCode::Up | KeyCode::Down => {
            let i = ROWS.iter().position(|r| *r == row).unwrap_or(1);
            let next = if code == KeyCode::Up { (i + 3) % 4 } else { (i + 1) % 4 };
            panel.row = Some(ROWS[next]);
            panel.pending_access = None;
            panel.confirm_full = false;
        }
        KeyCode::Left | KeyCode::Right => {
            let forward = code == KeyCode::Right;
            if row == Row::Access {
                if chat {
                    return Some(PanelIntent::None);
                }
                let levels: Vec<String> = ACCESS.iter().map(|(k, _)| k.to_string()).collect();
                let now = panel.pending_access.clone().unwrap_or_else(|| access_of(&p));
                if let Some(next) = step(&levels, &now, forward) {
                    panel.pending_access = (next != access_of(&p)).then_some(next);
                }
                panel.confirm_full = false;
                return Some(PanelIntent::None);
            }
            if busy {
                return Some(PanelIntent::None);
            }
            let change = match row {
                Row::Model => {
                    let Some(list) = panel.models.get(&id) else {
                        return Some(PanelIntent::None);
                    };
                    let ids: Vec<Option<String>> = list.iter().map(|m| m.id.clone()).collect();
                    let Some(next) = step(&ids, &model_of(&p), forward) else {
                        return Some(PanelIntent::None);
                    };
                    let mut change = Change { model: Some(next.clone()), ..Change::default() };
                    // Keep reasoning only if the new model takes it.
                    let known = list.iter().find(|m| m.id == next).and_then(|m| m.efforts.clone());
                    if let (Some(known), Some(effort)) = (known, p["effort"].as_str()) {
                        if !known.iter().any(|e| e == effort) {
                            change.effort = Some(None);
                        }
                    }
                    change
                }
                Row::Reasoning => {
                    let Some(levels) = efforts(panel, &p) else {
                        return Some(PanelIntent::None);
                    };
                    let mut list: Vec<Option<String>> = vec![None];
                    list.extend(levels.into_iter().map(Some));
                    let now = p["effort"].as_str().map(str::to_string);
                    let Some(next) = step(&list, &now, forward) else {
                        return Some(PanelIntent::None);
                    };
                    Change { effort: Some(next), ..Change::default() }
                }
                Row::Speed => {
                    if !speed_ok(&p) {
                        return Some(PanelIntent::None);
                    }
                    let list = [None, Some("standard".to_string()), Some("fast".to_string())];
                    let now = p["speed"].as_str().map(str::to_string);
                    let Some(next) = step(&list, &now, forward) else {
                        return Some(PanelIntent::None);
                    };
                    Change { speed: Some(next), ..Change::default() }
                }
                Row::Access => unreachable!(),
            };
            s.saves.insert(id.clone(), (generation, row));
            return Some(PanelIntent::Save { agent: id, change });
        }
        KeyCode::Enter => {
            if row == Row::Model {
                return Some(if panel.models.contains_key(&id) && !busy {
                    PanelIntent::ModelMenu(id)
                } else {
                    PanelIntent::None
                });
            }
            if row != Row::Access || chat || busy {
                return Some(PanelIntent::None);
            }
            let Some(level) = panel.pending_access.clone() else {
                return Some(PanelIntent::None);
            };
            if level == "full" && !panel.confirm_full {
                panel.confirm_full = true;
                return Some(PanelIntent::None);
            }
            panel.confirm_full = false;
            panel.pending_access = None;
            s.saves.insert(id.clone(), (generation, Row::Access));
            return Some(PanelIntent::Save { agent: id, change: Change { access: Some(level), ..Change::default() } });
        }
        _ => return None,
    }
    Some(PanelIntent::None)
}

/// Record a save's reply. On success the returned participant replaces the
/// local copy so the panel and bottom line move together.
pub fn saved(s: &mut AppState, agent: &str, result: Result<Value, String>) {
    s.saves.remove(agent);
    match result {
        Ok(next) if next["id"] == agent => {
            if let Some(room) = s.selected.clone().and_then(|id| s.rooms.get_mut(&id)) {
                if let Some(list) = room["snapshot"]["participants"].as_array_mut() {
                    if let Some(slot) = list.iter_mut().find(|p| p["id"] == agent) {
                        *slot = next;
                    }
                }
            }
        }
        Ok(_) => {}
        Err(error) => match s.settings.as_mut() {
            Some(panel) => panel.error = Some(error),
            None => s.notice = error,
        },
    }
}

/// Parse an `agent_models` / `room_bot_models` reply.
pub fn parse_models(p: &Value, rows: &Value) -> Vec<ModelOption> {
    let mut out = vec![];
    if p["backend"]["kind"] == "agent" {
        out.push(ModelOption { id: None, label: "Default".into(), efforts: None });
    }
    for row in rows.as_array().into_iter().flatten() {
        let Some(id) = row["id"].as_str().or(row.as_str()) else { continue };
        out.push(ModelOption {
            id: Some(id.into()),
            label: row["label"].as_str().unwrap_or("").into(),
            efforts: row["efforts"].as_array().map(|a| a.iter().filter_map(|e| e.as_str().map(str::to_string)).collect()),
        });
    }
    // The current model stays selectable even if the provider no longer lists it.
    if let Some(current) = model_of(p) {
        if !out.iter().any(|m| m.id.as_deref() == Some(current.as_str())) {
            out.push(ModelOption { id: Some(current), label: String::new(), efforts: None });
        }
    }
    out
}

/// The exact command the CLI sends for one change.
pub fn request(room: &str, chat: bool, p: &Value, change: &Change) -> Result<(&'static str, Value), String> {
    if chat {
        if change.access.is_some() {
            return Err("Talk-only chats keep read access.".into());
        }
        return Ok(("chat_update_participant", json!({"id":room,"participant":p["id"],"patch":chat_patch(change)})));
    }
    Ok(("room_update_participant", json!({"id":room,"participant":apply(p, change),"base":p})))
}

/// The full participant to send as `room_update_participant` for a Work thread.
pub fn apply(p: &Value, change: &Change) -> Value {
    let mut next = p.clone();
    if let Some(model) = &change.model {
        next["backend"]["model"] = json!(model);
    }
    if let Some(effort) = &change.effort {
        next["effort"] = json!(effort);
    }
    if let Some(speed) = &change.speed {
        match speed {
            Some(v) => next["speed"] = json!(v),
            None => {
                if let Some(o) = next.as_object_mut() {
                    o.remove("speed");
                }
            }
        }
    }
    if let Some(access) = &change.access {
        next["access"] = json!(access);
    }
    next
}
/// The patch for `chat_update_participant`. Access is never sent: chats stay Read.
pub fn chat_patch(change: &Change) -> Value {
    let mut patch = serde_json::Map::new();
    if let Some(v) = &change.model {
        patch.insert("model".into(), json!(v));
    }
    if let Some(v) = &change.effort {
        patch.insert("effort".into(), json!(v));
    }
    if let Some(v) = &change.speed {
        patch.insert("speed".into(), json!(v));
    }
    Value::Object(patch)
}

/// One plain line of this thread's token use for the agent.
pub fn usage_line(s: &AppState, p: &Value) -> String {
    let u = &s.snapshot()["usage"][p["id"].as_str().unwrap_or("")];
    if !u.is_object() {
        return "No usage in this thread yet".into();
    }
    let k = |n: u64| if n >= 1000 { format!("{:.1}k", n as f64 / 1000.0) } else { n.to_string() };
    let mut line = format!(
        "This thread · {} in · {} out · {} turns",
        k(u["input"].as_u64().unwrap_or(0)),
        k(u["output"].as_u64().unwrap_or(0)),
        u["turns"].as_u64().unwrap_or(0)
    );
    if let Some(c) = u["cost_micros"].as_u64().filter(|c| *c > 0) {
        line.push_str(&format!(" · ${:.2}", c as f64 / 1_000_000.0));
    }
    line
}
