//! Settings panel key routing and save bookkeeping (no terminal, no daemon).
use apex_cli::{
    settings::{self, Change, ModelOption, PanelIntent, Row},
    state::AppState,
    terminal::{handle_event, Intent},
};
use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
use serde_json::{json, Value};

fn agents() -> Value {
    json!([
        {"id":"null","display_name":"Null","access":"ask","effort":"high","backend":{"kind":"agent","tool":"codex","model":"gpt-5.5"}},
        {"id":"muck","display_name":"Muck","access":"edits","backend":{"kind":"agent","tool":"claude_code","model":null}},
        {"id":"tool","display_name":"Tool","access":"read","backend":{"kind":"cli","program":"x","args":[]}}
    ])
}
fn state(kind: &str, active: Value) -> AppState {
    let mut s = AppState::default();
    s.select("r".into());
    s.connected = true;
    s.install_snapshot(
        "r",
        s.generation,
        json!({"recovery_seq":0,"untagged_responders":["muck"],"snapshot":{"kind":kind,"participants":agents(),"transcript":[]},"active":active}),
    );
    s
}
fn key(s: &mut AppState, code: KeyCode) -> Intent {
    handle_event(s, Event::Key(KeyEvent::new(code, KeyModifiers::NONE)))
}
fn shift_tab(s: &mut AppState) -> Intent {
    handle_event(s, Event::Key(KeyEvent::new(KeyCode::BackTab, KeyModifiers::SHIFT)))
}
fn panel(s: &AppState) -> &settings::Panel {
    s.settings.as_ref().expect("panel open")
}

#[test]
fn shift_tab_opens_on_first_star_agent_and_reasoning_and_keeps_draft() {
    let mut s = state("work", json!([]));
    s.editor.insert("half-typed");
    shift_tab(&mut s);
    assert_eq!(panel(&s).agent, "muck", "★ agents come first");
    assert_eq!(panel(&s).row(), Row::Reasoning);
    key(&mut s, KeyCode::Tab);
    assert_eq!(panel(&s).agent, "null");
    key(&mut s, KeyCode::Tab);
    key(&mut s, KeyCode::Tab);
    assert_eq!(panel(&s).agent, "muck", "Tab wraps");
    shift_tab(&mut s);
    assert!(s.settings.is_none());
    assert_eq!(s.editor.text, "half-typed");
    // Some terminals report ⇧Tab as Tab + Shift.
    handle_event(&mut s, Event::Key(KeyEvent::new(KeyCode::Tab, KeyModifiers::SHIFT)));
    assert!(s.settings.is_some());
}

#[test]
fn esc_with_panel_open_never_stops_working_agents() {
    let mut s = state("work", json!(["null", "muck"]));
    shift_tab(&mut s);
    assert_eq!(key(&mut s, KeyCode::Esc), Intent::Panel(PanelIntent::None));
    assert!(s.settings.is_none());
    // Closed again: Esc keeps its usual stop behaviour.
    assert_eq!(key(&mut s, KeyCode::Esc), Intent::Stop);
}

#[test]
fn access_needs_enter_full_needs_two_and_leaving_row_drops_choice() {
    let mut s = state("work", json!([]));
    settings::open(&mut s, Some(Row::Access), Some("null".into()));
    key(&mut s, KeyCode::Right);
    assert_eq!(panel(&s).pending_access.as_deref(), Some("edits"));
    key(&mut s, KeyCode::Down);
    assert_eq!(panel(&s).pending_access, None, "moving rows drops it");
    key(&mut s, KeyCode::Up);
    key(&mut s, KeyCode::Right);
    key(&mut s, KeyCode::Right);
    assert_eq!(panel(&s).pending_access.as_deref(), Some("full"));
    assert_eq!(key(&mut s, KeyCode::Enter), Intent::Panel(PanelIntent::None));
    assert!(panel(&s).confirm_full);
    // Esc cancels the confirm first, then the pending choice, then closes.
    key(&mut s, KeyCode::Esc);
    assert!(!panel(&s).confirm_full);
    assert_eq!(panel(&s).pending_access.as_deref(), Some("full"));
    key(&mut s, KeyCode::Enter);
    assert_eq!(
        key(&mut s, KeyCode::Enter),
        Intent::Panel(PanelIntent::Save { agent: "null".into(), change: Change { access: Some("full".into()), ..Change::default() } })
    );
    assert_eq!(settings::saving(&s, "null"), Some(Row::Access));
    // Lowering needs only one Enter.
    let mut s = state("work", json!([]));
    settings::open(&mut s, Some(Row::Access), Some("null".into()));
    key(&mut s, KeyCode::Left);
    assert!(matches!(key(&mut s, KeyCode::Enter), Intent::Panel(PanelIntent::Save { .. })));
}

