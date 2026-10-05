//! The remote protocol: newline-delimited JSON frames, the same on every
//! transport (stdio, the local socket, the WebSocket).
//!
//! - Request: `{"id": n, "cmd": "...", "args": {...}}`, where `cmd`/`args`
//!   are an `apex_host::Command`.
//! - Reply: `{"id": n, "ok": value}` or `{"id": n, "err": "message"}`.
//! - Event: `{"seq": n, "event": name, "payload": {...}}`, what the desktop
//!   window gets.
//!
//! The first frame must be `hello`. Commands run concurrently, so replies can
//! come out of order; a reply never comes before the events its command sent.

use std::sync::Arc;
use std::time::Duration;

use apex_host::events::Envelope;
use apex_host::{Command, Host};
use futures::{Sink, SinkExt, Stream, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{broadcast, mpsc};
use tokio_util::codec::{FramedRead, FramedWrite, LinesCodec};

/// The protocol version `hello` must name.
pub const PROTOCOL: u64 = 1;

/// A frame longer than this closes the connection.
pub const MAX_FRAME: usize = 32 * 1024 * 1024;

/// How long a WebSocket client may take to connect and say hello.
pub const HELLO_WAIT: Duration = Duration::from_secs(10);

/// After the client stops sending, how long replies already under way may
/// still take to arrive before the connection closes.
pub const DRAIN_GRACE: Duration = Duration::from_secs(10);

/// What every session on this daemon shares.
pub struct Daemon {
    pub host: Arc<Host>,
    /// Stable for a data folder.
    pub host_id: String,
    /// New on every start; a `seq` only means something next to it.
    pub boot_id: String,
    /// What WebSocket clients must present in `hello`.
    pub token: Option<String>,
}

impl Daemon {
    /// Open the host on `paths` with a new boot id. Call inside the runtime.
    pub fn start(paths: &apex_host::HostPaths, token: Option<String>) -> Result<Arc<Daemon>, String> {
        let host = Host::new(paths.clone(), tokio::runtime::Handle::current());
        // The daemon's arguments (`--data-dir PATH`) are not workspaces.
        host.set_startup_folders(Vec::new());
        Ok(Arc::new(Daemon { host, host_id: crate::identity::host_id(&paths.data)?, boot_id: crate::identity::boot_id(), token }))
    }
}

/// How a connection proved who it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trust {
    /// stdio and the local socket: whoever can reach them is the user.
    Local,
    /// The WebSocket: `hello` must carry the daemon's token.
    Token,
}

/// Frames read from and written to a byte stream, one JSON value per line.
pub fn lines<R: AsyncRead, W: AsyncWrite>(reader: R, writer: W) -> (FramedRead<R, LinesCodec>, FramedWrite<W, LinesCodec>) {
    (FramedRead::new(reader, LinesCodec::new_with_max_length(MAX_FRAME)), FramedWrite::new(writer, LinesCodec::new()))
}

/// A reply, held back until the events sent before it are written.
struct Reply {
    after: u64,
    frame: String,
}

