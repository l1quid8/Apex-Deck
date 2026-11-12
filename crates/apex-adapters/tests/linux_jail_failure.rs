//! Process-global sandbox failure injection must not race ordinary bot tests.
#![cfg(unix)]

use apex_adapters::linux_jail::{set_forced_for_test, set_state_for_test, should_jail, JailState};
use apex_core::{Access, Backend, Participant, ParticipantConfig, ParticipantId, Role, TurnRequest, ViewTurn};

#[tokio::test]
async fn launch_points_below_full_refuse_when_linux_jail_fails() {
    struct ResetJail;
    impl Drop for ResetJail {
        fn drop(&mut self) {
            set_forced_for_test(false);
            set_state_for_test(None);
        }
    }
    let _reset = ResetJail;
    set_forced_for_test(true);

    assert!(!should_jail(Access::Full));
    assert!(should_jail(Access::Read));
    assert!(should_jail(Access::Ask));
    assert!(should_jail(Access::Edits));
    set_state_for_test(Some(JailState::Fails("simulated sandbox fault".into())));

    let bot = apex_adapters::CliParticipant::new(ParticipantConfig {
        can_read_images: false,
        id: ParticipantId::new("bot"),
        display_name: "bot".into(),
        backend: Backend::Cli { program: "echo".into(), args: vec!["hi".into()] },
        persona: String::new(),
        access: Access::Read,
        effort: None,
        speed: None,
        voice: None,
        appearance: None,
        media: None,
    });
    let request = TurnRequest {
        computer: None,
        effort_override: None,
        access: None,
        system: "You are a test bot.".into(),
        turns: vec![ViewTurn { role: Role::User, content: "[User]: hi".into() }],
        unseen: vec![],
        plan: false,
        cwd: None,
    };
    let err = bot.respond(request, &|_| {}).await.unwrap_err();
    assert!(err.to_string().contains("simulated sandbox fault"), "got: {err}");

    let err = apex_adapters::claude_tool_servers(None, None).await.unwrap_err();
    assert!(err.contains("simulated sandbox fault"), "got: {err}");
    let err = apex_adapters::codex_tool_servers(None, None).await.unwrap_err();
    assert!(err.contains("simulated sandbox fault"), "got: {err}");
}