#[test]
fn arrows_save_at_once_and_wait_for_reply_before_the_next_save() {
    let mut s = state("work", json!([]));
    settings::open(&mut s, Some(Row::Reasoning), Some("null".into()));
    let first = key(&mut s, KeyCode::Right);
    assert_eq!(
        first,
        Intent::Panel(PanelIntent::Save { agent: "null".into(), change: Change { effort: Some(Some("xhigh".into())), ..Change::default() } })
    );
    assert_eq!(key(&mut s, KeyCode::Right), Intent::Panel(PanelIntent::None), "one save in flight per agent");
    // Value shown stays the old one until the service answers.
    let p = settings::agent(&s).unwrap();
    assert_eq!(settings::value(&s, panel(&s), &p, Row::Reasoning).unwrap(), "high");
    let mut next = p.clone();
    next["effort"] = json!("xhigh");
    settings::saved(&mut s, "null", Ok(next));
    let p = settings::agent(&s).unwrap();
    assert_eq!(settings::value(&s, panel(&s), &p, Row::Reasoning).unwrap(), "xhigh");
    assert!(matches!(key(&mut s, KeyCode::Right), Intent::Panel(PanelIntent::Save { .. })));
    // A refused save keeps the old value and shows why.
    settings::saved(&mut s, "null", Err("no participant with the id `null` is in this chat".into()));
    assert!(panel(&s).error.as_deref().unwrap().contains("no participant"));
    assert_eq!(settings::value(&s, panel(&s), &settings::agent(&s).unwrap(), Row::Reasoning).unwrap(), "xhigh");
    key(&mut s, KeyCode::Esc);
    assert!(s.settings.is_some(), "first Esc clears the error");
}

#[test]
fn model_change_drops_reasoning_the_new_model_does_not_take() {
    let mut s = state("work", json!([]));
    settings::open(&mut s, Some(Row::Model), Some("null".into()));
    assert_eq!(key(&mut s, KeyCode::Right), Intent::Panel(PanelIntent::None), "no list yet");
    let p = settings::agent(&s).unwrap();
    let list = settings::parse_models(&p, &json!([{"id":"gpt-5.5","efforts":["low","high"]},{"id":"mini","efforts":["low"]}]));
    assert_eq!(list[0], ModelOption { id: None, label: "Default".into(), efforts: None });
    s.settings.as_mut().unwrap().models.insert("null".into(), list);
    assert_eq!(
        key(&mut s, KeyCode::Right),
        Intent::Panel(PanelIntent::Save {
            agent: "null".into(),
            change: Change { model: Some(Some("mini".into())), effort: Some(None), ..Change::default() }
        })
    );
    // Reasoning lists only the current model's levels.
    let panel = panel(&s);
    assert_eq!(settings::efforts(panel, &p), Some(vec!["low".to_string(), "high".to_string()]));
}

#[test]
fn rows_that_cannot_change_ignore_arrows() {
    let mut s = state("chat", json!([]));
    settings::open(&mut s, Some(Row::Access), Some("null".into()));
    key(&mut s, KeyCode::Right);
    assert_eq!(panel(&s).pending_access, None, "chats stay Read");
    let p = settings::agent(&s).unwrap();
    assert_eq!(settings::value(&s, panel(&s), &p, Row::Access), Err("Read · talk-only chat"));
    settings::open(&mut s, Some(Row::Speed), Some("tool".into()));
    assert_eq!(key(&mut s, KeyCode::Right), Intent::Panel(PanelIntent::None));
    let tool = settings::agent(&s).unwrap();
    assert_eq!(settings::value(&s, panel(&s), &tool, Row::Speed), Err("not offered"));
    assert_eq!(settings::value(&s, panel(&s), &tool, Row::Reasoning), Err("not offered"));
}