/// Serve one client until it goes away.
///
/// Every command runs on its own task, so a slow one never holds up the rest,
/// and keeps running if the client leaves. When the client stops sending,
/// replies already under way get `DRAIN_GRACE` to arrive.
pub async fn serve<I, E, O>(daemon: Arc<Daemon>, trust: Trust, mut input: I, mut output: O)
where
    I: Stream<Item = Result<String, E>> + Unpin,
    E: std::fmt::Display,
    O: Sink<String> + Unpin,
{
    // Only a WebSocket client has yet to prove itself; it gets HELLO_WAIT.
    let first = match trust {
        Trust::Local => input.next().await,
        Trust::Token => tokio::time::timeout(HELLO_WAIT, input.next()).await.unwrap_or(None),
    };
    let Some(Ok(first)) = first else { return };
    let hello = match read_hello(&first, trust, &daemon) {
        Ok(hello) => hello,
        Err(refusal) => {
            let _ = output.send(refusal).await;
            let _ = output.close().await;
            return;
        }
    };
    // Subscribe before reading the buffer or `last_seq`, so no later event
    // is missed; live events at or before `written` are skipped.
    let bus = daemon.host.events();
    let mut events = bus.subscribe();
    let resume = hello.since.filter(|since| since.boot_id == daemon.boot_id).and_then(|since| Some((bus.since(since.seq)?, since.seq)));
    let resumed = resume.is_some();
    // Resuming, the client is at the last event replayed, or where it said
    // it was when there's nothing to replay; reading `last_seq` again here
    // would skip an event sent in between.
    let (replay, mut written) = match resume {
        Some((replay, since)) => {
            let at = replay.last().map_or(since, |e| e.seq);
            (replay, at)
        }
        None => (Vec::new(), bus.last_seq()),
    };
    let welcome = json!({ "id": hello.id, "ok": {
        "host_id": daemon.host_id, "boot_id": daemon.boot_id, "protocol": PROTOCOL, "last_seq": written, "resumed": resumed,
    } });
    if output.send(welcome.to_string()).await.is_err() {
        return;
    }
    for envelope in &replay {
        if output.send(event_frame(envelope)).await.is_err() {
            return;
        }
    }

    let (replies_tx, mut replies) = mpsc::unbounded_channel::<Reply>();
    let mut waiting: Vec<Reply> = Vec::new();
    let mut in_flight = 0usize;
    let mut reading = true;
    let drained = tokio::time::sleep(Duration::MAX);
    tokio::pin!(drained);
    while reading || in_flight > 0 || !waiting.is_empty() {
        tokio::select! {
            frame = input.next(), if reading => match frame {
                Some(Ok(text)) => match read_request(&text) {
                    Ok((id, command)) => {
                        in_flight += 1;
                        run(Arc::clone(&daemon.host), id, command, replies_tx.clone());
                    }
                    Err(refusal) => {
                        if output.send(refusal).await.is_err() {
                            return;
                        }
                    }
                },
                Some(Err(why)) => {
                    let _ = output.send(refusal(Value::Null, format!("closing the connection: a frame was too long or unreadable ({why})"))).await;
                    return;
                }
                None => {
                    reading = false;
                    drained.as_mut().reset(tokio::time::Instant::now() + DRAIN_GRACE);
                }
            },
            Some(reply) = replies.recv() => {
                in_flight -= 1;
                if reply.after <= written {
                    if output.send(reply.frame).await.is_err() {
                        return;
                    }
                } else {
                    waiting.push(reply);
                }
            }
            event = events.recv() => match event {
                Ok(envelope) if envelope.seq <= written => {}
                Ok(envelope) => {
                    written = envelope.seq;
                    if output.send(event_frame(&envelope)).await.is_err() {
                        return;
                    }
                    let (ready, later): (Vec<Reply>, Vec<Reply>) = waiting.drain(..).partition(|r| r.after <= written);
                    waiting = later;
                    for reply in ready {
                        if output.send(reply.frame).await.is_err() {
                            return;
                        }
                    }
                }
                Err(broadcast::error::RecvError::Lagged(missed)) => {
                    let why = format!("resync: this connection fell {missed} events behind; reconnect and reload");
                    let _ = output.send(refusal(Value::Null, why)).await;
                    return;
                }
                Err(broadcast::error::RecvError::Closed) => return,
            },
            _ = &mut drained => return,
        }
    }
    let _ = output.close().await;
}

/// Run `command` on its own task and send its reply to `replies`.
fn run(host: Arc<Host>, id: u64, command: Command, replies: mpsc::UnboundedSender<Reply>) {
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.call(command).await })
    };
    tokio::spawn(async move {
        let frame = match task.await {
            Ok(Ok(value)) => json!({ "id": id, "ok": value }),
            Ok(Err(why)) => json!({ "id": id, "err": why }),
            Err(_) => json!({ "id": id, "err": "the command failed unexpectedly" }),
        };
        let _ = replies.send(Reply { after: host.events().last_seq(), frame: frame.to_string() });
    });
}

