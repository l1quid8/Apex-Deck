//! Drive the built `apex-daemon` binary the way a client would.
#![allow(dead_code)]

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
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

/// One protocol connection, whatever carries it.
pub struct Conn {
    send: Option<Box<dyn FnMut(String) + Send>>,
    pub frames: Frames,
    next_id: u64,
}

impl Conn {
    pub fn new(send: impl FnMut(String) + Send + 'static, frames: Frames) -> Conn {
        Conn { send: Some(Box::new(send)), frames, next_id: 1 }
    }

    pub fn send(&mut self, frame: Value) {
        (self.send.as_mut().expect("input still open"))(frame.to_string());
    }

    /// Stop sending; the daemon sees the connection's input end.
    pub fn close_input(&mut self) {
        self.send.take();
    }

    /// Say hello with `args` added to `{protocol: 1}`; the whole reply frame.
    pub fn hello_frame(&mut self, args: Value) -> Value {
        let mut all = json!({ "protocol": 1 });
        for (key, value) in args.as_object().cloned().unwrap_or_default() {
            all[key] = value;
        }
        self.send(json!({ "id": 0, "cmd": "hello", "args": all }));
        self.frames.next().expect("a hello reply")
    }

    pub fn hello(&mut self, since: Option<Value>) -> Value {
        let args = since.map(|since| json!({ "since": since })).unwrap_or(json!({}));
        let reply = self.hello_frame(args);
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
}

/// A running daemon process, killed when dropped.
pub struct Process {
    pub child: Child,
    pub stderr: Arc<Mutex<String>>,
    /// Set once everything the daemon wrote to stderr has been read.
    stderr_done: Arc<AtomicBool>,
}

impl Process {
    pub fn spawn(args: &[&str], data: &Path, env: &[(&str, String)]) -> (Process, Option<ChildStdin>, Option<std::process::ChildStdout>) {
        Process::spawn_with(args, data, |command| {
            command.envs(env.iter().map(|(k, v)| (k, v)));
        })
    }