#[test]
fn requests_match_host_contracts() {
    let p = agents()[0].clone();
    let speed = Change { speed: Some(Some("fast".into())), ..Change::default() };
    let (cmd, args) = settings::request("r", false, &p, &speed).unwrap();
    assert_eq!(cmd, "room_update_participant");
    assert_eq!(args["base"], p, "base is the participant as last received");
    assert_eq!(args["participant"]["speed"], "fast");
    assert_eq!(args["participant"]["backend"], p["backend"]);
    let (cmd, args) = settings::request("r", true, &p, &speed).unwrap();
    assert_eq!(cmd, "chat_update_participant");
    assert_eq!(args["patch"], json!({"speed":"fast"}));
    assert!(settings::request("r", true, &p, &Change { access: Some("full".into()), ..Change::default() }).is_err());
    // Default speed removes the field so the tool's own setting applies.
    let mut fast = p.clone();
    fast["speed"] = json!("fast");
    let cleared = settings::apply(&fast, &Change { speed: Some(None), ..Change::default() });
    assert!(cleared.get("speed").is_none());
}

#[test]
fn speed_rule_matches_desktop() {
    let api = |url: &str| json!({"backend":{"kind":"open_ai_compatible","base_url":url,"model":"m"}});
    assert!(settings::speed_ok(&api("https://api.openai.com/v1")));
    assert!(settings::speed_ok(&api("https://api.openai.com/v1/")));
    assert!(!settings::speed_ok(&api("https://api.venice.ai/v1")));
    assert!(!settings::speed_ok(&json!({"backend":{"kind":"agent","tool":"gemini"}})));
    assert!(settings::speed_ok(&json!({"backend":{"kind":"agent","tool":"claude_code"}})));
}

#[test]
fn switching_threads_closes_panel() {
    let mut s = state("work", json!([]));
    shift_tab(&mut s);
    s.select("other".into());
    assert!(s.settings.is_none());
}

#[test]
fn esc_in_model_list_returns_to_panel_and_never_stops_agents() {
    let mut s = state("work", json!(["null"]));
    settings::open(&mut s, Some(Row::Model), Some("null".into()));
    let p = settings::agent(&s).unwrap();
    let list = settings::parse_models(&p, &json!([{"id":"gpt-5.5"},{"id":"mini"}]));
    s.settings.as_mut().unwrap().models.insert("null".into(), list);
    assert_eq!(key(&mut s, KeyCode::Enter), Intent::Panel(PanelIntent::ModelMenu("null".into())));
    s.menu = Some(apex_cli::state::Menu { title: "Model · this thread".into(), choices: vec![], selected: 0, completion: false });
    assert_eq!(key(&mut s, KeyCode::Esc), Intent::Panel(PanelIntent::None), "Esc must not stop work");
    assert!(s.menu.is_none(), "model list closed");
    assert!(s.settings.is_some(), "panel still open");
}

#[test]
fn closing_and_reopening_the_panel_keeps_the_save_in_flight() {
    let mut s = state("work", json!([]));
    settings::open(&mut s, Some(Row::Reasoning), Some("null".into()));
    assert!(matches!(key(&mut s, KeyCode::Right), Intent::Panel(PanelIntent::Save { .. })));
    shift_tab(&mut s);
    assert!(s.settings.is_none());
    settings::open(&mut s, Some(Row::Reasoning), Some("null".into()));
    assert_eq!(settings::saving(&s, "null"), Some(Row::Reasoning));
    assert_eq!(key(&mut s, KeyCode::Right), Intent::Panel(PanelIntent::None), "no overlapping save");
    // A reply arriving while the panel is closed still ends the save.
    shift_tab(&mut s);
    let p = s.members().into_iter().find(|p| p["id"] == "null").unwrap();
    settings::saved(&mut s, "null", Ok(p));
    settings::open(&mut s, Some(Row::Reasoning), Some("null".into()));
    assert!(matches!(key(&mut s, KeyCode::Right), Intent::Panel(PanelIntent::Save { .. })));
}

#[test]
fn reconnect_during_a_save_clears_saving_and_allows_new_changes() {
    let mut s = state("work", json!([]));
    settings::open(&mut s, Some(Row::Reasoning), Some("null".into()));
    assert!(matches!(key(&mut s, KeyCode::Right), Intent::Panel(PanelIntent::Save { .. })));
    // A reconnect bumps the generation; the runtime then drops the old reply.
    s.generation += 1;
    assert_eq!(settings::saving(&s, "null"), None, "no stuck saving…");
    assert!(matches!(key(&mut s, KeyCode::Right), Intent::Panel(PanelIntent::Save { .. })));
    // The model list is asked for again on the new connection.
    let panel = s.settings.as_mut().unwrap();
    assert!(settings::needs_models(panel, 1, "null"));
    assert!(!settings::needs_models(panel, 1, "null"), "only once per connection");
    assert!(settings::needs_models(panel, 2, "null"), "a reconnect asks again");
}
