//! Compiling test support never opts the regular daemon into image fixtures.
mod common;
use serde_json::json;
use std::{
    io::Write,
    process::{Command, Stdio},
};
fn temp_dir()->common::TempDir{static NEXT:std::sync::atomic::AtomicUsize=std::sync::atomic::AtomicUsize::new(0);common::TempDir(std::env::temp_dir().join(format!("avatar-boundary-{}-{}",std::process::id(),NEXT.fetch_add(1,std::sync::atomic::Ordering::SeqCst))))}
#[test]
fn regular_daemon_with_test_support_never_registers_the_image_fixture() {
    let data = temp_dir();
    std::fs::create_dir_all(&data.0).unwrap();
    std::fs::write(data.0.join("host-id"), "production-boundary-host").unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_apex-daemon"))
        .arg("--stdio")
        .arg("--data-dir")
        .arg(&data.0)
        .env("APEX_DECK_FIXTURE_IMAGES", "1")
        .env("APEX_DECK_TEST_SUPPORT", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let frames = [
        json!({"id":0,"cmd":"hello","args":{"protocol":1}}),
        json!({"id":1,"cmd":"personal_avatar_options","args":{"owner":{"kind":"creation","hostId":"production-boundary-host","draftId":"draft"}}}),
    ];
    if let Some(mut input) = child.stdin.take() {
        for frame in frames {
            let _ = writeln!(input, "{frame}");
        }
    }
    let output = child.wait_with_output().unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        !stdout.contains("fixture-avatar-provider"),
        "regular daemon exposed a deterministic adapter: {stdout}"
    );
    assert!(
        !data.0.join("assistant-avatars/dispatch").exists(),
        "regular daemon created an image dispatch fixture"
    );
    let main = include_str!("../src/main.rs");
    assert!(
        !main.contains("test_support"),
        "regular daemon main must not opt into fixtures"
    );
}
#[test]
fn fixture_binary_explicitly_registers_deterministic_images() {
    let data = temp_dir();
    let mut fixture = common::StdioClient::spawn(&["--stdio"], &data.0);
    let hello = fixture.hello(None);
    let result = fixture
        .call(
            "personal_avatar_options",
            json!({"owner":{"kind":"creation","hostId":hello["host_id"],"draftId":"draft"}}),
        )
        .1
        .unwrap();
    assert_eq!(
        result["options"][0]["providerProfileId"],
        "fixture-avatar-provider"
    );
    assert_eq!(result["options"][0]["modelId"], "fixture-avatar-image");
    fixture.close_input();
    assert!(fixture.wait().success());
}
