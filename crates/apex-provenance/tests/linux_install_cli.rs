#![cfg(unix)]
use std::process::Command;

#[test]
fn staging_requires_explicit_complete_arguments_before_any_broker_operation() {
    let output = Command::new(env!("CARGO_BIN_EXE_apex-provenance"))
        .arg("stage-linux-release").output().unwrap();
    assert_eq!(output.status.code(),Some(1));
    let error=String::from_utf8_lossy(&output.stderr);
    assert!(error.contains("Usage: apex-provenance stage-linux-release"),"{error}");
}
