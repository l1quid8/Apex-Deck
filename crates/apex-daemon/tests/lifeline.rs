//! `serve --exit-on-stdin-close`: the daemon the desktop app starts goes away
//! with the app, even when the app is killed. And `data-dir`, which tells the
//! app which folder that daemon would use.

mod common;

use std::io::Write;
use std::os::unix::net::UnixStream;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use apex_daemon::signals::WIND_DOWN;
use common::*;
use serde_json::json;

#[test]
fn data_dir_prints_the_folder_the_daemon_would_use() {
    let data = temp_dir();
    let out = Command::new(env!("CARGO_BIN_EXE_apex-daemon")).arg("data-dir").arg("--data-dir").arg(&data.0).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(String::from_utf8(out.stdout).unwrap().trim_end(), data.0.to_str().unwrap());

    let out = Command::new(env!("CARGO_BIN_EXE_apex-daemon")).arg("data-dir").output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let default = apex_daemon::paths::host_paths(None).unwrap().data;
    assert_eq!(String::from_utf8(out.stdout).unwrap().trim_end(), default.to_str().unwrap());
}

/// A connection on the daemon's local socket.
fn socket_conn(data: &std::path::Path) -> Conn {
    let stream = UnixStream::connect(data.join("daemon.sock")).expect("the socket answers");
    let mut write = stream.try_clone().unwrap();
    Conn::new(
        move |line| {
            let _ = writeln!(write, "{line}").and_then(|_| write.flush());
        },
        Frames::from_lines(stream),
    )
}

