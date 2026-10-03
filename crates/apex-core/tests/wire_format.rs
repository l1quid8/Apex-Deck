//! The JSON shapes the UI depends on. If one of these tests fails, update
//! `src/types.ts` to match.

use apex_core::{
    Access, AgentTool, Backend, Message, ModelChoice, ParticipantConfig, ParticipantId, RoomEvent, RoomOptions,
    Speaker, TurnPolicy,
};
use serde_json::{json, to_value};

#[test]
fn participant_config_shapes() {
    let api = ParticipantConfig {
        id: ParticipantId::new("opus"),
        display_name: "Opus".into(),
        backend: Backend::OpenAiCompatible {
            base_url: "http://localhost:11434/v1".into(),
            model: "m".into(),
            api_key_env: None,
        },
        persona: "Be brief.".into(),
        access: Access::Edits,
        effort: Some("high".into()),
        appearance: None,
    };
    assert_eq!(
        to_value(&api).unwrap(),
        json!({
            "id": "opus",
            "display_name": "Opus",
            "backend": {
                "kind": "open_ai_compatible",
                "base_url": "http://localhost:11434/v1",
                "model": "m",
                "api_key_env": null
            },
            "persona": "Be brief.",
            "access": "edits",
            "effort": "high"
        })
    );

    let cli = Backend::Cli { program: "claude".into(), args: vec!["-p".into()] };
    assert_eq!(to_value(&cli).unwrap(), json!({ "kind": "cli", "program": "claude", "args": ["-p"] }));

    let agent = Backend::Agent { tool: AgentTool::ClaudeCode, model: Some("sonnet".into()) };
    assert_eq!(to_value(&agent).unwrap(), json!({ "kind": "agent", "tool": "claude_code", "model": "sonnet" }));
    assert_eq!(to_value(AgentTool::Codex).unwrap(), json!("codex"));
    assert_eq!(to_value(AgentTool::Gemini).unwrap(), json!("gemini"));
    let default_model: Backend = serde_json::from_value(json!({ "kind": "agent", "tool": "codex" })).unwrap();
    assert_eq!(default_model, Backend::Agent { tool: AgentTool::Codex, model: None });

    let scripted = Backend::Scripted { lines: vec!["hi".into()] };
    assert_eq!(to_value(&scripted).unwrap(), json!({ "kind": "scripted", "lines": ["hi"] }));
}

#[test]
fn participant_config_accepts_the_minimum_the_ui_sends() {
    let parsed: ParticipantConfig = serde_json::from_value(json!({
        "id": "cli",
        "display_name": "Tool",
        "backend": { "kind": "cli", "program": "mytool" }
    }))
    .unwrap();
    assert_eq!(parsed.access, Access::Read);
    assert_eq!(parsed.persona, "");
    assert_eq!(parsed.effort, None);
    assert_eq!(parsed.appearance, None);
    assert_eq!(parsed.backend, Backend::Cli { program: "mytool".into(), args: vec![] });
}

#[test]
fn saved_agent_appearance_survives_a_config_round_trip() {
    let value = json!({
        "id": "null",
        "display_name": "Null",
        "backend": { "kind": "agent", "tool": "codex" },
        "appearance": { "seed": "saved-random-seed", "color": "#2dd4bf" }
    });
    let parsed: ParticipantConfig = serde_json::from_value(value.clone()).unwrap();
    let saved = to_value(&parsed).unwrap();
    assert_eq!(saved["appearance"], value["appearance"]);
    let restored: ParticipantConfig = serde_json::from_value(saved).unwrap();
    assert_eq!(restored, parsed);
}

#[test]
fn room_options_shape() {
    let options = RoomOptions { policy: TurnPolicy::RoundRobin, max_bot_hops: 2 };
    assert_eq!(to_value(options).unwrap(), json!({ "policy": "round_robin", "max_bot_hops": 2 }));
    assert_eq!(to_value(TurnPolicy::Mention).unwrap(), json!("mention"));
    assert_eq!(to_value(TurnPolicy::Everyone).unwrap(), json!("everyone"));
}