fn refusal(id: Value, why: impl Into<String>) -> String {
    json!({ "id": id, "err": why.into() }).to_string()
}

fn event_frame(envelope: &Envelope) -> String {
    json!({ "seq": envelope.seq, "event": envelope.event.name(), "payload": envelope.event.payload() }).to_string()
}

/// A request's id and command, or the refusal to send back.
fn read_request(text: &str) -> Result<(u64, Command), String> {
    let mut value: Value = serde_json::from_str(text).map_err(|e| refusal(Value::Null, format!("not JSON: {e}")))?;
    let id = value.get("id").and_then(Value::as_u64).ok_or_else(|| refusal(Value::Null, "every request needs a numeric id"))?;
    if let Value::Object(fields) = &mut value {
        fields.remove("id");
    }
    if value["cmd"] == "hello" {
        return Err(refusal(json!(id), "already said hello"));
    }
    let command = Command::from_json(value).map_err(|why| refusal(json!(id), why))?;
    Ok((id, command))
}

struct Hello {
    id: Value,
    since: Option<Since>,
}

/// Where a returning client left off.
#[derive(serde::Deserialize)]
struct Since {
    boot_id: String,
    seq: u64,
}

/// Check the first frame, or say why the connection is refused.
fn read_hello(text: &str, trust: Trust, daemon: &Daemon) -> Result<Hello, String> {
    const EXAMPLE: &str = r#"{"id":0,"cmd":"hello","args":{"protocol":1}}"#;
    let value: Value = serde_json::from_str(text).unwrap_or_default();
    let id = value.get("id").cloned().unwrap_or_default();
    if value["cmd"] != "hello" {
        return Err(refusal(id, format!("say hello first, like {EXAMPLE}")));
    }
    let args = &value["args"];
    if args["protocol"] != json!(PROTOCOL) {
        return Err(refusal(id, format!("this daemon speaks protocol {PROTOCOL}, not {}", args["protocol"])));
    }
    if trust == Trust::Token {
        let presented = args["token"].as_str().unwrap_or_default();
        let expected = daemon.token.as_deref().unwrap_or_default();
        if expected.is_empty() || !same(presented, expected) {
            return Err(refusal(id, "wrong or missing token"));
        }
    }
    let since = serde_json::from_value(args["since"].clone()).ok();
    Ok(Hello { id, since })
}

