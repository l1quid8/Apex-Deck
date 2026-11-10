//! Trust reset operates only on its own temporary daemon, after child cleanup.
#![cfg(unix)]
mod common;
use common::*;
use serde_json::json;

#[test]
fn trust_reset_stops_only_its_daemon_and_waits_for_bot_and_terminal_cleanup() {
    let data = temp_dir();
    let other_data = temp_dir();
    let bot_pid = data.0.join("bot.pid");
    let slow = shell("slow", &format!("echo $$ > {}; exec sleep 60", bot_pid.display()));
    saved_room(&data.0, "t1", vec![slow]);
    let mut served = Served::start(&data.0, &[]);
    let mut other = Served::start(&other_data.0, &[]);
    let token = std::fs::read_to_string(data.0.join("daemon-token")).unwrap().trim().to_string();
    let mut web = websocket(served.port());
    web.hello_frame(json!({"token":token}));
    web.call("room_state", json!({"id":"t1"})).1.unwrap();
    web.send(json!({"id":99,"cmd":"room_post","args":{"id":"t1","text":"@slow go"}}));
    let bot = read_pid(&bot_pid);
    let pty_pid = data.0.join("terminal.pid");
    web.call("pty_spawn", json!({"id":"term","agent":null,"cwd":null,"cols":80,"rows":24})).1.unwrap();
    web.call("pty_write", json!({"id":"term","data":format!("echo $$ > {}; sleep 60\n",pty_pid.display())})).1.unwrap();
    let terminal = read_pid(&pty_pid);

    let reset = daemon(&["trust-host", "--no-reboot"], &data.0).output().unwrap();
    assert!(reset.status.success(), "{}", String::from_utf8_lossy(&reset.stderr));
    let stopped = served.process.child.try_wait().unwrap();
    if stopped.is_none() { served.process.signal("TERM"); served.process.wait(); }
    assert!(stopped.is_some(), "trust reset returned while the intended daemon was still running");
    assert!(stopped.unwrap().success());
    assert!(!data.0.join("daemon.json").exists());
    assert!(!data.0.join("daemon.sock").exists());
    assert!(!alive(&bot), "trust reset returned before its bot terminated");
    assert!(!alive(&terminal), "trust reset returned before its terminal terminated");
    assert!(other.process.child.try_wait().unwrap().is_none(), "another data folder's daemon was stopped");
    let other_token = std::fs::read_to_string(other_data.0.join("daemon-token")).unwrap().trim().to_string();
    let mut other_web = websocket(other.port());
    other_web.hello_frame(json!({"token":other_token}));
    assert!(other_web.call("session_load",json!({})).1.is_ok());
}
