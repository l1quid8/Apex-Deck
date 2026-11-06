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
