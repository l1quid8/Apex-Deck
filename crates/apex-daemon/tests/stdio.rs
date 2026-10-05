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

    // A chat: both messages arrive as events before room_post's reply.
    let (_, snapshot) = first.call("room_create", json!({ "id": "t1", "participants": [scripted("null", &["hello human"])], "options": options(), "cwd": null }));
    assert_eq!(snapshot.unwrap()["transcript"], json!([]));
    let (events, posted) = first.call("room_post", json!({ "id": "t1", "text": "@null hi" }));
    assert_eq!(posted, Ok(json!(null)));
    assert_eq!(added_texts(&events, "t1"), vec!["@null hi", "hello human"]);
    let seqs: Vec<u64> = events.iter().map(|e| e["seq"].as_u64().unwrap()).collect();
    assert!(seqs.windows(2).all(|w| w[1] == w[0] + 1), "numbered without gaps: {seqs:?}");

    // An approval answer with nothing waiting is refused.
    let (_, decided) = first.call("room_decide", json!({ "id": "t1", "request": "r-1", "approve": true }));
    assert_eq!(decided, Err("that request is no longer waiting for an answer".into()));

    // A terminal.
    first.call("pty_spawn", json!({ "id": "term", "agent": null, "cwd": null, "cols": 80, "rows": 24 })).1.unwrap();
    first.call("pty_write", json!({ "id": "term", "data": "echo apex-$((40+2))\n" })).1.unwrap();
    first.frames.until(|f| f["event"] == "pty-data" && f["payload"]["data"].as_str().unwrap_or_default().contains("apex-42"));
    first.call("pty_kill", json!({ "id": "term" })).1.unwrap();

    first.call("session_save", json!({ "session": { "version": 1, "panes": [{ "id": "t1", "kind": "chat" }] } })).1.unwrap();
    first.close_input();
    assert!(first.wait().success());
    assert!(first.stderr.lock().unwrap().contains("stops when this connection closes"));

    // A restart brings the chat and the session back, under a new boot id.
    let mut second = StdioClient::spawn(&["--stdio"], &data.0);
    let again = second.hello(Some(json!({ "boot_id": hello["boot_id"], "seq": 0 })));
    assert_eq!(again["host_id"], hello["host_id"]);
    assert_ne!(again["boot_id"], hello["boot_id"]);
    assert_eq!(again["resumed"], false);
    let (_, restored) = second.call("room_create", json!({ "id": "t1", "participants": [], "options": options(), "cwd": null }));
    let restored = restored.unwrap();
    let texts: Vec<&str> = restored["transcript"].as_array().unwrap().iter().filter_map(|m| m["text"].as_str()).collect();
    assert_eq!(texts, vec!["@null hi", "hello human"]);
    assert_eq!(second.call("session_load", json!({})).1, Ok(json!({ "version": 1, "panes": [{ "id": "t1", "kind": "chat" }] })));
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
    let start = std::time::Instant::now();
    while !client.stderr.lock().unwrap().contains("stray-output-from-a-child") {
        assert!(start.elapsed() < PATIENCE, "the opener never ran");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert_eq!(client.call("session_load", json!({})).1, Ok(json!(null)));
}
