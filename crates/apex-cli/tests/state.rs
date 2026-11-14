use apex_cli::state::AppState;
use serde_json::json;
#[test]
fn older_snapshot_is_ignored_and_new_boot_discards_old_room_events() {
    let mut s = AppState::default();
    s.select("r".into());
    let state = json!({"recovery_seq":100,"snapshot":{"transcript":[]},"active":[]});
    s.install_snapshot("r", s.generation, state);
    assert!(!s.install_snapshot(
        "r",
        s.generation,
        json!({"recovery_seq":99,"snapshot":{"transcript":[]},"active":[]})
    ));
    s.apply_event(json!({"seq":101,"payload":{"room":"r","recovery_seq":101,"event":{"type":"turn_started","id":"old"}}}));
    s.reset_connection_state();
    assert!(s.install_snapshot(
        "r",
        s.generation,
        json!({"recovery_seq":0,"snapshot":{"transcript":[]},"active":[]})
    ));
    assert_eq!(s.current().unwrap()["active"], json!([]));
}
#[test]
fn room_identity_cursor_and_selection_generation_prevent_cross_thread_corruption() {
    let mut s = AppState::default();
    s.select("a".into());
    let old = s.generation;
    s.select("b".into());
    assert!(!s.install_snapshot("a", old, json!({"snapshot":{"transcript":[]}})));
    s.apply_event(json!({"seq":1,"payload":{"room":"a","recovery_seq":1,"event":{"type":"delta","id":"null","text":"old"}}}));
    assert!(s.current().is_none());
    assert!(s.install_snapshot(
        "b",
        s.generation,
        json!({"recovery_seq":2,"snapshot":{"transcript":[]},"active":["null"]})
    ));
    s.apply_event(json!({"seq":2,"payload":{"room":"b","recovery_seq":3,"event":{"type":"delta","id":"null","text":"new"}}}));
    s.apply_event(json!({"seq":2,"payload":{"room":"b","recovery_seq":3,"event":{"type":"delta","id":"null","text":"new"}}}));
    assert_eq!(s.streams.get("null").unwrap(), "new");
}
#[test]
fn snapshot_race_preserves_newer_event_without_doubling_stream() {
    let mut s = AppState::default();
    s.select("r".into());
    let state = json!({"recovery_seq":0,"snapshot":{"transcript":[]},"active":[]});
    s.install_snapshot("r", s.generation, state.clone());
    s.apply_event(json!({"seq":1,"payload":{"room":"r","recovery_seq":1,"event":{"type":"turn_started","id":"bot"}}}));
    s.apply_event(json!({"seq":2,"payload":{"room":"r","recovery_seq":2,"event":{"type":"delta","id":"bot","text":"once"}}}));
    s.install_snapshot("r", s.generation, state);
    assert_eq!(s.streams["bot"], "once");
    assert_eq!(s.current().unwrap()["active"], json!(["bot"]));
}
#[test]
fn event_overflow_disables_mutations_until_authoritative_reload() {
    let mut s = AppState::default();
    s.select("r".into());
    s.connected = true;
    for seq in 1..2052 {
        s.apply_event(json!({"seq":seq,"payload":{"room":"r","recovery_seq":seq,"event":{"type":"activity","id":"bot","text":"working"}}}));
    }
    assert!(s.overflowed);
    assert!(!s.connected);
    s.install_snapshot(
        "r",
        s.generation,
        json!({"recovery_seq":2052,"snapshot":{"transcript":[]},"active":[]}),
    );
    assert!(!s.overflowed);
}
fn ev(seq: u64, room: &str, event: serde_json::Value) -> serde_json::Value {
    json!({"seq":seq,"payload":{"room":room,"recovery_seq":seq,"event":event}})
}
#[test]
fn switching_away_and_back_restores_partial_reply_and_working_agents() {
    let mut s = AppState::default();
    s.select("a".into());
    s.install_snapshot("a", s.generation, json!({"recovery_seq":0,"snapshot":{"transcript":[]},"active":[]}));
    s.apply_event(ev(1, "a", json!({"type":"turn_started","id":"null"})));
    s.apply_event(ev(2, "a", json!({"type":"turn_started","id":"muck"})));
    s.apply_event(ev(3, "a", json!({"type":"delta","id":"null","text":"Half "})));
    s.select("b".into());
    // Work continues while the user is on thread B; the CLI ignores it.
    s.apply_event(ev(4, "a", json!({"type":"delta","id":"null","text":"done"})));
    s.select("a".into());
    // Coming back: the host's snapshot already holds everything up to 4.
    let gen = s.generation;
    s.apply_event(ev(5, "a", json!({"type":"delta","id":"null","text":"!"})));
    assert!(s.install_snapshot("a", gen, json!({
        "recovery_seq":4,"snapshot":{"transcript":[]},"active":["muck","null"],
        "streams":{"null":"Half done"},"activity":{"muck":"Running tests"}
    })));
    assert_eq!(s.streams["null"], "Half done!", "restored text plus newer delta, nothing doubled");
    assert_eq!(s.activity["muck"], "Running tests");
    let mut working = s.working();
    working.sort();
    assert_eq!(working, vec!["muck", "null"], "both agents still show as working");
    s.apply_event(ev(6, "a", json!({"type":"delta","id":"null","text":" more"})));
    assert_eq!(s.streams["null"], "Half done! more", "streaming continues after the return");
    s.apply_event(ev(7, "a", json!({"type":"participant_idle","id":"muck"})));
    assert_eq!(s.working(), vec!["null"], "a finished agent stops showing as working");
    assert!(s.activity.get("muck").is_none());
    s.apply_event(ev(8, "a", json!({"type":"failed","id":"null","error":"boom"})));
    assert!(s.working().is_empty());
    assert!(s.streams.is_empty());
}
#[test]
fn returning_to_a_busy_thread_on_an_older_host_still_shows_working() {
    let mut s = AppState::default();
    s.select("a".into());
    // Older hosts report who is busy but not their partial text.
    s.install_snapshot("a", s.generation, json!({"recovery_seq":3,"snapshot":{"transcript":[]},"active":["null"]}));
    assert_eq!(s.working(), vec!["null"]);
    assert!(s.streams.is_empty());
}
#[test]
fn stale_snapshot_after_return_cannot_undo_newer_progress() {
    let mut s = AppState::default();
    s.select("a".into());
    let gen = s.generation;
    s.install_snapshot("a", gen, json!({"recovery_seq":5,"snapshot":{"transcript":[]},"active":["null"],"streams":{"null":"abc"},"activity":{}}));
    s.apply_event(ev(6, "a", json!({"type":"delta","id":"null","text":"d"})));
    assert!(!s.install_snapshot("a", gen, json!({"recovery_seq":4,"snapshot":{"transcript":[]},"active":["null"],"streams":{"null":"ab"},"activity":{}})));
    assert_eq!(s.streams["null"], "abcd");
}
#[test]
fn delayed_delta_already_in_restored_snapshot_is_not_doubled() {
    let mut s = AppState::default();
    s.select("a".into());
    let gen = s.generation;
    assert!(s.install_snapshot("a", gen, json!({"recovery_seq":2,"snapshot":{"transcript":[]},"active":["null"],"streams":{"null":"ab"},"activity":{}})));
    // The delta that produced "b" was numbered 2; it arrives after the snapshot.
    s.apply_event(ev(9, "a", json!({"type":"delta","id":"null","text":"b"})).tap_recovery(2));
    assert_eq!(s.streams["null"], "ab");
    s.apply_event(ev(10, "a", json!({"type":"delta","id":"null","text":"c"})).tap_recovery(3));
    assert_eq!(s.streams["null"], "abc");
}
#[test]
fn reinstalling_a_delayed_snapshot_after_replay_cannot_rewind_text() {
    let mut s = AppState::default();
    s.select("a".into());
    let gen = s.generation;
    // A newer event lands before the (older) snapshot reply.
    s.apply_event(ev(2, "a", json!({"type":"delta","id":"null","text":"b"})));
    let delayed = json!({"recovery_seq":1,"snapshot":{"transcript":[]},"active":["null"],"streams":{"null":"a"},"activity":{}});
    assert!(s.install_snapshot("a", gen, delayed.clone()));
    assert_eq!(s.streams["null"], "ab");
    assert!(!s.install_snapshot("a", gen, delayed));
    assert_eq!(s.streams["null"], "ab");
}
#[test]
fn watermark_resets_when_switching_threads_and_on_reconnect() {
    let mut s = AppState::default();
    s.select("a".into());
    s.install_snapshot("a", s.generation, json!({"recovery_seq":5,"snapshot":{"transcript":[]},"active":["null"],"streams":{"null":"x"},"activity":{}}));
    s.reset_connection_state();
    // New daemon boot restarts numbering: a lower snapshot must be accepted.
    assert!(s.install_snapshot("a", s.generation, json!({"recovery_seq":1,"snapshot":{"transcript":[]},"active":["null"],"streams":{"null":"y"},"activity":{}})));
    assert_eq!(s.streams["null"], "y");
}
trait TapRecovery { fn tap_recovery(self, n: u64) -> Self; }
impl TapRecovery for serde_json::Value {
    fn tap_recovery(mut self, n: u64) -> Self { self["payload"]["recovery_seq"] = json!(n); self }
}
#[test]
fn a_failed_turn_tells_the_person_why() {
    let mut s = AppState::default();
    s.select("a".into());
    s.install_snapshot("a", s.generation, json!({"recovery_seq":1,"snapshot":{"transcript":[],"participants":[{"id":"clyde","name":"Clyde"}]},"active":["clyde"]}));
    s.apply_event(json!({"seq":2,"payload":{"room":"a","recovery_seq":2,"event":{"type":"failed","id":"clyde","error":"Not logged in\n  · Please run /login"}}}));
    assert!(s.working().is_empty());
    assert_eq!(s.notice, "Clyde couldn't reply: Not logged in · Please run /login");
    s.apply_event(json!({"seq":3,"payload":{"room":"a","recovery_seq":3,"event":{"type":"failed","id":"ghost","error":""}}}));
    assert_eq!(s.notice, "ghost couldn't reply.");
    // Seen live on Linux 0.9.12: the jail's expired-login wording must also point at /login.
    s.apply_event(json!({"seq":4,"payload":{"room":"a","recovery_seq":4,"event":{"type":"failed","id":"clyde","error":"Claude’s connection needs refreshing. Refresh its sign-in in Claude, then retry. Apex Deck has not changed the login."}}}));
    assert!(s.notice.ends_with(" · Run /login to sign in again."), "{}", s.notice);
}
#[test]
fn live_approvals_and_questions_reach_the_open_thread() {
    let mut s = AppState::default();
    s.select("r".into());
    s.install_snapshot("r", s.generation, json!({"recovery_seq":0,"snapshot":{"transcript":[]},"active":["bot"],"approvals":[],"questions":[]}));
    let ev = |seq: u64, event: serde_json::Value| json!({"seq":seq,"payload":{"room":"r","recovery_seq":seq,"event":event}});
    s.apply_event(ev(1, json!({"type":"approval_requested","id":"bot","request":"a1","action":{"kind":"command","detail":"ls"}})));
    s.apply_event(ev(2, json!({"type":"question_requested","id":"bot","request":"q1","questions":[{"question":"Which?"}]})));
    assert_eq!(s.pending_requests(), 2);
    assert_eq!(s.current().unwrap()["approvals"][0]["request"], "a1");
    s.apply_event(ev(3, json!({"type":"approval_resolved","id":"bot","request":"a1","approved":true})));
    assert_eq!(s.current().unwrap()["approvals"], json!([]));
    s.apply_event(ev(4, json!({"type":"participant_idle","id":"bot"})));
    assert_eq!(s.pending_requests(), 0);
}
#[test]
fn restored_requests_are_announced_once_and_never_steal_a_draft_or_menu() {
    let blocked = || json!({"recovery_seq":3,"snapshot":{"transcript":[]},"active":["bot"],"approvals":[{"id":"bot","request":"a1","action":{}}],"questions":[]});
    // Reopening a thread that is already blocked opens the list.
    let mut s = AppState::default();
    s.select("r".into());
    assert!(s.install_snapshot("r", s.generation, blocked()));
    assert!(s.announce_requests(false));
    // Refreshing the same snapshot does not reopen it.
    assert!(s.install_snapshot("r", s.generation, blocked()));
    assert!(!s.announce_requests(false));
    // Reconnecting to a fresh backend announces it again.
    s.connected(&json!({"boot_id":"b1","last_seq":3,"resumed":false}));
    assert!(s.install_snapshot("r", s.generation, blocked()));
    assert!(s.announce_requests(false));
    // A same-backend reconnect that resumes replay keeps the live view but
    // still reminds the person after the reload.
    s.connected(&json!({"boot_id":"b1","last_seq":3,"resumed":true}));
    assert!(s.current().is_some(), "resumed replay keeps room state");
    assert_eq!(s.cursor.as_ref().unwrap().boot_id, "b1");
    assert!(s.install_snapshot("r", s.generation, blocked()));
    assert!(s.announce_requests(false));
    // Switching away and back announces it again.
    s.select("other".into());
    s.select("r".into());
    assert!(s.install_snapshot("r", s.generation, blocked()));
    assert!(s.announce_requests(false));

    // A draft, open menu, settings panel or answer in progress gets a notice instead.
    let mut s = AppState::default();
    s.select("r".into());
    s.editor.insert("half typed");
    s.install_snapshot("r", s.generation, blocked());
    assert!(!s.announce_requests(false));
    assert!(s.notice.contains("F2 Requests"));
    assert_eq!(s.editor.text, "half typed");
    let mut s = AppState::default();
    s.select("r".into());
    s.menu = Some(apex_cli::state::Menu { title: "x".into(), choices: vec![], selected: 0, completion: false });
    s.install_snapshot("r", s.generation, blocked());
    assert!(!s.announce_requests(false));
    assert!(s.menu.as_ref().is_some_and(|m| m.title == "x"));
    let mut s = AppState::default();
    s.select("r".into());
    let mut with_agent = blocked();
    with_agent["snapshot"]["participants"] = json!([{"id":"bot"}]);
    s.install_snapshot("r", s.generation, with_agent);
    apex_cli::settings::open(&mut s, None, None);
    assert!(s.settings.is_some(), "settings panel opened");
    assert!(!s.announce_requests(false));
    assert!(s.settings.is_some() && s.notice.contains("F2 Requests"));
    let mut s = AppState::default();
    s.select("r".into());
    s.install_snapshot("r", s.generation, blocked());
    assert!(!s.announce_requests(true));
    assert!(s.notice.contains("F2 Requests"));

    // A request that arrives before the first snapshot is announced once it loads.
    let mut s = AppState::default();
    s.select("r".into());
    s.apply_event(json!({"seq":4,"payload":{"room":"r","recovery_seq":4,"event":{"type":"approval_requested","id":"bot","request":"a2","action":{}}}}));
    assert!(!s.announce_requests(false));
    assert!(s.install_snapshot("r", s.generation, json!({"recovery_seq":3,"snapshot":{"transcript":[]},"active":["bot"],"approvals":[],"questions":[]})));
    assert_eq!(s.pending_requests(), 1);
    assert!(s.announce_requests(false));
    // One answered and a different one raised at the same time still counts as new.
    s.apply_event(json!({"seq":5,"payload":{"room":"r","recovery_seq":5,"event":{"type":"approval_resolved","id":"bot","request":"a2","approved":true}}}));
    s.apply_event(json!({"seq":6,"payload":{"room":"r","recovery_seq":6,"event":{"type":"question_requested","id":"bot","request":"q9","questions":[{"question":"?"}]}}}));
    assert!(s.announce_requests(false));
}
#[test]
fn replying_to_a_waiting_agent_is_never_blocked_by_a_pending_message() {
    use apex_cli::state::Action;
    // A Work-thread message stays "sending" until the agent's turn ends, and
    // the turn can't end until its request is answered. Approve, its confirm
    // step, Reject and question answers must all bypass that wait.
    let decide = |approve: bool, confirmation: Option<String>| Action::Rpc {
        cmd: "room_decide".into(),
        args: json!({"id":"w","request":"r1","approve":approve}),
        confirmation,
    };
    assert!(decide(true, Some("Approve this action?".into())).replies_to_agent());
    assert!(decide(true, None).replies_to_agent());
    assert!(decide(false, None).replies_to_agent());
    assert!(apex_cli::controller::rpc("room_answer", json!({"id":"w","request":"q1","answers":null})).replies_to_agent());
    // Ordinary thread changes still wait their turn.
    assert!(!apex_cli::controller::rpc("room_set_plan", json!({"id":"w","on":true})).replies_to_agent());
    assert!(!Action::Dismiss.replies_to_agent());
}
