//! `apex-daemon --stdio` running the host in its own process.

mod common;

use common::*;
use serde_json::json;

#[test]
fn a_chat_a_terminal_an_approval_and_a_restart_over_stdio() {
    let data = temp_dir();
    let mut first = StdioClient::spawn(&["--stdio"], &data.0);
    let hello = first.hello(None);
    assert_eq!((hello["protocol"].clone(), hello["resumed"].clone()), (json!(1), json!(false)));
    assert_eq!(hello["host_id"].as_str().unwrap().len(), 32);
    chat_terminal_and_approval(&mut first);
    first.close_input();
    assert!(first.wait().success());
    assert!(first.stderr().contains("stops when this connection closes"));

    // A restart brings the chat and the session back, under a new boot id.
    let mut second = StdioClient::spawn(&["--stdio"], &data.0);
    let again = second.hello(Some(json!({ "boot_id": hello["boot_id"], "seq": 0 })));
    assert_eq!(again["host_id"], hello["host_id"]);
    assert_ne!(again["boot_id"], hello["boot_id"]);
    assert_eq!(again["resumed"], false);
    chat_restored(&mut second);
    second.close_input();
    assert!(second.wait().success());
}

/// A program the host starts (here `open_target`'s opener) shares the
/// daemon's stdout; what it prints must not land in the protocol.
#[test]
fn output_from_programs_the_host_starts_stays_out_of_the_protocol() {
    let data = temp_dir();
    let bin = data.0.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    for name in ["open", "xdg-open"] {
        let path = bin.join(name);
        std::fs::write(&path, "#!/bin/sh\necho stray-output-from-a-child\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap_or_default());
    let mut client = StdioClient::spawn_with(&["--stdio"], &data.0, &[("PATH", path)]);
    client.hello(None);
    assert_eq!(client.call("open_target", json!({ "target": data.0.to_string_lossy(), "cwd": null })).1, Ok(json!(null)));
    client.process.wait_for_log("stray-output-from-a-child");
    assert_eq!(client.call("session_load", json!({})).1, Ok(json!(null)));
}

/// The daemon's own arguments (its --data-dir, say) are not folders for a
/// client to open as workspaces.
#[test]
fn the_daemon_has_no_startup_folders() {
    let data = temp_dir();
    std::fs::create_dir_all(&data.0).unwrap();
    let mut client = StdioClient::spawn(&["--stdio"], &data.0);
    client.hello(None);
    assert_eq!(client.call("startup_folders", json!({})).1, Ok(json!([])));
}
