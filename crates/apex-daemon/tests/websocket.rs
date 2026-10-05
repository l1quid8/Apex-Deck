//! `apex-daemon serve`: the localhost WebSocket.

mod common;

use std::os::unix::fs::PermissionsExt;

use common::*;
use serde_json::json;

#[test]
fn serve_writes_a_private_token_and_where_to_find_it() {
    let data = temp_dir();
    let served = Served::start(&data.0, &[]);
    assert!(served.port() > 0);
    assert_eq!(served.info["pid"], served.process.child.id());
    assert_eq!(served.info["protocol"], 1);
    let token = data.0.join("daemon-token");
    assert_eq!(std::fs::metadata(&token).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(std::fs::read_to_string(&token).unwrap().trim().len(), 64, "32 random bytes as hex");
}

#[test]
fn a_websocket_client_needs_the_token() {
    let data = temp_dir();
    let served = Served::start(&data.0, &[]);
    let token = std::fs::read_to_string(data.0.join("daemon-token")).unwrap().trim().to_string();

    let mut none = websocket(served.port());
    assert!(none.hello_frame(json!({}))["err"].as_str().unwrap().contains("token"));
    assert_eq!(none.frames.next(), None, "closed");

    let mut wrong = websocket(served.port());
    assert!(wrong.hello_frame(json!({ "token": "0".repeat(64) }))["err"].as_str().unwrap().contains("token"));
    assert_eq!(wrong.frames.next(), None, "closed");

    let mut right = websocket(served.port());
    assert_eq!(right.hello_frame(json!({ "token": token }))["ok"]["protocol"], 1);
}

#[test]
fn a_chat_a_terminal_and_an_approval_over_the_websocket_then_a_reconnect() {
    let data = temp_dir();
    let served = Served::start(&data.0, &[]);
    let token = std::fs::read_to_string(data.0.join("daemon-token")).unwrap().trim().to_string();
    let mut first = websocket(served.port());
    let hello = first.hello_frame(json!({ "token": token }))["ok"].clone();
    first.call("session_save", json!({ "session": { "version": 0 } })).1.unwrap();
    chat_terminal_and_approval(&mut first);

    // A second client that left after event 1 catches up from the buffer.
    let mut back = websocket(served.port());
    let again = back.hello_frame(json!({ "token": token, "since": { "boot_id": hello["boot_id"], "seq": 1 } }))["ok"].clone();
    assert_eq!(again["resumed"], true);
    let missed: Vec<serde_json::Value> = (2..=again["last_seq"].as_u64().unwrap()).map(|_| back.frames.next().unwrap()).collect();
    assert_eq!(missed.first().unwrap()["seq"], 2);
    assert_eq!(added_texts(&missed, "t1"), vec!["@null hi", "hello human"]);
    assert_eq!(missed.last().unwrap()["event"], "session-changed");
}

#[test]
fn listening_beyond_localhost_waits_for_pairing() {
    let data = temp_dir();
    let (mut process, _, _) = Process::spawn(&["serve", "--bind", "0.0.0.0"], &data.0, &[]);
    assert!(!process.wait().success());
    assert!(process.stderr().contains("--insecure-bind"), "{}", process.stderr());
    assert!(!data.0.join("daemon.json").exists());
}