/// Compare without stopping at the first difference.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use apex_host::HostPaths;
    use tokio::io::{AsyncWriteExt, DuplexStream, ReadHalf, WriteHalf};

    struct Client {
        read: FramedRead<ReadHalf<DuplexStream>, LinesCodec>,
        write: FramedWrite<WriteHalf<DuplexStream>, LinesCodec>,
        _data: Option<TempDir>,
    }

    struct TempDir(std::path::PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn temp_dir() -> TempDir {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!("apex-daemon-protocol-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
        let _ = std::fs::remove_dir_all(&dir);
        TempDir(dir)
    }

    fn daemon() -> (Arc<Daemon>, TempDir) {
        let data = temp_dir();
        let host = Host::new(HostPaths { data: data.0.clone(), downloads: None }, tokio::runtime::Handle::current());
        (Arc::new(Daemon { host, host_id: "host-1".into(), boot_id: "boot-1".into(), token: Some("secret".into()) }), data)
    }

    fn connect(trust: Trust) -> Client {
        let (daemon, data) = daemon();
        let mut client = connect_to(&daemon, trust);
        client._data = Some(data);
        client
    }

    fn connect_to(daemon: &Arc<Daemon>, trust: Trust) -> Client {
        let daemon = Arc::clone(daemon);
        let (ours, theirs) = tokio::io::duplex(1 << 16);
        let (their_read, their_write) = tokio::io::split(theirs);
        let (input, output) = lines(their_read, their_write);
        tokio::spawn(serve(daemon, trust, input, output));
        let (read, write) = tokio::io::split(ours);
        let (read, write) = lines(read, write);
        Client { read, write, _data: None }
    }

    impl Client {
        async fn send(&mut self, frame: Value) {
            self.write.send(frame.to_string()).await.unwrap();
        }

        /// The next frame, or `None` when the daemon closed the connection.
        async fn next(&mut self) -> Option<Value> {
            let line = tokio::time::timeout(Duration::from_secs(20), self.read.next()).await.expect("a frame in time")?;
            Some(serde_json::from_str(&line.ok()?).unwrap())
        }

        async fn hello(&mut self) -> Value {
            self.send(json!({ "id": 0, "cmd": "hello", "args": { "protocol": 1 } })).await;
            self.next().await.unwrap()
        }

        /// Frames up to and including the reply to `id`.
        async fn until_reply(&mut self, id: u64) -> Vec<Value> {
            let mut frames = Vec::new();
            loop {
                let frame = self.next().await.expect("the reply before the connection closed");
                let done = frame["id"] == json!(id);
                frames.push(frame);
                if done {
                    return frames;
                }
            }
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn hello_names_the_host_and_this_boot() {
        let mut client = connect(Trust::Local);
        let reply = client.hello().await;
        assert_eq!(reply, json!({ "id": 0, "ok": { "host_id": "host-1", "boot_id": "boot-1", "protocol": 1, "last_seq": 0, "resumed": false } }));
    }

    async fn save_sessions(client: &mut Client, versions: std::ops::RangeInclusive<u64>) {
        for n in versions {
            client.send(json!({ "id": n, "cmd": "session_save", "args": { "session": { "version": n } } })).await;
            client.until_reply(n).await;
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_client_that_comes_back_gets_exactly_the_events_it_missed() {
        let (daemon, _data) = daemon();
        let mut first = connect_to(&daemon, Trust::Local);
        first.hello().await;
        save_sessions(&mut first, 1..=3).await;

        let mut back = connect_to(&daemon, Trust::Local);
        back.send(json!({ "id": 0, "cmd": "hello", "args": { "protocol": 1, "since": { "boot_id": "boot-1", "seq": 1 } } })).await;
        assert_eq!(back.next().await.unwrap()["ok"], json!({ "host_id": "host-1", "boot_id": "boot-1", "protocol": 1, "last_seq": 3, "resumed": true }));
        assert_eq!(back.next().await.unwrap(), json!({ "seq": 2, "event": "session-changed", "payload": { "version": 2 } }));
        assert_eq!(back.next().await.unwrap(), json!({ "seq": 3, "event": "session-changed", "payload": { "version": 3 } }));
        // Then live events, with nothing doubled.
        save_sessions(&mut first, 4..=4).await;
        assert_eq!(back.next().await.unwrap()["seq"], 4);
    }

    /// Resuming at the latest event while others keep coming: the client
    /// must see every event after the one it named. Events come about every
    /// 50 µs, so the replay is often empty and one can land just as the
    /// session sets up.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn resuming_at_the_latest_event_misses_nothing_that_follows() {
        let (daemon, _data) = daemon();
        let emitting = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let emitter = {
            let (daemon, emitting) = (Arc::clone(&daemon), Arc::clone(&emitting));
            std::thread::spawn(move || {
                while emitting.load(std::sync::atomic::Ordering::SeqCst) {
                    daemon.host.events().emit(apex_host::events::HostEvent::PtyData { id: "p".into(), data: "x".into() });
                    let pause = std::time::Instant::now();
                    while pause.elapsed() < Duration::from_micros(50) {
                        std::hint::spin_loop();
                    }
                }
            })
        };
        let mut skipped = Vec::new();
        for _ in 0..3000 {
            let mut back = connect_to(&daemon, Trust::Local);
            let at = daemon.host.events().last_seq();
            back.send(json!({ "id": 0, "cmd": "hello", "args": { "protocol": 1, "since": { "boot_id": "boot-1", "seq": at } } })).await;
            assert_eq!(back.next().await.unwrap()["ok"]["resumed"], true);
            let first = back.next().await.unwrap()["seq"].as_u64().unwrap();
            if first != at + 1 {
                skipped.push(at + 1);
            }
        }
        emitting.store(false, std::sync::atomic::Ordering::SeqCst);
        emitter.join().unwrap();
        assert!(skipped.is_empty(), "events skipped right after resuming: {skipped:?}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_seq_from_another_boot_is_never_resumed() {
        let (daemon, _data) = daemon();
        let mut first = connect_to(&daemon, Trust::Local);
        first.hello().await;
        save_sessions(&mut first, 1..=3).await;

        // seq 1 is in range for this boot, but it was counted by another one.
        let mut back = connect_to(&daemon, Trust::Local);
        back.send(json!({ "id": 0, "cmd": "hello", "args": { "protocol": 1, "since": { "boot_id": "boot-0", "seq": 1 } } })).await;
        assert_eq!(back.next().await.unwrap()["ok"]["resumed"], false);
        save_sessions(&mut first, 4..=4).await;
        assert_eq!(back.next().await.unwrap()["seq"], 4, "no replay, only live events");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_seq_that_fell_out_of_the_buffer_is_not_resumed() {
        let (daemon, _data) = daemon();
        for n in 0..=apex_host::events::REPLAY_EVENTS {
            daemon.host.events().emit(apex_host::events::HostEvent::PtyData { id: "p".into(), data: n.to_string() });
        }
        let mut back = connect_to(&daemon, Trust::Local);
        back.send(json!({ "id": 0, "cmd": "hello", "args": { "protocol": 1, "since": { "boot_id": "boot-1", "seq": 0 } } })).await;
        let ok = back.next().await.unwrap()["ok"].clone();
        assert_eq!((ok["resumed"].clone(), ok["last_seq"].clone()), (json!(false), json!(apex_host::events::REPLAY_EVENTS + 1)));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_client_too_far_behind_is_told_to_resync_and_closed() {
        let (daemon, _data) = daemon();
        let mut slow = connect_to(&daemon, Trust::Local);
        slow.hello().await;
        // The client reads nothing while far more events than a subscriber
        // may fall behind are sent.
        for n in 0..apex_host::events::BUS_CAPACITY * 2 {
            daemon.host.events().emit(apex_host::events::HostEvent::PtyData { id: "p".into(), data: n.to_string() });
        }
        let mut last = Value::Null;
        while let Some(frame) = slow.next().await {
            last = frame;
        }
        assert!(last["err"].as_str().unwrap_or_default().starts_with("resync"), "{last}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn anything_before_hello_is_refused_and_closes_the_connection() {
        let mut client = connect(Trust::Local);
        client.send(json!({ "id": 4, "cmd": "data_folder" })).await;
        let reply = client.next().await.unwrap();
        assert_eq!(reply["id"], 4);
        assert!(reply["err"].as_str().unwrap().contains("hello"));
        assert_eq!(client.next().await, None);
    }

    /// A WebSocket client has to prove itself before it may hold a connection.
    #[tokio::test(start_paused = true)]
    async fn a_token_connection_that_never_says_hello_is_closed() {
        let mut client = connect(Trust::Token);
        let start = tokio::time::Instant::now();
        assert_eq!(client.next().await, None);
        assert_eq!(start.elapsed(), HELLO_WAIT);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn another_protocol_version_is_refused() {
        let mut client = connect(Trust::Local);
        client.send(json!({ "id": 0, "cmd": "hello", "args": { "protocol": 2 } })).await;
        assert!(client.next().await.unwrap()["err"].as_str().unwrap().contains("protocol 1"));
        assert_eq!(client.next().await, None);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_token_connection_needs_the_right_token() {
        let mut client = connect(Trust::Token);
        client.send(json!({ "id": 0, "cmd": "hello", "args": { "protocol": 1 } })).await;
        assert!(client.next().await.unwrap()["err"].as_str().unwrap().contains("token"));
        assert_eq!(client.next().await, None);

        let mut client = connect(Trust::Token);
        client.send(json!({ "id": 0, "cmd": "hello", "args": { "protocol": 1, "token": "wrong" } })).await;
        assert!(client.next().await.unwrap()["err"].as_str().unwrap().contains("token"));
        assert_eq!(client.next().await, None);

        let mut client = connect(Trust::Token);
        client.send(json!({ "id": 0, "cmd": "hello", "args": { "protocol": 1, "token": "secret" } })).await;
        assert_eq!(client.next().await.unwrap()["ok"]["protocol"], 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn commands_are_answered_by_id() {
        let mut client = connect(Trust::Local);
        client.hello().await;
        client.send(json!({ "id": 1, "cmd": "session_load" })).await;
        assert_eq!(client.next().await, Some(json!({ "id": 1, "ok": null })));
        client.send(json!({ "id": 2, "cmd": "room_post", "args": { "id": "nope", "text": "hi" } })).await;
        assert_eq!(client.next().await, Some(json!({ "id": 2, "err": "no group chat with id nope" })));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_slow_command_does_not_hold_up_a_quick_one() {
        let mut client = connect(Trust::Local);
        client.hello().await;
        client.send(json!({ "id": 1, "cmd": "mod_process_run", "args": { "argv": ["sleep", "1"] } })).await;
        client.send(json!({ "id": 2, "cmd": "session_load" })).await;
        assert_eq!(client.next().await.unwrap()["id"], 2);
        assert_eq!(client.next().await.unwrap()["id"], 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn mistakes_are_answered_without_closing_the_connection() {
        let mut client = connect(Trust::Local);
        client.hello().await;
        client.send(json!({ "id": 1, "cmd": "rm_rf" })).await;
        let reply = client.next().await.unwrap();
        assert_eq!(reply["id"], 1);
        assert!(reply["err"].as_str().unwrap().contains("unknown variant"));
        client.write.send("this is not json".to_string()).await.unwrap();
        let reply = client.next().await.unwrap();
        assert_eq!(reply["id"], Value::Null);
        assert!(reply["err"].as_str().unwrap().contains("JSON"));
        client.send(json!({ "cmd": "session_load" })).await;
        assert!(client.next().await.unwrap()["err"].as_str().unwrap().contains("id"));
        client.send(json!({ "id": 2, "cmd": "hello", "args": { "protocol": 1 } })).await;
        assert!(client.next().await.unwrap()["err"].as_str().unwrap().contains("hello"));
        client.send(json!({ "id": 3, "cmd": "session_load" })).await;
        assert_eq!(client.next().await, Some(json!({ "id": 3, "ok": null })));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_oversized_frame_closes_the_connection() {
        let mut client = connect(Trust::Local);
        client.hello().await;
        let huge = format!("{{\"id\":1,\"cmd\":\"session_load\",\"pad\":\"{}\"}}", "x".repeat(MAX_FRAME));
        let _ = client.write.send(huge).await;
        loop {
            match client.next().await {
                None => break,
                Some(frame) => assert!(frame["err"].as_str().unwrap_or_default().contains("too long"), "{frame}"),
            }
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_commands_events_arrive_before_its_reply() {
        let mut client = connect(Trust::Local);
        client.hello().await;
        // The event and the reply travel different paths; repeat so a race shows.
        for n in 1..=20u64 {
            client.send(json!({ "id": n, "cmd": "session_save", "args": { "session": { "version": n } } })).await;
            let frames = client.until_reply(n).await;
            assert_eq!(frames, vec![
                json!({ "seq": n, "event": "session-changed", "payload": { "version": n } }),
                json!({ "id": n, "ok": null }),
            ]);
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn replies_already_under_way_still_arrive_after_the_client_stops_sending() {
        let mut client = connect(Trust::Local);
        client.hello().await;
        client.send(json!({ "id": 1, "cmd": "mod_process_run", "args": { "argv": ["sleep", "1"] } })).await;
        client.write.get_mut().shutdown().await.unwrap();
        assert_eq!(client.next().await.unwrap()["id"], 1);
        assert_eq!(client.next().await, None);
    }
}
