//! The desktop asks the daemon for its local transport address.
mod common;

use std::process::Command;

#[test]
fn endpoint_uses_the_same_data_dir_resolution_before_or_after_the_action() {
    let data = common::temp_dir();
    let expected = apex_daemon::ipc::endpoint(&data.0).unwrap();
    for before in [false, true] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_apex-daemon"));
        if before {
            command.arg("--data-dir").arg(&data.0).arg("endpoint");
        } else {
            command.arg("endpoint").arg("--data-dir").arg(&data.0);
        }
        let output = command.output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert_eq!(String::from_utf8(output.stdout).unwrap().trim_end(), expected.to_str().unwrap());
    }
}

#[test]
fn endpoint_rejects_serve_and_stdio_options() {
    for args in [["endpoint", "serve"], ["endpoint", "--attach"], ["endpoint", "--remote"]] {
        let output = Command::new(env!("CARGO_BIN_EXE_apex-daemon")).args(args).output().unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
    }
}