#[test]
fn room_event_shapes() {
    let id = ParticipantId::new("opus");
    let human = Message { seq: 0, speaker: Speaker::Human, text: "hi".into() };
    let bot = Message { seq: 1, speaker: Speaker::Bot(id.clone()), text: "hello".into() };

    assert_eq!(
        to_value(RoomEvent::MessageAdded { message: human }).unwrap(),
        json!({ "type": "message_added", "message": { "seq": 0, "speaker": { "kind": "human" }, "text": "hi" } })
    );
    assert_eq!(
        to_value(RoomEvent::MessageAdded { message: bot }).unwrap(),
        json!({ "type": "message_added", "message": { "seq": 1, "speaker": { "kind": "bot", "id": "opus" }, "text": "hello" } })
    );
    assert_eq!(to_value(RoomEvent::TurnStarted { id: id.clone() }).unwrap(), json!({ "type": "turn_started", "id": "opus" }));
    assert_eq!(
        to_value(RoomEvent::Delta { id: id.clone(), text: "he".into() }).unwrap(),
        json!({ "type": "delta", "id": "opus", "text": "he" })
    );
    assert_eq!(
        to_value(RoomEvent::Activity { id: id.clone(), text: "Reading a.rs".into() }).unwrap(),
        json!({ "type": "activity", "id": "opus", "text": "Reading a.rs" })
    );
    assert_eq!(
        to_value(RoomEvent::Usage { id: id.clone(), input_tokens: Some(10), output_tokens: None }).unwrap(),
        json!({ "type": "usage", "id": "opus", "input_tokens": 10, "output_tokens": null })
    );
    let action = apex_core::ProposedAction { kind: apex_core::ActionKind::Command, title: "Run a command".into(), detail: "ls".into() };
    assert_eq!(
        to_value(RoomEvent::ApprovalRequested { id: id.clone(), request: "ask-1".into(), action }).unwrap(),
        json!({ "type": "approval_requested", "id": "opus", "request": "ask-1", "action": { "kind": "command", "title": "Run a command", "detail": "ls" } })
    );
    assert_eq!(
        to_value(RoomEvent::ApprovalResolved { id: id.clone(), request: "ask-1".into(), approved: false }).unwrap(),
        json!({ "type": "approval_resolved", "id": "opus", "request": "ask-1", "approved": false })
    );
    assert_eq!(
        to_value(RoomEvent::Changed { id: id.clone(), change: apex_core::FileChange::new("a.rs", "-x\n+y\n+z\n") }).unwrap(),
        json!({ "type": "changed", "id": "opus", "change": { "path": "a.rs", "diff": "-x\n+y\n+z\n", "added": 2, "removed": 1 } })
    );
    assert_eq!(to_value(Access::Ask).unwrap(), json!("ask"));
    assert_eq!(to_value(RoomEvent::Passed { id: id.clone() }).unwrap(), json!({ "type": "passed", "id": "opus" }));
    assert_eq!(
        to_value(RoomEvent::Failed { id, error: "boom".into() }).unwrap(),
        json!({ "type": "failed", "id": "opus", "error": "boom" })
    );
    assert_eq!(to_value(RoomEvent::HopLimitReached { limit: 3 }).unwrap(), json!({ "type": "hop_limit_reached", "limit": 3 }));
    assert_eq!(
        to_value(RoomEvent::Compacted { id: ParticipantId::new("opus"), summary: "s".into(), upto: 4 }).unwrap(),
        json!({ "type": "compacted", "id": "opus", "summary": "s", "upto": 4 })
    );
    assert_eq!(to_value(RoomEvent::Stopped).unwrap(), json!({ "type": "stopped" }));
    assert_eq!(to_value(RoomEvent::Idle).unwrap(), json!({ "type": "idle" }));
}

#[test]
fn model_choice_shape() {
    let known = ModelChoice { id: "m".into(), label: Some("Model".into()), efforts: Some(vec!["low".into()]) };
    assert_eq!(to_value(known).unwrap(), json!({ "id": "m", "label": "Model", "efforts": ["low"] }));
    let bare = ModelChoice { id: "m".into(), label: None, efforts: None };
    assert_eq!(to_value(bare).unwrap(), json!({ "id": "m", "label": null, "efforts": null }));
}
