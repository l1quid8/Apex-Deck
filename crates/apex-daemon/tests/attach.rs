//! One owner per data folder, the local socket, and `--stdio` attaching to
//! a running daemon: the SSH case on a server.

mod common;

use std::os::unix::fs::{FileTypeExt, PermissionsExt};

use apex_host::lock::DataLock;
use common::*;
use serde_json::json;

fn token(data: &std::path::Path) -> String {
    std::fs::read_to_string(data.join("daemon-token")).unwrap().trim().to_string()
}

#[test]
fn serve_owns_the_folder_and_listens_on_a_private_socket() {
    let data = temp_dir();
    let served = Served::start(&data.0, &[]);
    let socket = data.0.join("daemon.sock");
    let meta = std::fs::metadata(&socket).unwrap();
    assert!(meta.file_type().is_socket());
    assert_eq!(meta.permissions().mode() & 0o777, 0o600);
    assert_eq!(std::fs::metadata(&data.0).unwrap().permissions().mode() & 0o777, 0o700);
    assert_eq!(served.info["socket"], json!(socket.to_string_lossy()));

    let (mut second, _, _) = Process::spawn(&["serve"], &data.0, &[]);
    assert!(!second.wait().success());
    assert!(second.stderr().contains("apex-daemon serve"), "{}", second.stderr());
}

#[test]
fn stdio_attaches_to_the_running_daemon_and_shares_its_rooms() {
    let data = temp_dir();
    let served = Served::start(&data.0, &[]);
    let mut web = websocket(served.port());
    web.hello_frame(json!({ "token": token(&data.0) }));
    web.call("room_create", json!({ "id": "t1", "participants": [scripted("null", &["hello human"])], "options": options(), "cwd": null })).1.unwrap();

    let mut ssh = StdioClient::spawn(&["--stdio"], &data.0);
    let hello = ssh.hello(None);
    assert_eq!((hello["host_id"].clone(), hello["boot_id"].clone()), (served.info["host_id"].clone(), served.info["boot_id"].clone()));
    let (events, posted) = ssh.call("room_post", json!({ "id": "t1", "text": "@null hi" }));
    assert_eq!(posted, Ok(json!(null)));
    assert_eq!(added_texts(&events, "t1"), vec!["@null hi", "hello human"]);
    web.frames.until(|f| added_texts(std::slice::from_ref(f), "t1") == ["hello human"]);
    assert!(!ssh.stderr().contains("stops when this connection closes"), "attached, not in-process");
}

#[test]
fn an_ssh_session_that_drops_mid_reply_does_not_stop_the_agent() {
    let data = temp_dir();
    let served = Served::start(&data.0, &[]);
    let mut web = websocket(served.port());
    web.hello_frame(json!({ "token": token(&data.0) }));
    let slow = shell("slow", "cat >/dev/null; sleep 1; echo slow reply");
    web.call("room_create", json!({ "id": "t2", "participants": [slow], "options": options(), "cwd": null })).1.unwrap();

    let mut ssh = StdioClient::spawn(&["--stdio", "--attach"], &data.0);
    ssh.hello(None);
    ssh.send(json!({ "id": 7, "cmd": "room_post", "args": { "id": "t2", "text": "@slow go" } }));
    ssh.frames.until(|f| f["payload"]["room"] == "t2" && f["payload"]["event"]["type"] == "turn_started");
    ssh.process.signal("KILL");
    ssh.wait();

    web.frames.until(|f| added_texts(std::slice::from_ref(f), "t2") == ["slow reply"]);
}

#[test]
fn attach_without_a_daemon_fails_and_says_how_to_start_one() {
    let data = temp_dir();
    let (mut process, _, _) = Process::spawn(&["--stdio", "--attach"], &data.0, &[]);
    assert!(!process.wait().success());
    assert!(process.stderr().contains("apex-daemon serve"), "{}", process.stderr());
}

#[test]
fn stdio_will_not_share_a_folder_the_desktop_app_owns() {
    let data = temp_dir();
    let _desktop = DataLock::acquire(&data.0, "Apex Deck desktop app (pid 1)").unwrap();
    let (mut process, _, _) = Process::spawn(&["--stdio"], &data.0, &[]);
    assert!(!process.wait().success());
    assert!(process.stderr().contains("Apex Deck desktop app"), "{}", process.stderr());
}

#[test]
fn a_crashed_daemons_socket_is_replaced_on_the_next_start() {
    let data = temp_dir();
    let mut crashed = Served::start(&data.0, &[]);
    crashed.process.signal("KILL");
    crashed.process.wait();
    assert!(data.0.join("daemon.sock").exists(), "a crash leaves the socket behind");

    let restarted = Served::start(&data.0, &[]);
    let mut ssh = StdioClient::spawn(&["--stdio", "--attach"], &data.0);
    assert_eq!(ssh.hello(None)["boot_id"], restarted.info["boot_id"]);
}

#[test]
fn a_data_folder_too_deep_for_a_socket_is_named() {
    let data = temp_dir();
    let deep = data.0.join("d".repeat(100));
    let (mut process, _, _) = Process::spawn(&["serve"], &deep, &[]);
    assert!(!process.wait().success());
    assert!(process.stderr().contains("--data-dir"), "{}", process.stderr());
}
