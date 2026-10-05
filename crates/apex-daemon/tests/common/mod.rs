//! Drive the built `apex-daemon` binary the way a client would.
#![allow(dead_code)]

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use apex_core::{Backend, ParticipantConfig, ParticipantId};
use serde_json::{json, Value};

pub const PATIENCE: Duration = Duration::from_secs(20);

/// A folder removed when dropped. Kept short, since a socket path inside
/// it must fit in about 100 bytes.
pub struct TempDir(pub PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub fn temp_dir() -> TempDir {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let dir = PathBuf::from("/tmp").join(format!("ad-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
    let _ = std::fs::remove_dir_all(&dir);
    TempDir(dir)
}

pub fn daemon(args: &[&str], data: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_apex-daemon"));
    command.args(args).arg("--data-dir").arg(data);
    command
}

/// Frames read on a thread, so reads can time out.
pub struct Frames {
    rx: Receiver<Value>,
}

impl Frames {
    pub fn from_lines(reader: impl std::io::Read + Send + 'static) -> Frames {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(reader).lines() {
                let Ok(line) = line else { break };
                let frame = serde_json::from_str(&line).unwrap_or_else(|e| panic!("not a JSON frame ({e}): {line}"));
                if tx.send(frame).is_err() {
                    break;
                }
            }
        });
        Frames { rx }
    }

    pub fn from_channel(rx: Receiver<Value>) -> Frames {
        Frames { rx }
    }

    /// The next frame, or `None` once the connection closed.
    pub fn next(&self) -> Option<Value> {
        match self.rx.recv_timeout(PATIENCE) {
            Ok(frame) => Some(frame),
            Err(RecvTimeoutError::Disconnected) => None,
            Err(RecvTimeoutError::Timeout) => panic!("no frame within {PATIENCE:?}"),
        }
    }

    /// Frames up to the reply to `id`: the events before it, and the reply.
    pub fn until_reply(&self, id: u64) -> (Vec<Value>, Value) {
        let mut events = Vec::new();
        loop {
            let frame = self.next().unwrap_or_else(|| panic!("closed before the reply to {id}; events so far: {events:?}"));
            if frame.get("id") == Some(&json!(id)) {
                return (events, frame);
            }
            events.push(frame);
        }
    }

    /// Read until a frame `test` accepts; the frames read on the way are dropped.
    pub fn until(&self, test: impl Fn(&Value) -> bool) -> Value {
        let start = Instant::now();
        loop {
            assert!(start.elapsed() < PATIENCE, "nothing matched in time");
            let frame = self.next().expect("closed before a match");
            if test(&frame) {
                return frame;
            }
        }
    }
}

/// `apex-daemon --stdio` with its stdin and stdout as the connection.
pub struct StdioClient {
    pub child: Child,
    stdin: Option<ChildStdin>,
    pub frames: Frames,
    pub stderr: Arc<Mutex<String>>,
    next_id: u64,
}

impl StdioClient {
    pub fn spawn(args: &[&str], data: &Path) -> StdioClient {
        StdioClient::spawn_with(args, data, &[])
    }

    pub fn spawn_with(args: &[&str], data: &Path, env: &[(&str, String)]) -> StdioClient {
        let mut command = daemon(args, data);
        command.envs(env.iter().map(|(k, v)| (k, v)));
        let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().expect("the daemon starts");
        let frames = Frames::from_lines(child.stdout.take().unwrap());
        let stderr = Arc::new(Mutex::new(String::new()));
        let sink = Arc::clone(&stderr);
        let err = child.stderr.take().unwrap();
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                eprintln!("[daemon] {line}");
                let mut all = sink.lock().unwrap();
                all.push_str(&line);
                all.push('\n');
            }
        });
        let stdin = child.stdin.take();
        StdioClient { child, stdin, frames, stderr, next_id: 1 }
    }

    pub fn send(&mut self, frame: Value) {
        let stdin = self.stdin.as_mut().expect("input still open");
        writeln!(stdin, "{frame}").unwrap();
        stdin.flush().unwrap();
    }

    pub fn hello(&mut self, since: Option<Value>) -> Value {
        let mut args = json!({ "protocol": 1 });
        if let Some(since) = since {
            args["since"] = since;
        }
        self.send(json!({ "id": 0, "cmd": "hello", "args": args }));
        let reply = self.frames.next().expect("a hello reply");
        assert!(reply.get("ok").is_some(), "hello refused: {reply}");
        reply["ok"].clone()
    }

    /// Send a command; the events that came before its reply, and the reply.
    pub fn call(&mut self, cmd: &str, args: Value) -> (Vec<Value>, Result<Value, String>) {
        let id = self.next_id;
        self.next_id += 1;
        self.send(json!({ "id": id, "cmd": cmd, "args": args }));
        let (events, reply) = self.frames.until_reply(id);
        let result = match reply.get("err") {
            Some(err) => Err(err.as_str().unwrap_or_default().to_string()),
            None => Ok(reply["ok"].clone()),
        };
        (events, result)
    }

    pub fn close_input(&mut self) {
        self.stdin.take();
    }

    pub fn wait(&mut self) -> ExitStatus {
        let start = Instant::now();
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status;
            }
            assert!(start.elapsed() < PATIENCE, "the daemon did not exit");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for StdioClient {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub fn scripted(id: &str, lines: &[&str]) -> Value {
    participant(id, Backend::Scripted { lines: lines.iter().map(|l| l.to_string()).collect() })
}

/// A command-line participant: `script` runs under `sh -c` with the prompt on stdin.
pub fn shell(id: &str, script: &str) -> Value {
    participant(id, Backend::Cli { program: "sh".into(), args: vec!["-c".into(), script.into()] })
}

fn participant(id: &str, backend: Backend) -> Value {
    serde_json::to_value(ParticipantConfig {
        id: ParticipantId::new(id),
        display_name: id.to_string(),
        backend,
        persona: String::new(),
        access: Default::default(),
        effort: None,
        appearance: None,
    })
    .unwrap()
}

pub fn options() -> Value {
    serde_json::to_value(apex_core::RoomOptions::default()).unwrap()
}

/// The texts of `message_added` events for `room` among `frames`.
pub fn added_texts(frames: &[Value], room: &str) -> Vec<String> {
    frames
        .iter()
        .filter(|f| f["event"] == "room-event" && f["payload"]["room"] == room && f["payload"]["event"]["type"] == "message_added")
        .filter_map(|f| f["payload"]["event"]["message"]["text"].as_str().map(str::to_string))
        .collect()
}
