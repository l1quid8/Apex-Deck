//! SIGTERM and SIGINT: stop, end agents and terminals, save, clean up, exit 0.

mod common;

use common::*;
use serde_json::json;

#[test]
fn sigterm_ends_agents_and_terminals_keeps_the_chat_and_cleans_up() {
    let data = temp_dir();
    let mut served = Served::start(&data.0, &[]);
    let token = std::fs::read_to_string(data.0.join("daemon-token")).unwrap().trim().to_string();
    let mut web = websocket(served.port());
    web.hello_frame(json!({ "token": token }));

    let agent_pid = data.0.join("agent.pid");
    let slow = shell("slow", &format!("echo $$ > {}; exec sleep 30", agent_pid.display()));
    web.call("room_create", json!({ "id": "t1", "participants": [slow], "options": options(), "cwd": null })).1.unwrap();
    web.send(json!({ "id": 99, "cmd": "room_post", "args": { "id": "t1", "text": "@slow go" } }));
    let agent = read_pid(&agent_pid);

    let shell_pid = data.0.join("shell.pid");
    web.call("pty_spawn", json!({ "id": "term", "agent": null, "cwd": null, "cols": 80, "rows": 24 })).1.unwrap();
    web.call("pty_write", json!({ "id": "term", "data": format!("echo $$ > {}; sleep 1000\n", shell_pid.display()) })).1.unwrap();
    let terminal = read_pid(&shell_pid);

    served.process.signal("TERM");
    assert!(served.process.wait().success());
    assert!(!data.0.join("daemon.sock").exists());
    assert!(!data.0.join("daemon.json").exists());
    wait_until_dead(&agent);
    wait_until_dead(&terminal);

    let again = Served::start(&data.0, &[]);
    let token = std::fs::read_to_string(data.0.join("daemon-token")).unwrap().trim().to_string();
    let mut web = websocket(again.port());
    web.hello_frame(json!({ "token": token }));
    let restored = web.call("room_create", json!({ "id": "t1", "participants": [], "options": options(), "cwd": null })).1.unwrap();
    assert_eq!(restored["transcript"][0]["text"], "@slow go");
}

#[test]
fn sigint_shuts_down_the_same_way() {
    let data = temp_dir();
    let mut served = Served::start(&data.0, &[]);
    served.process.signal("INT");
    assert!(served.process.wait().success());
    assert!(!data.0.join("daemon.sock").exists());
    assert!(!data.0.join("daemon.json").exists());
}

#[test]
fn an_in_process_stdio_session_ends_its_agents_on_sigterm() {
    let data = temp_dir();
    let mut ssh = StdioClient::spawn(&["--stdio"], &data.0);
    ssh.hello(None);
    let agent_pid = data.0.join("agent.pid");
    let slow = shell("slow", &format!("echo $$ > {}; exec sleep 30", agent_pid.display()));
    ssh.call("room_create", json!({ "id": "t1", "participants": [slow], "options": options(), "cwd": null })).1.unwrap();
    ssh.send(json!({ "id": 99, "cmd": "room_post", "args": { "id": "t1", "text": "@slow go" } }));
    let agent = read_pid(&agent_pid);
    ssh.process.signal("TERM");
    assert!(ssh.wait().success());
    wait_until_dead(&agent);
}
