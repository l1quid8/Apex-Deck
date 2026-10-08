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

#[test]
fn observer_only_asks_current_turn_questions() {
    let request = routing_request(&[], &[ParticipantId::new("a")]);
    assert_eq!(request.questions.len(), 2);
    assert!(!request.questions.contains_key("duplicate_reply"));
}

#[test]
fn observer_cuts_busy_replies_and_uses_chat_speakers() {
    let message = |speaker, text: &str| Message { at: None, seq: 0, servers: vec![], speaker, text: text.into() };
    let messages = vec![
        message(Speaker::Bot(ParticipantId::new("jigga")), "previous"),
        message(Speaker::Human, "current request"),
        message(Speaker::Bot(ParticipantId::new("jigga")), "racing reply"),
    ];
    let request = routing_request(&messages, &[ParticipantId::new("jigga")]);
    assert!(request.state.contains("[Human]: current request"));
    assert!(request.state.contains("[@jigga]: previous"));
    assert!(!request.state.contains("racing reply"));
    assert!(!request.state.contains("ParticipantId"));
}

#[test]
fn thinking_question_includes_hard_short_prompts_and_bot_handoffs() {
    use apex_core::decision::thinking_request;
    let messages = vec![Message { at: None, seq: 0, servers: vec![], speaker: Speaker::Bot(ParticipantId::new("jigga")), text: "@null build it".into() }];
    let request = thinking_request(&messages, &[ParticipantId::new("null")]);
    assert!(request.state.contains("[@jigga]: @null build it"));
    assert_eq!(request.questions["thinking"]["criteria"].as_object().unwrap().len(), 3);
    assert!(request.questions["thinking"]["instructions"].as_str().unwrap().contains("length"));
}

#[test]
fn auto_trial_fallback_confidence_fixed_and_unsupported_models() {
    use apex_core::decision::{chosen_effort, ThinkingDecision};
    use serde_json::json;
    let mut bot: apex_core::ParticipantConfig = serde_json::from_value(json!({"id":"null","display_name":"Null","backend":{"kind":"agent","tool":"codex"},"effort":"ultra","auto_effort":true})).unwrap();
    let pick = ThinkingDecision { choice:"low".into(), probabilities: [("low".into(),0.6),("medium".into(),0.3),("high".into(),0.1)].into() };
    assert_eq!(chosen_effort(&bot, Some(&pick), false, ""), Some("ultra".into()));
    assert_eq!(chosen_effort(&bot, Some(&pick), true, ""), Some("low".into()));
    assert_eq!(chosen_effort(&bot, None, true, ""), Some("ultra".into()));
    let uncertain = ThinkingDecision { choice:"low".into(), probabilities: [("low".into(),0.4),("medium".into(),0.35),("high".into(),0.25)].into() };
    assert_eq!(chosen_effort(&bot, Some(&uncertain), true, ""), Some("ultra".into()));
    assert_eq!(chosen_effort(&bot, Some(&pick), true, "think hard"), Some("high".into()));
    assert_eq!(chosen_effort(&bot, None, true, "quick answer"), Some("low".into()));
    bot.auto_effort = false;
    assert_eq!(chosen_effort(&bot, Some(&pick), true, ""), None);
    bot.auto_effort = true;
    for model in ["haiku", "claude-haiku-4-5", "claude-sonnet-4-5"] {
        bot.backend = apex_core::Backend::Agent { tool: apex_core::AgentTool::ClaudeCode, model:Some(model.into()) };
        assert_eq!(chosen_effort(&bot, Some(&pick), true, ""), None);
    }
}
