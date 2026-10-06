use apex_core::decision::routing_request;
use apex_core::{ParticipantId, Message, Speaker};
#[test]
fn dynamic_choices_and_current_message_first_with_bounded_state() {
    let messages = vec![Message { at: None, seq: 0, servers: vec![], speaker: Speaker::Human, text: "old".repeat(10000) }, Message { at: None, seq: 0, servers: vec![], speaker: Speaker::Human, text: "current".into() }];
    let request = routing_request(&messages, &[ParticipantId::new("nobody"), ParticipantId::new("third")]);
    assert!(request.state.starts_with("Current message"));
    assert!(request.state.contains("current"));
    assert!(request.state.chars().count() <= 6000);
    assert!(request.questions["who_replies"]["criteria"].get("bot_0").is_some());
    assert!(request.questions["who_replies"]["criteria"].get("all").is_some());
}

#[test]
fn appended_bot_reply_is_valid_but_rewind_and_new_human_are_stale() {
    use apex_core::decision::observation_is_current;
    let message = |speaker, text: &str| Message { at: None, seq: 0, servers: vec![], speaker, text: text.into() };
    let before = vec![message(Speaker::Human, "first")];
    assert!(observation_is_current(&before, &[before[0].clone(), message(Speaker::Bot(ParticipantId::new("a")), "answer")]));
    assert!(!observation_is_current(&before, &[]));
    assert!(!observation_is_current(&before, &[message(Speaker::Human, "replacement")]));
    assert!(!observation_is_current(&before, &[before[0].clone(), message(Speaker::Human, "steer")]));
}
