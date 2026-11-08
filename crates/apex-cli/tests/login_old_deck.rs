use apex_cli::runtime::host_lacks_provider_setup;

#[test]
fn old_deck_unknown_variant_is_detected() {
    let err = "invalid request: unknown variant `provider_setup_begin`, expected one of `ping`, `room_state`, `room_send`";
    assert!(host_lacks_provider_setup(err));
}

#[test]
fn real_login_errors_are_shown_as_is() {
    assert!(!host_lacks_provider_setup("claude not found on PATH"));
    assert!(!host_lacks_provider_setup("unknown variant `room_foo`, expected one of `ping`"));
    assert!(!host_lacks_provider_setup("provider_setup_begin failed: codex exited 1"));
}