/// Wait for `daemon.json`, which the daemon writes once it's ready.
fn wait_ready(process: &mut Process, data: &std::path::Path) {
    let start = Instant::now();
    while !data.join("daemon.json").exists() {
        if let Some(status) = process.child.try_wait().unwrap() {
            panic!("the daemon exited ({status}) before it was ready:\n{}", process.stderr());
        }
        assert!(start.elapsed() < PATIENCE, "the daemon never wrote daemon.json:\n{}", process.stderr());
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Start an agent turn that sleeps and a terminal running `sleep 600`;
/// their pids.
fn busy(data: &std::path::Path) -> (Conn, String, String) {
    let mut conn = socket_conn(data);
    conn.hello(None);
    let agent_pid = data.join("agent.pid");
    let slow = shell("slow", &format!("echo $$ > {}; exec sleep 30", agent_pid.display()));
    conn.call("room_create", json!({ "id": "t1", "participants": [slow], "options": options(), "cwd": null })).1.unwrap();
    conn.send(json!({ "id": 99, "cmd": "room_post", "args": { "id": "t1", "text": "@slow go" } }));
    let agent = read_pid(&agent_pid);
    let shell_pid = data.join("shell.pid");
    conn.call("pty_spawn", json!({ "id": "term", "agent": null, "cwd": null, "cols": 80, "rows": 24 })).1.unwrap();
    conn.call("pty_write", json!({ "id": "term", "data": format!("echo $$ > {}; exec sleep 600\n", shell_pid.display()) })).1.unwrap();
    let terminal = read_pid(&shell_pid);
    (conn, agent, terminal)
}

/// The daemon exits 0 within the wind-down, cleans up, and ends the work.
fn gone_cleanly(process: &mut Process, data: &std::path::Path, agent: &str, terminal: &str) {
    let start = Instant::now();
    let status = loop {
        if let Some(status) = process.child.try_wait().unwrap() {
            break status;
        }
        assert!(start.elapsed() < WIND_DOWN + Duration::from_secs(5), "the daemon kept running after its stdin closed:\n{}", process.stderr());
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(status.success(), "{status}:\n{}", process.stderr());
    assert!(!data.join("daemon.sock").exists());
    assert!(!data.join("daemon.json").exists());
    wait_until_dead(agent);
    wait_until_dead(terminal);
}

#[test]
fn serve_exits_when_its_stdin_closes() {
    let data = temp_dir();
    let (mut process, stdin, _) = Process::spawn(&["serve", "--exit-on-stdin-close"], &data.0, &[]);
    wait_ready(&mut process, &data.0);
    let (_conn, agent, terminal) = busy(&data.0);
    drop(stdin);
    gone_cleanly(&mut process, &data.0, &agent, &terminal);
}

/// The app is killed outright: the pipe it held closes with it.
#[test]
fn serve_exits_when_the_process_holding_its_stdin_is_killed() {
    let data = temp_dir();
    // The shell holds the write end of the daemon's stdin; nobody else does.
    let fifo = data.0.join("lifeline");
    std::fs::create_dir_all(&data.0).unwrap();
    assert!(Command::new("mkfifo").arg(&fifo).status().unwrap().success());
    let holder = Command::new("sh")
        .arg("-c")
        .arg(format!("exec 3>{}; exec sleep 600", fifo.display()))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut holder = Killed(holder);
    let (mut process, _, _) = Process::spawn_with(&["serve", "--exit-on-stdin-close"], &data.0, |command| {
        // Opening a FIFO for reading waits for the writer, which the shell is.
        command.stdin(std::fs::File::open(&fifo).unwrap());
    });
    wait_ready(&mut process, &data.0);
    let (_conn, agent, terminal) = busy(&data.0);
    assert!(Command::new("kill").args(["-9", &holder.0.id().to_string()]).status().unwrap().success());
    let _ = holder.0.wait();
    gone_cleanly(&mut process, &data.0, &agent, &terminal);
}

/// A child killed when dropped, so a failed test leaves no `sleep 600` behind.
struct Killed(std::process::Child);

impl Drop for Killed {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn serve_without_the_option_ignores_its_stdin() {
    let data = temp_dir();
    // `Served` drops the daemon's stdin as soon as it starts.
    let mut served = Served::start(&data.0, &[]);
    let mut conn = socket_conn(&data.0);
    conn.hello(None);
    assert!(conn.call("session_load", json!({})).1.is_ok());
    assert!(served.process.child.try_wait().unwrap().is_none(), "the daemon stopped when its stdin closed");
}

/// The app that started the daemon reads its stderr too; when the app dies,
/// writing there fails, and the daemon must still stop its work and clean up.
#[test]
fn serve_cleans_up_when_the_app_reading_its_stderr_is_killed() {
    let data = temp_dir();
    std::fs::create_dir_all(&data.0).unwrap();
    let (input, output) = (data.0.join("in"), data.0.join("err"));
    for fifo in [&input, &output] {
        assert!(Command::new("mkfifo").arg(fifo).status().unwrap().success());
    }
    // The shell holds the write end of the daemon's stdin and the read end of
    // its stderr, as Electron does; it reads nothing, like an app that's gone.
    let holder = Command::new("sh")
        .arg("-c")
        .arg(format!("exec 3>{} 4<{}; exec sleep 600", input.display(), output.display()))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut holder = Killed(holder);
    let mut child = Command::new(env!("CARGO_BIN_EXE_apex-daemon"))
        .args(["serve", "--exit-on-stdin-close", "--data-dir"])
        .arg(&data.0)
        .stdin(std::fs::File::open(&input).unwrap())
        .stdout(Stdio::null())
        .stderr(std::fs::OpenOptions::new().write(true).open(&output).unwrap())
        .spawn()
        .unwrap();
    let start = Instant::now();
    while !data.0.join("daemon.json").exists() {
        assert!(child.try_wait().unwrap().is_none(), "the daemon exited before it was ready");
        assert!(start.elapsed() < PATIENCE, "the daemon never wrote daemon.json");
        std::thread::sleep(Duration::from_millis(20));
    }
    let (_conn, agent, terminal) = busy(&data.0);
    assert!(Command::new("kill").args(["-9", &holder.0.id().to_string()]).status().unwrap().success());
    let _ = holder.0.wait();
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        assert!(start.elapsed() < WIND_DOWN + Duration::from_secs(5), "the daemon kept running after the app died");
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(status.success(), "the daemon didn't stop cleanly: {status}");
    assert!(!data.0.join("daemon.sock").exists());
    assert!(!data.0.join("daemon.json").exists());
    wait_until_dead(&agent);
    wait_until_dead(&terminal);
}