    /// `spawn`, letting `adjust` change the command first.
    pub fn spawn_with(args: &[&str], data: &Path, adjust: impl FnOnce(&mut Command)) -> (Process, Option<ChildStdin>, Option<std::process::ChildStdout>) {
        let mut command = daemon(args, data);
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        adjust(&mut command);
        let mut child = command.spawn().expect("the daemon starts");
        let stderr = Arc::new(Mutex::new(String::new()));
        let stderr_done = Arc::new(AtomicBool::new(false));
        let (sink, done) = (Arc::clone(&stderr), Arc::clone(&stderr_done));
        let err = child.stderr.take().unwrap();
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                eprintln!("[daemon] {line}");
                let mut all = sink.lock().unwrap();
                all.push_str(&line);
                all.push('\n');
            }
            done.store(true, Ordering::SeqCst);
        });
        let (stdin, stdout) = (child.stdin.take(), child.stdout.take());
        (Process { child, stderr, stderr_done }, stdin, stdout)
    }

    pub fn stderr(&self) -> String {
        self.stderr.lock().unwrap().clone()
    }

    /// Wait for stderr to contain `text`.
    pub fn wait_for_log(&self, text: &str) {
        let start = Instant::now();
        while !self.stderr().contains(text) {
            assert!(start.elapsed() < PATIENCE, "the daemon never logged {text:?}; it said:\n{}", self.stderr());
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Wait for the daemon to exit, then briefly for the rest of its stderr,
    /// which can still be in the pipe. An agent it left running may hold the
    /// pipe open, so this doesn't wait for that forever.
    pub fn wait(&mut self) -> ExitStatus {
        let start = Instant::now();
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                let exited = Instant::now();
                while !self.stderr_done.load(Ordering::SeqCst) && exited.elapsed() < Duration::from_secs(2) {
                    std::thread::sleep(Duration::from_millis(10));
                }
                return status;
            }
            assert!(start.elapsed() < PATIENCE, "the daemon did not exit");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    pub fn signal(&self, signal: &str) {
        assert!(Command::new("kill").arg(format!("-{signal}")).arg(self.child.id().to_string()).status().unwrap().success());
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// `apex-daemon --stdio` with its stdin and stdout as the connection.
pub struct StdioClient {
    pub process: Process,
    pub conn: Conn,
}

impl StdioClient {
    pub fn spawn(args: &[&str], data: &Path) -> StdioClient {
        StdioClient::spawn_with(args, data, &[])
    }

    pub fn spawn_with(args: &[&str], data: &Path, env: &[(&str, String)]) -> StdioClient {
        let (process, stdin, stdout) = Process::spawn(args, data, env);
        let mut stdin = stdin.unwrap();
        let conn = Conn::new(
            move |line| {
                // A daemon that already left is seen by the reader.
                let _ = writeln!(stdin, "{line}").and_then(|_| stdin.flush());
            },
            Frames::from_lines(stdout.unwrap()),
        );
        StdioClient { process, conn }
    }

    pub fn stderr(&self) -> String {
        self.process.stderr()
    }

    pub fn wait(&mut self) -> ExitStatus {
        self.process.wait()
    }
}

impl std::ops::Deref for StdioClient {
    type Target = Conn;
    fn deref(&self) -> &Conn {
        &self.conn
    }
}

impl std::ops::DerefMut for StdioClient {
    fn deref_mut(&mut self) -> &mut Conn {
        &mut self.conn
    }
}

/// `apex-daemon serve`, started on a data folder and ready once `daemon.json` appears.
pub struct Served {
    pub process: Process,
    pub info: Value,
}

impl Served {
    pub fn start(data: &Path, extra: &[&str]) -> Served {
        Served::start_with(data, extra, |_| {})
    }

    /// `start`, letting `adjust` change the command first.
    pub fn start_with(data: &Path, extra: &[&str], adjust: impl FnOnce(&mut Command)) -> Served {
        let _ = std::fs::remove_file(data.join("daemon.json"));
        let mut args = vec!["serve"];
        args.extend_from_slice(extra);
        let (mut process, _, _) = Process::spawn_with(&args, data, adjust);
        let start = Instant::now();
        let info = loop {
            if let Some(info) = std::fs::read_to_string(data.join("daemon.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
                break info;
            }
            if let Some(status) = process.child.try_wait().unwrap() {
                panic!("the daemon exited ({status}) before it was ready:\n{}", process.stderr());
            }
            assert!(start.elapsed() < PATIENCE, "the daemon never wrote daemon.json:\n{}", process.stderr());
            std::thread::sleep(Duration::from_millis(20));
        };
        Served { process, info }
    }

    pub fn port(&self) -> u16 {
        self.info["port"].as_u64().expect("daemon.json names the port") as u16
    }
}

/// A WebSocket connection; its frames are read on a thread.
pub fn websocket(port: u16) -> Conn {
    use futures::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap();
    let (socket, _) = runtime.block_on(tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}"))).expect("the WebSocket connects");
    let (mut write, mut read) = socket.split();
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let (in_tx, in_rx) = mpsc::channel();
    runtime.spawn(async move {
        while let Some(text) = out_rx.recv().await {
            if write.send(Message::text(text)).await.is_err() {
                return;
            }
        }
        let _ = write.close().await;
    });
    runtime.spawn(async move {
        while let Some(Ok(message)) = read.next().await {
            if let Message::Text(text) = message {
                if in_tx.send(serde_json::from_str(text.as_str()).expect("a JSON frame")).is_err() {
                    return;
                }
            }
        }
    });
    // The runtime lives as long as the writer can be used.
    let runtime = Arc::new(runtime);
    Conn::new(
        move |line| {
            let _keep = &runtime;
            let _ = out_tx.send(line);
        },
        Frames::from_channel(in_rx),
    )
}

/// One chat with a scripted agent, an approval answer and a terminal, the
/// same over every transport. Ends by saving a session.
pub fn chat_terminal_and_approval(conn: &mut Conn) {
    let (_, snapshot) = conn.call("room_create", json!({ "id": "t1", "participants": [scripted("null", &["hello human"])], "options": options(), "cwd": null }));
    assert_eq!(snapshot.unwrap()["transcript"], json!([]));
    let (events, posted) = conn.call("room_post", json!({ "id": "t1", "text": "@null hi" }));
    assert_eq!(posted, Ok(json!(null)));
    assert_eq!(added_texts(&events, "t1"), vec!["@null hi", "hello human"]);
    let seqs: Vec<u64> = events.iter().map(|e| e["seq"].as_u64().unwrap()).collect();
    assert!(seqs.windows(2).all(|w| w[1] == w[0] + 1), "numbered without gaps: {seqs:?}");

    let (_, decided) = conn.call("room_decide", json!({ "id": "t1", "request": "r-1", "approve": true }));
    assert_eq!(decided, Err("that request is no longer waiting for an answer".into()));

    conn.call("pty_spawn", json!({ "id": "term", "agent": null, "cwd": null, "cols": 80, "rows": 24 })).1.unwrap();
    conn.call("pty_write", json!({ "id": "term", "data": "echo apex-$((40+2))\n" })).1.unwrap();
    conn.frames.until(|f| f["event"] == "pty-data" && f["payload"]["data"].as_str().unwrap_or_default().contains("apex-42"));
    conn.call("pty_kill", json!({ "id": "term" })).1.unwrap();

    conn.call("session_save", json!({ "session": { "version": 1, "panes": [{ "id": "t1", "kind": "chat" }] } })).1.unwrap();
}

/// After a restart: the chat from `chat_terminal_and_approval` and its session are back.
pub fn chat_restored(conn: &mut Conn) {
    let (_, restored) = conn.call("room_create", json!({ "id": "t1", "participants": [], "options": options(), "cwd": null }));
    let restored = restored.unwrap();
    let texts: Vec<&str> = restored["transcript"].as_array().unwrap().iter().filter_map(|m| m["text"].as_str()).collect();
    assert_eq!(texts, vec!["@null hi", "hello human"]);
    assert_eq!(conn.call("session_load", json!({})).1, Ok(json!({ "version": 1, "panes": [{ "id": "t1", "kind": "chat" }] })));
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

/// Whether `pid` is still a live process (a zombie waiting to be reaped is not).
pub fn alive(pid: &str) -> bool {
    let out = Command::new("ps").args(["-o", "stat=", "-p", pid]).output().unwrap();
    let state = String::from_utf8_lossy(&out.stdout).trim().to_string();
    !state.is_empty() && !state.starts_with('Z')
}

/// Wait for a file to hold a pid, and return it.
pub fn read_pid(path: &Path) -> String {
    let start = Instant::now();
    loop {
        if let Some(pid) = std::fs::read_to_string(path).ok().map(|p| p.trim().to_string()).filter(|p| !p.is_empty()) {
            return pid;
        }
        assert!(start.elapsed() < PATIENCE, "nothing wrote {}", path.display());
        std::thread::sleep(Duration::from_millis(20));
    }
}

pub fn wait_until_dead(pid: &str) {
    let start = Instant::now();
    while alive(pid) {
        assert!(start.elapsed() < Duration::from_secs(5), "process {pid} is still running");
        std::thread::sleep(Duration::from_millis(20));
    }
}
