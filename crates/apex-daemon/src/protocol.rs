//! The remote protocol: newline-delimited JSON frames, the same on every
//! transport (stdio, the local socket, the WebSocket, an iroh stream).
//!
//! - Request: `{"id": n, "cmd": "...", "args": {...}}`, where `cmd`/`args`
//!   are an `apex_host::Command`, or one of the local-only `devices_*`,
//!   `pair_*` and `remote_*` (see `pair_commands`).
//! - Reply: `{"id": n, "ok": value}` or `{"id": n, "err": "message"}`; a
//!   `pair_*`/`remote_*` error also has `"reason"`, a word naming why.
//! - Event: `{"seq": n, "event": name, "payload": {...}}`, what the desktop
//!   window gets.
//!
//! The first frame must be `hello`. Commands run concurrently, so replies can
//! come out of order; a reply never comes before the events its command sent.
//!
//! A remote device (`Trust::Device`) is checked against the saved registry
//! when it connects, after `hello`, before every command and before every
//! frame sent to it, so a revoke or a narrower tier takes effect at once.

use std::sync::Arc;
use std::time::Duration;

use apex_host::events::Envelope;
use apex_host::{Command, Host};
use futures::{Sink, SinkExt, Stream, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{broadcast, mpsc};
use tokio_util::codec::{FramedRead, FramedWrite, LinesCodec};

use crate::authority;
use crate::devices::{Device, Devices, Threads, Tier};

/// The protocol version `hello` must name.
pub const PROTOCOL: u64 = 1;

/// A frame longer than this closes the connection.
pub const MAX_FRAME: usize = 32 * 1024 * 1024;

/// The same for a remote device, which also bounds what one attachment may be.
pub const DEVICE_MAX_FRAME: usize = 8 * 1024 * 1024;

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
    /// The remote devices allowed in.
    pub devices: Arc<Devices>,
    /// The data folder (`remote.json` lives here).
    pub data: std::path::PathBuf,
    /// Pairing invitations handed out since this daemon started.
    #[cfg(feature = "remote")]
    pub invites: Arc<crate::pairing::invites::Invites>,
    /// The iroh endpoint, once `serve --remote` started it.
    #[cfg(feature = "remote")]
    pub endpoint: std::sync::OnceLock<iroh::Endpoint>,
}

impl Daemon {
    /// Open the host on `paths` with a new boot id. Call inside the runtime.
    pub fn start(paths: &apex_host::HostPaths, token: Option<String>) -> Result<Arc<Daemon>, String> {
        let host = Host::try_new(paths.clone(), tokio::runtime::Handle::current())?;
        // The daemon's arguments (`--data-dir PATH`) are not workspaces.
        host.set_startup_folders(Vec::new());
        let devices = Arc::new(Devices::open(&paths.data));
        host.start_monitor_clock()?;
        Ok(Arc::new(Daemon { host, host_id: crate::identity::host_id(&paths.data)?, boot_id: crate::identity::boot_id(), token, devices, data: paths.data.clone(),
            #[cfg(feature = "remote")] invites: Default::default(),
            #[cfg(feature = "remote")] endpoint: Default::default(),
        }))
    }
}

/// How a connection proved who it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Trust {
    /// stdio and the local socket: whoever can reach them is the user.
    Local,
    /// The WebSocket: `hello` must carry the daemon's token.
    Token,
    /// A remote device, by the endpoint ID its transport authenticated. It
    /// must be in the registry and not revoked; `hello`'s token is ignored.
    Device(String),
}

/// How a session ended, so a transport can say why when it closes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ended {
    /// The client left, or the connection failed.
    Closed,
    /// Refused at the start: a bad `hello`, or a device not in the registry.
    Refused,
    /// The device was revoked (or removed) while connected.
    Revoked,
}

/// Frames read from and written to a byte stream, one JSON value per line.
pub fn lines<R: AsyncRead, W: AsyncWrite>(reader: R, writer: W) -> (FramedRead<R, LinesCodec>, FramedWrite<W, LinesCodec>) {
    lines_up_to(reader, writer, MAX_FRAME)
}

/// `lines`, with frames longer than `max` closing the connection.
pub fn lines_up_to<R: AsyncRead, W: AsyncWrite>(reader: R, writer: W, max: usize) -> (FramedRead<R, LinesCodec>, FramedWrite<W, LinesCodec>) {
    (FramedRead::new(reader, LinesCodec::new_with_max_length(max)), FramedWrite::new(writer, LinesCodec::new()))
}

/// A reply, held back until the events sent before it are written. For a
/// device, `need` is checked again and a `session_load` filtered again just
/// before it goes out, so narrowing a device mid-command still applies.
struct Reply {
    after: u64,
    id: u64,
    result: Result<Value, String>,
    need: Option<authority::Need>,
    session: bool,
}

/// A remote device's session: who it is, and word of revokes.
struct Guard {
    devices: Arc<Devices>,
    id: String,
    revokes: broadcast::Receiver<String>,
}

impl Guard {
    /// The device as the registry has it right now; `None` once revoked.
    fn device(&self) -> Option<Device> {
        self.devices.get(&self.id)
    }

    /// Resolves once this device is no longer allowed. The channel is only a
    /// fast path: when it lags or closes, the registry decides.
    async fn revoked(&mut self) {
        loop {
            match self.revokes.recv().await {
                Ok(id) if id == self.id => return,
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    if self.device().is_none() {
                        return;
                    }
                }
                Err(broadcast::error::RecvError::Closed) => {
                    if self.device().is_none() {
                        return;
                    }
                    return std::future::pending().await;
                }
            }
        }
    }
}

/// Resolves when a device's session must end; never for other clients.
async fn cut_off(guard: &mut Option<Guard>) {
    match guard {
        Some(guard) => guard.revoked().await,
        None => std::future::pending().await,
    }
}

/// Why sending a frame failed.
enum Stop {
    Closed,
    Revoked,
}

impl From<Stop> for Ended {
    fn from(stop: Stop) -> Ended {
        match stop {
            Stop::Closed => Ended::Closed,
            Stop::Revoked => Ended::Revoked,
        }
    }
}

/// Send one frame. For a device, the registry is checked first and the
/// write is raced against a revoke, so a client that stopped reading can't
/// hold the session open.
async fn send<O: Sink<String> + Unpin>(output: &mut O, guard: &mut Option<Guard>, frame: String) -> Result<(), Stop> {
    if guard.as_ref().is_some_and(|g| g.device().is_none()) {
        return Err(Stop::Revoked);
    }
    tokio::select! {
        sent = output.send(frame) => sent.map_err(|_| Stop::Closed),
        _ = cut_off(guard) => Err(Stop::Revoked),
    }
}

/// The frame for `reply` as this session may have it right now.
fn reply_frame(guard: &Option<Guard>, reply: Reply) -> Result<String, Stop> {
    // A device's access is checked before either outcome, so an error can't
    // carry details the device may no longer see.
    let device = match guard {
        None => None,
        Some(guard) => {
            let device = guard.device().ok_or(Stop::Revoked)?;
            if let Some(need) = &reply.need {
                if let Err(why) = authority::check(&device, need) {
                    return Ok(refusal(json!(reply.id), why));
                }
            }
            Some(device)
        }
    };
    let value = match (device, reply.result) {
        (_, Err(why)) => return Ok(refusal(json!(reply.id), why)),
        (Some(device), Ok(value)) if reply.session => authority::filter_session(&device.threads, value),
        (_, Ok(value)) => value,
    };
    Ok(json!({ "id": reply.id, "ok": value }).to_string())
}

/// Whether an event goes to this session: always for local and token
/// clients; for a device, by its tier and threads right now.
fn delivers(guard: &Option<Guard>, envelope: &Envelope) -> Result<bool, Stop> {
    match guard {
        None => Ok(true),
        Some(guard) => {
            let device = guard.device().ok_or(Stop::Revoked)?;
            Ok(authority::may_receive(&device, &envelope.event))
        }
    }
}

/// Serve one client until it goes away.
///
/// Every command runs on its own task, so a slow one never holds up the rest,
/// and keeps running if the client leaves. When the client stops sending,
/// replies already under way get `DRAIN_GRACE` to arrive.
pub async fn serve<I, E, O>(daemon: Arc<Daemon>, trust: Trust, mut input: I, mut output: O) -> Ended
where
    I: Stream<Item = Result<String, E>> + Unpin,
    E: std::fmt::Display,
    O: Sink<String> + Unpin,
{
    // A device hears of revokes from before its registry check, so one that
    // lands between the check and `hello` is caught by one or the other.
    let mut guard = match &trust {
        Trust::Device(id) => Some(Guard { devices: Arc::clone(&daemon.devices), id: id.clone(), revokes: daemon.devices.subscribe() }),
        _ => None,
    };
    if guard.as_ref().is_some_and(|g| g.device().is_none()) {
        let _ = output.send(refusal(Value::Null, "this device isn't paired with this machine")).await;
        let _ = output.close().await;
        return Ended::Refused;
    }
    // Only a WebSocket client or a device has yet to prove itself; it gets HELLO_WAIT.
    let first = tokio::select! {
        first = async {
            match trust {
                Trust::Local => input.next().await,
                Trust::Token | Trust::Device(_) => tokio::time::timeout(HELLO_WAIT, input.next()).await.unwrap_or(None),
            }
        } => first,
        _ = cut_off(&mut guard) => return Ended::Revoked,
    };
    let Some(Ok(first)) = first else { return Ended::Closed };
    let hello = match read_hello(&first, &trust, &daemon) {
        Ok(hello) => hello,
        Err(refusal) => {
            let _ = send(&mut output, &mut guard, refusal).await;
            let _ = output.close().await;
            return Ended::Refused;
        }
    };
    if let Some(guard) = &guard {
        match guard.device() {
            None => return Ended::Revoked,
            Some(device) => {
                let _ = daemon.devices.seen(&device.endpoint_id);
            }
        }
    }
    // Subscribe before reading the buffer or `last_seq`, so no later event
    // is missed; live events at or before `written` are skipped.
    let bus = daemon.host.events();
    let mut events = bus.subscribe();
    let resume = hello.since.filter(|since| since.boot_id == daemon.boot_id).and_then(|since| Some((bus.since(since.seq)?, since.seq)));
    let resumed = resume.is_some();
    // Resuming, the client is at the last event replayed, or where it said
    // it was when there's nothing to replay; reading `last_seq` again here
    // would skip an event sent in between. Events a device may not have
    // still count, so its `seq` lines up with everyone else's.
    let (replay, mut written) = match resume {
        Some((replay, since)) => {
            let at = replay.last().map_or(since, |e| e.seq);
            (replay, at)
        }
        None => (Vec::new(), bus.last_seq()),
    };
    let mut welcome = json!({ "id": hello.id, "ok": {
        "host_id": daemon.host_id, "boot_id": daemon.boot_id, "protocol": PROTOCOL, "last_seq": written, "resumed": resumed,
        // Which apex-daemon answered, so Deck can say when a server's helper is older than the app.
        "version": env!("CARGO_PKG_VERSION"), "capabilities": ["monitor", "monitor_profile_update", "assistant_delegation", "assistant_isolation"],
    } });
    // A device also learns what it may do now (so the phone can hide what
    // it can't use; the host still checks everything) and the addresses
    // advertised for this machine, to refresh its saved hints.
    if let Some(device) = guard.as_ref().and_then(Guard::device) {
        welcome["ok"]["access"] = json!({ "tier": device.tier, "threads": device.threads });
        welcome["ok"]["addrs"] = json!(crate::remote_config::advertised(&daemon.data));
    }
    if let Err(stop) = send(&mut output, &mut guard, welcome.to_string()).await {
        return stop.into();
    }
    for envelope in &replay {
        match delivers(&guard, envelope) {
            Err(stop) => return stop.into(),
            Ok(false) => {}
            Ok(true) => {
                if let Err(stop) = send(&mut output, &mut guard, event_frame(envelope)).await {
                    return stop.into();
                }
            }
        }
    }

    let (replies_tx, mut replies) = mpsc::unbounded_channel::<Reply>();
    // Answers to local pairing commands, ready to send.
    let (frames_tx, mut frames) = mpsc::unbounded_channel::<String>();
    let mut waiting: Vec<Reply> = Vec::new();
    let mut in_flight = 0usize;
    let mut reading = true;
    let drained = tokio::time::sleep(Duration::MAX);
    tokio::pin!(drained);
    while reading || in_flight > 0 || !waiting.is_empty() {
        tokio::select! {
            frame = input.next(), if reading => match frame {
                Some(Ok(text)) => match read_request(&text) {
                    Ok((id, Request::Devices(request))) => {
                        let frame = match trust {
                            Trust::Local => match manage(&daemon.devices, request) {
                                Ok(value) => json!({ "id": id, "ok": value }),
                                Err(why) => json!({ "id": id, "err": why }),
                            },
                            Trust::Token | Trust::Device(_) => json!({ "id": id, "err": "not allowed from a remote connection" }),
                        };
                        if let Err(stop) = send(&mut output, &mut guard, frame.to_string()).await {
                            return stop.into();
                        }
                    }
                    Ok((id, Request::Pairing(request))) => match trust {
                        Trust::Local => {
                            in_flight += 1;
                            let (daemon, frames_tx) = (Arc::clone(&daemon), frames_tx.clone());
                            tokio::spawn(async move {
                                let frame = match crate::pair_commands::run(daemon, request).await {
                                    Ok(value) => json!({ "id": id, "ok": value }),
                                    Err(refusal) => refusal.frame(id),
                                };
                                let _ = frames_tx.send(frame.to_string());
                            });
                        }
                        Trust::Token | Trust::Device(_) => {
                            if let Err(stop) = send(&mut output, &mut guard, refusal(json!(id), "not allowed from a remote connection")).await {
                                return stop.into();
                            }
                        }
                    },
                    Ok((id, Request::Host(command))) => {
                        let need = match &guard {
                            None => Ok(None),
                            Some(guard) => match guard.device() {
                                None => return Ended::Revoked,
                                Some(device) => {
                                    let need = authority::command_needs(&command);
                                    authority::check(&device, &need).map(|()| Some(need))
                                }
                            },
                        };
                        match need {
                            Ok(need) => {
                                in_flight += 1;
                                run(Arc::clone(&daemon.host), id, command, need, replies_tx.clone());
                            }
                            Err(why) => {
                                if let Err(stop) = send(&mut output, &mut guard, refusal(json!(id), why)).await {
                                    return stop.into();
                                }
                            }
                        }
                    }
                    Err(refusal) => {
                        if let Err(stop) = send(&mut output, &mut guard, refusal).await {
                            return stop.into();
                        }
                    }
                },
                Some(Err(why)) => {
                    let _ = send(&mut output, &mut guard, refusal(Value::Null, format!("closing the connection: a frame was too long or unreadable ({why})"))).await;
                    return Ended::Closed;
                }
                None => {
                    reading = false;
                    drained.as_mut().reset(tokio::time::Instant::now() + DRAIN_GRACE);
                }
            },
            Some(frame) = frames.recv() => {
                in_flight -= 1;
                if let Err(stop) = send(&mut output, &mut guard, frame).await {
                    return stop.into();
                }
            }
            Some(reply) = replies.recv() => {
                in_flight -= 1;
                if reply.after <= written {
                    let frame = match reply_frame(&guard, reply) {
                        Ok(frame) => frame,
                        Err(stop) => return stop.into(),
                    };
                    if let Err(stop) = send(&mut output, &mut guard, frame).await {
                        return stop.into();
                    }
                } else {
                    waiting.push(reply);
                }
            }
            event = events.recv() => match event {
                Ok(envelope) if envelope.seq <= written => {}
                Ok(envelope) => {
                    // A skipped event still moves `written`, or replies
                    // waiting on it would stall.
                    written = envelope.seq;
                    match delivers(&guard, &envelope) {
                        Err(stop) => return stop.into(),
                        Ok(false) => {}
                        Ok(true) => {
                            if let Err(stop) = send(&mut output, &mut guard, event_frame(&envelope)).await {
                                return stop.into();
                            }
                        }
                    }
                    let (ready, later): (Vec<Reply>, Vec<Reply>) = waiting.drain(..).partition(|r| r.after <= written);
                    waiting = later;
                    for reply in ready {
                        let frame = match reply_frame(&guard, reply) {
                            Ok(frame) => frame,
                            Err(stop) => return stop.into(),
                        };
                        if let Err(stop) = send(&mut output, &mut guard, frame).await {
                            return stop.into();
                        }
                    }
                }
                Err(broadcast::error::RecvError::Lagged(missed)) => {
                    let why = format!("resync: this connection fell {missed} events behind; reconnect and reload");
                    let _ = send(&mut output, &mut guard, refusal(Value::Null, why)).await;
                    return Ended::Closed;
                }
                Err(broadcast::error::RecvError::Closed) => return Ended::Closed,
            },
            _ = cut_off(&mut guard) => return Ended::Revoked,
            _ = &mut drained => return Ended::Closed,
        }
    }
    let _ = output.close().await;
    Ended::Closed
}

/// Run `command` on its own task and send its result to `replies`, with
/// what a device needed to run it (`need`), to be checked again on delivery.
fn run(host: Arc<Host>, id: u64, command: Command, need: Option<authority::Need>, replies: mpsc::UnboundedSender<Reply>) {
    let session = matches!(command, Command::SessionLoad {});
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.call(command).await })
    };
    tokio::spawn(async move {
        let result = match task.await {
            Ok(result) => result,
            Err(_) => Err("the command failed unexpectedly".to_string()),
        };
        let _ = replies.send(Reply { after: host.events().last_seq(), id, result, need, session });
    });
}

/// Managing remote devices: only from this machine (`Trust::Local`).
#[derive(Debug, serde::Deserialize)]
#[serde(tag = "cmd", content = "args", rename_all = "snake_case", rename_all_fields = "camelCase")]
enum DevicesRequest {
    DevicesList {},
    DevicesAdd { id: String, label: String, tier: Tier, threads: Option<Threads>, #[serde(default)] restore: bool },
    DevicesSetTier { id: String, tier: Tier },
    DevicesSetThreads { id: String, threads: Threads },
    DevicesRevoke { id: String },
}

/// Run a `devices_*` request given as `{ "cmd", "args" }`, as the CLI does
/// when no daemon is running.
pub fn manage_json(devices: &Devices, request: Value) -> Result<Value, String> {
    manage(devices, serde_json::from_value(request).map_err(|e| e.to_string())?)
}

fn manage(devices: &Devices, request: DevicesRequest) -> Result<Value, String> {
    let value = |v: Result<Device, String>| v.and_then(|d| serde_json::to_value(d).map_err(|e| e.to_string()));
    match request {
        DevicesRequest::DevicesList {} => serde_json::to_value(devices.list()?).map_err(|e| e.to_string()),
        DevicesRequest::DevicesAdd { id, label, tier, threads, restore } => value(devices.add(&id, &label, tier, threads.unwrap_or(Threads::ALL), restore)),
        DevicesRequest::DevicesSetTier { id, tier } => value(devices.set_tier(&id, tier)),
        DevicesRequest::DevicesSetThreads { id, threads } => value(devices.set_threads(&id, threads)),
        DevicesRequest::DevicesRevoke { id } => devices.revoke(&id).map(|()| Value::Null),
    }
}

enum Request {
    Host(Command),
    Devices(DevicesRequest),
    Pairing(crate::pair_commands::PairRequest),
}

fn refusal(id: Value, why: impl Into<String>) -> String {
    json!({ "id": id, "err": why.into() }).to_string()
}

fn event_frame(envelope: &Envelope) -> String {
    json!({ "seq": envelope.seq, "event": envelope.event.name(), "payload": envelope.event.payload() }).to_string()
}

/// A request's id and command, or the refusal to send back.
fn read_request(text: &str) -> Result<(u64, Request), String> {
    let mut value: Value = serde_json::from_str(text).map_err(|e| refusal(Value::Null, format!("not JSON: {e}")))?;
    let id = value.get("id").and_then(Value::as_u64).ok_or_else(|| refusal(Value::Null, "every request needs a numeric id"))?;
    if let Value::Object(fields) = &mut value {
        fields.remove("id");
        fields.entry("args").or_insert_with(|| Value::Object(Default::default()));
    }
    if value["cmd"] == "hello" {
        return Err(refusal(json!(id), "already said hello"));
    }
    if value["cmd"].as_str().is_some_and(|cmd| cmd.starts_with("devices_")) {
        let request = serde_json::from_value(value).map_err(|e| refusal(json!(id), e.to_string()))?;
        return Ok((id, Request::Devices(request)));
    }
    if value["cmd"].as_str().is_some_and(|cmd| cmd.starts_with("pair_") || cmd.starts_with("remote_")) {
        let request = serde_json::from_value(value).map_err(|e| crate::pair_commands::Refusal::new(e.to_string(), "bad_request").frame(id).to_string())?;
        return Ok((id, Request::Pairing(request)));
    }
    let command = Command::from_json(value).map_err(|why| refusal(json!(id), why))?;
    Ok((id, Request::Host(command)))
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
fn read_hello(text: &str, trust: &Trust, daemon: &Daemon) -> Result<Hello, String> {
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
    if *trust == Trust::Token {
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
        let devices = Arc::new(Devices::open(&data.0));
        let daemon = Daemon {
            host, host_id: "host-1".into(), boot_id: "boot-1".into(), token: Some("secret".into()), devices, data: data.0.clone(),
            #[cfg(feature = "remote")] invites: Default::default(),
            #[cfg(feature = "remote")] endpoint: Default::default(),
        };
        (Arc::new(daemon), data)
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
        assert_eq!(reply, json!({ "id": 0, "ok": { "host_id": "host-1", "boot_id": "boot-1", "protocol": 1, "last_seq": 0, "resumed": false, "version": env!("CARGO_PKG_VERSION"), "capabilities": ["monitor", "monitor_profile_update", "assistant_delegation", "assistant_isolation"] } }));
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
        assert_eq!(back.next().await.unwrap()["ok"], json!({ "host_id": "host-1", "boot_id": "boot-1", "protocol": 1, "last_seq": 3, "resumed": true, "version": env!("CARGO_PKG_VERSION"), "capabilities": ["monitor", "monitor_profile_update", "assistant_delegation", "assistant_isolation"] }));
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

    // ---- Remote devices ----

    use crate::devices::tests::id;
    use apex_host::events::HostEvent;

    fn add(daemon: &Daemon, n: u8, tier: Tier, threads: Threads) -> String {
        daemon.devices.add(&id(n), "Phone", tier, threads, false).unwrap();
        id(n)
    }

    /// A device's connection, with the session's task to see how it ended.
    fn connect_device(daemon: &Arc<Daemon>, device: &str, buffer: usize) -> (Client, tokio::task::JoinHandle<Ended>) {
        let (ours, theirs) = tokio::io::duplex(buffer);
        let (their_read, their_write) = tokio::io::split(theirs);
        let (input, output) = lines_up_to(their_read, their_write, DEVICE_MAX_FRAME);
        let session = tokio::spawn(serve(Arc::clone(daemon), Trust::Device(device.to_string()), input, output));
        let (read, write) = tokio::io::split(ours);
        let (read, write) = lines(read, write);
        (Client { read, write, _data: None }, session)
    }

    fn room(name: &str, n: u64) -> HostEvent {
        HostEvent::Room { room: name.into(), event: apex_core::RoomEvent::TurnStarted { id: apex_core::ParticipantId::new(format!("b{n}")) }, recovery_seq: None }
    }

    fn pty(data: &str) -> HostEvent {
        HostEvent::PtyData { id: "p".into(), data: data.into() }
    }

    /// Every frame that arrives within `wait`, until the connection closes.
    async fn frames_for(client: &mut Client, wait: Duration) -> Vec<Value> {
        let mut frames = Vec::new();
        let deadline = tokio::time::Instant::now() + wait;
        while let Ok(Some(Ok(line))) = tokio::time::timeout_at(deadline, client.read.next()).await {
            frames.push(serde_json::from_str(&line).unwrap());
        }
        frames
    }

    async fn ended_within(session: tokio::task::JoinHandle<Ended>, wait: Duration) -> Ended {
        tokio::time::timeout(wait, session).await.expect("the session ended in time").unwrap()
    }

    /// Test 2.
    #[tokio::test(flavor = "multi_thread")]
    async fn devices_are_managed_only_from_this_machine() {
        let (daemon, _data) = daemon();
        let phone = add(&daemon, 1, Tier::Full, Threads::ALL);
        let add_frame = json!({ "id": 1, "cmd": "devices_add", "args": { "id": id(2), "label": "Tablet", "tier": "chat" } });

        let mut token = connect_to(&daemon, Trust::Token);
        token.send(json!({ "id": 0, "cmd": "hello", "args": { "protocol": 1, "token": "secret" } })).await;
        token.next().await.unwrap();
        let (mut device, _session) = connect_device(&daemon, &phone, 1 << 16);
        device.hello().await;
        for client in [&mut token, &mut device] {
            for frame in [add_frame.clone(), json!({ "id": 1, "cmd": "devices_list" }), json!({ "id": 1, "cmd": "devices_set_tier", "args": { "id": phone, "tier": "full" } }), json!({ "id": 1, "cmd": "devices_revoke", "args": { "id": phone } })] {
                client.send(frame).await;
                assert_eq!(client.next().await.unwrap(), json!({ "id": 1, "err": "not allowed from a remote connection" }));
            }
        }
        assert_eq!(daemon.devices.list().unwrap().devices.len(), 1);

        let mut local = connect_to(&daemon, Trust::Local);
        local.hello().await;
        local.send(add_frame).await;
        assert_eq!(local.next().await.unwrap()["ok"]["tier"], "chat");
        local.send(json!({ "id": 2, "cmd": "devices_set_tier", "args": { "id": id(2), "tier": "read_only" } })).await;
        assert_eq!(local.next().await.unwrap()["ok"]["tier"], "read_only");
        local.send(json!({ "id": 3, "cmd": "devices_revoke", "args": { "id": id(2) } })).await;
        assert_eq!(local.next().await.unwrap(), json!({ "id": 3, "ok": null }));
        local.send(json!({ "id": 4, "cmd": "devices_list" })).await;
        let list = local.next().await.unwrap();
        assert_eq!(list["ok"]["revoked"][0]["endpointId"], id(2));
        local.send(json!({ "id": 5, "cmd": "devices_set_tier", "args": { "id": id(2), "tier": "superuser" } })).await;
        assert!(local.next().await.unwrap()["err"].is_string());
    }

    /// Test 3.
    #[tokio::test(flavor = "multi_thread")]
    async fn unknown_and_revoked_devices_are_refused_before_any_frame() {
        let (daemon, _data) = daemon();
        let (mut stranger, session) = connect_device(&daemon, &id(9), 1 << 16);
        assert!(stranger.next().await.unwrap()["err"].as_str().unwrap().contains("isn't paired"));
        assert_eq!(stranger.next().await, None);
        assert_eq!(session.await.unwrap(), Ended::Refused);

        let phone = add(&daemon, 1, Tier::Full, Threads::ALL);
        daemon.devices.revoke(&phone).unwrap();
        let (mut revoked, session) = connect_device(&daemon, &phone, 1 << 16);
        assert!(revoked.next().await.unwrap()["err"].as_str().unwrap().contains("isn't paired"));
        assert_eq!(session.await.unwrap(), Ended::Refused);
    }

    /// Test 4: a connected device, and one that never says hello.
    #[tokio::test(flavor = "multi_thread")]
    async fn revoking_a_device_closes_its_session_at_once() {
        let (daemon, _data) = daemon();
        let phone = add(&daemon, 1, Tier::Full, Threads::ALL);
        let (mut client, session) = connect_device(&daemon, &phone, 1 << 16);
        client.hello().await;
        daemon.host.events().emit(pty("before"));
        assert_eq!(client.next().await.unwrap()["payload"]["data"], "before");
        daemon.devices.revoke(&phone).unwrap();
        assert_eq!(ended_within(session, Duration::from_secs(1)).await, Ended::Revoked);
        daemon.host.events().emit(pty("after"));
        assert_eq!(frames_for(&mut client, Duration::from_millis(200)).await, Vec::<Value>::new());

        let tablet = add(&daemon, 2, Tier::Full, Threads::ALL);
        let (_silent, session) = connect_device(&daemon, &tablet, 1 << 16);
        tokio::time::sleep(Duration::from_millis(50)).await;
        daemon.devices.revoke(&tablet).unwrap();
        assert_eq!(ended_within(session, Duration::from_secs(1)).await, Ended::Revoked);
    }

    /// Test 4(b): the daemon's write is blocked on a client that stopped reading.
    #[tokio::test(flavor = "multi_thread")]
    async fn revoking_a_device_that_stopped_reading_still_closes_it() {
        let (daemon, _data) = daemon();
        let phone = add(&daemon, 1, Tier::Full, Threads::ALL);
        let (mut client, session) = connect_device(&daemon, &phone, 256);
        client.hello().await;
        // Far more than the 256-byte pipe holds; nothing reads it.
        for n in 0..200 {
            daemon.host.events().emit(pty(&format!("{n:0>64}")));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!session.is_finished(), "the session is stuck writing");
        daemon.devices.revoke(&phone).unwrap();
        assert_eq!(ended_within(session, Duration::from_secs(1)).await, Ended::Revoked);
    }

    /// Test 4f: the revoke is lost to a lagged receiver; the registry still ends it.
    /// One thread, so nothing runs the session while the revokes pile up.
    #[tokio::test]
    async fn a_revoke_missed_by_a_lagged_receiver_still_closes_the_session() {
        let (daemon, _data) = daemon();
        let phone = add(&daemon, 1, Tier::Full, Threads::ALL);
        for n in 10..(10 + crate::devices::REVOKE_CAPACITY as u8 + 4) {
            add(&daemon, n, Tier::Chat, Threads::ALL);
        }
        let (mut client, session) = connect_device(&daemon, &phone, 1 << 16);
        client.hello().await;
        daemon.devices.revoke(&phone).unwrap();
        // Push the revoke of `phone` out of the channel before the session reads it.
        for n in 10..(10 + crate::devices::REVOKE_CAPACITY as u8 + 4) {
            daemon.devices.revoke(&id(n)).unwrap();
        }
        // Nothing else happens on the connection: only the lag can end it.
        assert_eq!(ended_within(session, Duration::from_secs(1)).await, Ended::Revoked);
        let _ = client.write.send(json!({ "id": 1, "cmd": "session_load" }).to_string()).await;
        assert_eq!(frames_for(&mut client, Duration::from_millis(200)).await, Vec::<Value>::new(), "no reply after the revoke");
    }

    /// Test 4f: revoked after the connect check, before `hello`.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_revoke_between_connecting_and_hello_closes_the_session() {
        let (daemon, _data) = daemon();
        let phone = add(&daemon, 1, Tier::Full, Threads::ALL);
        let (mut client, session) = connect_device(&daemon, &phone, 1 << 16);
        tokio::time::sleep(Duration::from_millis(50)).await;
        daemon.devices.revoke(&phone).unwrap();
        let _ = client.write.send(json!({ "id": 0, "cmd": "hello", "args": { "protocol": 1 } }).to_string()).await;
        let _ = client.write.send(json!({ "id": 1, "cmd": "session_load" }).to_string()).await;
        assert_eq!(ended_within(session, Duration::from_secs(1)).await, Ended::Revoked);
        let frames = frames_for(&mut client, Duration::from_millis(200)).await;
        assert!(frames.iter().all(|f| f["id"] != 1), "{frames:?}");
    }

    /// Tests 4a and 7: thread scope for commands, snapshots, live and replayed events.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_device_limited_to_a_thread_never_reaches_another() {
        let (daemon, _data) = daemon();
        let phone = add(&daemon, 1, Tier::Full, Threads::Only(vec!["a".into()]));
        let mut local = connect_to(&daemon, Trust::Local);
        local.hello().await;
        let session = json!({ "version": 1, "workspaces": [{ "id": "w1" }, { "id": "w2", "name": "Secret" }], "panes": [
            { "id": "a", "kind": "chat", "workspaceId": "w1" }, { "id": "b", "kind": "chat", "workspaceId": "w2" } ] });
        local.send(json!({ "id": 1, "cmd": "session_save", "args": { "session": session } })).await;
        local.until_reply(1).await;

        let (mut client, _session) = connect_device(&daemon, &phone, 1 << 16);
        let hello = client.hello().await;
        client.send(json!({ "id": 1, "cmd": "room_state", "args": { "id": "b" } })).await;
        assert!(client.next().await.unwrap()["err"].as_str().unwrap().contains("thread b"));
        client.send(json!({ "id": 2, "cmd": "room_post", "args": { "id": "b", "text": "hi" } })).await;
        assert!(client.next().await.unwrap()["err"].as_str().unwrap().contains("thread b"));
        client.send(json!({ "id": 3, "cmd": "session_load" })).await;
        let loaded = client.next().await.unwrap();
        assert_eq!(loaded["ok"]["panes"], json!([{ "id": "a", "kind": "chat", "workspaceId": "w1" }]));
        assert!(!loaded.to_string().contains("Secret"));

        daemon.host.events().emit(room("b", 1));
        daemon.host.events().emit(room("a", 2));
        daemon.host.events().emit(room("b", 3));
        let event = client.next().await.unwrap();
        assert_eq!((event["payload"]["room"].clone(), event["seq"].clone()), (json!("a"), json!(hello["ok"]["last_seq"].as_u64().unwrap() + 2)));
        assert_eq!(frames_for(&mut client, Duration::from_millis(200)).await, Vec::<Value>::new());

        // Coming back, the replay is filtered the same way.
        let (mut back, _session) = connect_device(&daemon, &phone, 1 << 16);
        back.send(json!({ "id": 0, "cmd": "hello", "args": { "protocol": 1, "since": { "boot_id": "boot-1", "seq": hello["ok"]["last_seq"] } } })).await;
        assert_eq!(back.next().await.unwrap()["ok"]["resumed"], true);
        let replayed = frames_for(&mut back, Duration::from_millis(200)).await;
        assert_eq!(replayed.iter().map(|f| f["payload"]["room"].clone()).collect::<Vec<_>>(), vec![json!("a")]);
    }

    /// Test 4b: replies don't wait on events the device never gets.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_device_whose_events_are_filtered_still_gets_prompt_replies() {
        let (daemon, _data) = daemon();
        let phone = add(&daemon, 1, Tier::ReadOnly, Threads::Only(vec!["a".into()]));
        let (mut client, _session) = connect_device(&daemon, &phone, 1 << 16);
        client.hello().await;
        for n in 1..=5u64 {
            for k in 0..50 {
                daemon.host.events().emit(room("b", k));
            }
            client.send(json!({ "id": n, "cmd": "agents_detect" })).await;
            let frame = tokio::time::timeout(Duration::from_secs(10), client.next()).await.expect("a prompt reply").unwrap();
            assert_eq!(frame["id"], n, "{frame}");
        }
    }

    /// Tests 4c and 6: a narrower tier or thread list applies to the very next event and command.
    #[tokio::test(flavor = "multi_thread")]
    async fn narrowing_a_device_applies_to_the_next_event_and_command() {
        let (daemon, _data) = daemon();
        let phone = add(&daemon, 1, Tier::Full, Threads::ALL);
        let (mut client, _session) = connect_device(&daemon, &phone, 1 << 16);
        client.hello().await;
        daemon.host.events().emit(pty("one"));
        assert_eq!(client.next().await.unwrap()["payload"]["data"], "one");
        client.send(json!({ "id": 1, "cmd": "folder_list" })).await;
        assert!(client.until_reply(1).await.last().unwrap().get("ok").is_some());

        daemon.devices.set_tier(&phone, Tier::Chat).unwrap();
        daemon.host.events().emit(pty("two"));
        daemon.host.events().emit(room("a", 1));
        assert_eq!(client.next().await.unwrap()["payload"]["room"], "a", "pty output stopped at once");
        client.send(json!({ "id": 2, "cmd": "folder_list" })).await;
        assert!(client.next().await.unwrap()["err"].as_str().unwrap().contains("chat access"));

        daemon.devices.set_threads(&phone, Threads::Only(vec!["c".into()])).unwrap();
        daemon.host.events().emit(room("a", 2));
        daemon.host.events().emit(room("c", 3));
        assert_eq!(client.next().await.unwrap()["payload"]["room"], "c");
    }

    /// A reply carries what it needed; this checks it again as it goes out.
    fn held(daemon: &Daemon, phone: &str, command: Value, result: Value) -> (Option<Guard>, Reply) {
        let command: Command = serde_json::from_value(command).unwrap();
        let guard = Guard { devices: Arc::clone(&daemon.devices), id: phone.to_string(), revokes: daemon.devices.subscribe() };
        let session = matches!(command, Command::SessionLoad {});
        let reply = Reply { after: 0, id: 7, result: Ok(result), need: Some(authority::command_needs(&command)), session };
        (Some(guard), reply)
    }

    fn frame(reply: Result<String, Stop>) -> Value {
        serde_json::from_str(&reply.ok().expect("a frame, not a cut-off")).unwrap()
    }

    /// Narrowing a device while its command runs applies to that command's reply.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_reply_under_way_is_checked_again_against_the_narrowed_device() {
        let (daemon, _data) = daemon();
        let phone = add(&daemon, 1, Tier::Full, Threads::ALL);
        let (guard, reply) = held(&daemon, &phone, json!({ "cmd": "folder_list", "args": {} }), json!(["secret"]));
        daemon.devices.set_tier(&phone, Tier::Chat).unwrap();
        let sent = frame(reply_frame(&guard, reply));
        assert!(sent["err"].as_str().unwrap().contains("chat access"), "{sent}");
        assert_eq!(sent["id"], 7);

        let session = json!({ "panes": [{ "kind": "chat", "id": "a" }, { "kind": "chat", "id": "b" }], "workspaces": [], "layouts": {} });
        let (guard, reply) = held(&daemon, &phone, json!({ "cmd": "session_load", "args": {} }), session);
        daemon.devices.set_threads(&phone, Threads::Only(vec!["a".into()])).unwrap();
        let sent = frame(reply_frame(&guard, reply));
        let panes: Vec<&str> = sent["ok"]["panes"].as_array().unwrap().iter().map(|p| p["id"].as_str().unwrap()).collect();
        assert_eq!(panes, ["a"], "session_load is filtered by the threads allowed now");
        assert!(sent["ok"].get("layouts").is_none());

        let (guard, reply) = held(&daemon, &phone, json!({ "cmd": "session_load", "args": {} }), json!({}));
        daemon.devices.revoke(&phone).unwrap();
        assert!(matches!(reply_frame(&guard, reply), Err(Stop::Revoked)));
    }

    /// An error under way is rechecked too, so it can't leak paths after a downgrade.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_error_under_way_is_checked_again_against_the_narrowed_device() {
        let (daemon, _data) = daemon();
        let phone = add(&daemon, 1, Tier::Full, Threads::ALL);
        let (guard, mut reply) = held(&daemon, &phone, json!({ "cmd": "folder_list", "args": {} }), json!(null));
        reply.result = Err("can't read /Users/someone/secret".into());
        daemon.devices.set_tier(&phone, Tier::Chat).unwrap();
        let sent = frame(reply_frame(&guard, reply));
        let err = sent["err"].as_str().unwrap();
        assert!(err.contains("chat access") && !err.contains("secret"), "{sent}");
        assert_eq!(sent["id"], 7);

        let (guard, mut reply) = held(&daemon, &phone, json!({ "cmd": "folder_list", "args": {} }), json!(null));
        reply.result = Err("can't read /Users/someone/secret".into());
        daemon.devices.revoke(&phone).unwrap();
        assert!(matches!(reply_frame(&guard, reply), Err(Stop::Revoked)));
    }

    /// Test 4e2: global events reach only devices allowed every thread, live and replayed.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_limited_full_device_gets_no_terminal_or_settings_events() {
        let (daemon, _data) = daemon();
        let all = add(&daemon, 1, Tier::Full, Threads::ALL);
        let limited = add(&daemon, 2, Tier::Full, Threads::Only(vec!["a".into()]));
        let (mut everything, _s1) = connect_device(&daemon, &all, 1 << 16);
        let (mut some, _s2) = connect_device(&daemon, &limited, 1 << 16);
        let start = everything.hello().await["ok"]["last_seq"].as_u64().unwrap();
        some.hello().await;
        let mut local = connect_to(&daemon, Trust::Local);
        local.hello().await;
        local.send(json!({ "id": 1, "cmd": "settings_save", "args": { "settings": { "theme": "dark" } } })).await;
        local.until_reply(1).await;
        daemon.host.events().emit(pty("terminal another client opened"));
        daemon.host.events().emit(room("a", 1));

        let names = |frames: &[Value]| frames.iter().map(|f| f["event"].as_str().unwrap_or_default().to_string()).collect::<Vec<_>>();
        assert_eq!(names(&frames_for(&mut everything, Duration::from_millis(300)).await), vec!["settings-changed", "pty-data", "room-event"]);
        assert_eq!(names(&frames_for(&mut some, Duration::from_millis(300)).await), vec!["room-event"]);

        for (device, expected) in [(&all, vec!["settings-changed", "pty-data", "room-event"]), (&limited, vec!["room-event"])] {
            let (mut back, _s) = connect_device(&daemon, device, 1 << 16);
            back.send(json!({ "id": 0, "cmd": "hello", "args": { "protocol": 1, "since": { "boot_id": "boot-1", "seq": start } } })).await;
            back.next().await.unwrap();
            assert_eq!(names(&frames_for(&mut back, Duration::from_millis(300)).await), expected);
        }
    }

    /// Test 5: a revoke survives a restart of the daemon.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_revoked_device_stays_out_after_a_restart() {
        let (daemon, data) = daemon();
        let phone = add(&daemon, 1, Tier::Chat, Threads::ALL);
        add(&daemon, 2, Tier::ReadOnly, Threads::ALL);
        daemon.devices.set_tier(&id(2), Tier::Full).unwrap();
        daemon.devices.revoke(&phone).unwrap();
        let restarted = Arc::new(Daemon {
            host: Host::new(HostPaths { data: data.0.clone(), downloads: None }, tokio::runtime::Handle::current()),
            host_id: "host-1".into(), boot_id: "boot-2".into(), token: None, devices: Arc::new(Devices::open(&data.0)), data: data.0.clone(),
            #[cfg(feature = "remote")]
            invites: Default::default(),
            #[cfg(feature = "remote")]
            endpoint: Default::default(),
        });
        let (mut client, session) = connect_device(&restarted, &phone, 1 << 16);
        assert!(client.next().await.unwrap()["err"].as_str().unwrap().contains("isn't paired"));
        assert_eq!(session.await.unwrap(), Ended::Refused);
        assert_eq!(restarted.devices.get(&id(2)).unwrap().tier, Tier::Full);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_device_never_gets_quit_requests_or_local_only_commands() {
        let (daemon, _data) = daemon();
        let phone = add(&daemon, 1, Tier::Full, Threads::ALL);
        let (mut client, _session) = connect_device(&daemon, &phone, 1 << 16);
        client.hello().await;
        daemon.host.events().emit(HostEvent::QuitRequested(7));
        daemon.host.events().emit(room("a", 1));
        assert_eq!(client.next().await.unwrap()["event"], "room-event");
        client.send(json!({ "id": 1, "cmd": "mod_process_run", "args": { "argv": ["true"] } })).await;
        assert_eq!(client.next().await.unwrap(), json!({ "id": 1, "err": "not allowed from a remote device" }));
        let seen = daemon.devices.get(&phone).unwrap().last_seen;
        assert!(seen.is_some(), "connecting marks the device as seen");
    }

    /// Answers to an approval or question that is no longer waiting fail.
    #[tokio::test(flavor = "multi_thread")]
    async fn stale_approval_and_question_answers_fail() {
        let (daemon, _data) = daemon();
        let mut local = connect_to(&daemon, Trust::Local);
        local.hello().await;
        local.send(json!({ "id": 1, "cmd": "room_create", "args": { "id": "r", "participants": [], "options": { "policy": "mention", "max_bot_hops": 0 } } })).await;
        assert!(local.until_reply(1).await.last().unwrap().get("ok").is_some());
        local.send(json!({ "id": 2, "cmd": "room_decide", "args": { "id": "r", "request": "gone", "approve": true } })).await;
        assert!(local.until_reply(2).await.last().unwrap()["err"].as_str().unwrap().contains("no longer waiting"));
        local.send(json!({ "id": 3, "cmd": "room_answer", "args": { "id": "r", "request": "gone" } })).await;
        assert!(local.until_reply(3).await.last().unwrap()["err"].as_str().unwrap().contains("no longer waiting"));
    }

    // ---- Pairing and remote access, from this machine only ----

    fn pairing_frames() -> Vec<Value> {
        let inv = "AAAAAAAAAAAAAAAAAAAAAA";
        vec![
            json!({ "id": 1, "cmd": "pair_start", "args": { "tier": "full", "threads": "all" } }),
            json!({ "id": 1, "cmd": "pair_wait", "args": { "invitation": inv } }),
            json!({ "id": 1, "cmd": "pair_approve", "args": { "invitation": inv, "claim_id": inv } }),
            json!({ "id": 1, "cmd": "pair_cancel", "args": { "invitation": inv } }),
            json!({ "id": 1, "cmd": "remote_info", "args": {} }),
            json!({ "id": 1, "cmd": "remote_advertise", "args": { "addrs": ["evil.example:1"] } }),
        ]
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn pairing_commands_are_refused_from_a_token_or_a_device() {
        let (daemon, _data) = daemon();
        let phone = add(&daemon, 1, Tier::Full, Threads::ALL);
        let mut token = connect_to(&daemon, Trust::Token);
        token.send(json!({ "id": 0, "cmd": "hello", "args": { "protocol": 1, "token": "secret" } })).await;
        token.next().await.unwrap();
        let (mut device, _session) = connect_device(&daemon, &phone, 1 << 16);
        device.hello().await;
        for client in [&mut token, &mut device] {
            for frame in pairing_frames() {
                client.send(frame.clone()).await;
                assert_eq!(client.next().await.unwrap(), json!({ "id": 1, "err": "not allowed from a remote connection" }), "{frame}");
            }
        }
        assert!(crate::remote_config::advertised(&daemon.data).is_empty(), "nothing was advertised");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_devices_hello_carries_its_access_and_the_advertised_addresses() {
        let (daemon, _data) = daemon();
        std::fs::create_dir_all(&daemon.data).unwrap();
        crate::remote_config::set_advertised(&daemon.data, &["myhome.ddns.net:41641".into()]).unwrap();
        let phone = add(&daemon, 1, Tier::Chat, Threads::Only(vec!["a".into()]));
        let (mut client, _session) = connect_device(&daemon, &phone, 1 << 16);
        let ok = client.hello().await["ok"].clone();
        assert_eq!(ok["access"], json!({ "tier": "chat", "threads": ["a"] }));
        assert_eq!(ok["addrs"], json!(["myhome.ddns.net:41641"]));
        assert_eq!(ok["host_id"], "host-1");

        // The current access, not the one it paired with.
        daemon.devices.set_tier(&phone, Tier::Full).unwrap();
        daemon.devices.set_threads(&phone, Threads::ALL).unwrap();
        let (mut again, _session) = connect_device(&daemon, &phone, 1 << 16);
        assert_eq!(again.hello().await["ok"]["access"], json!({ "tier": "full", "threads": "all" }));

        // Nobody else gets either.
        let mut local = connect_to(&daemon, Trust::Local);
        let ok = local.hello().await["ok"].clone();
        assert!(ok.get("access").is_none() && ok.get("addrs").is_none(), "{ok}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn remote_advertise_checks_saves_and_survives_a_restart() {
        let (daemon, data) = daemon();
        std::fs::create_dir_all(&data.0).unwrap();
        let mut local = connect_to(&daemon, Trust::Local);
        local.hello().await;
        local.send(json!({ "id": 1, "cmd": "remote_advertise", "args": { "addrs": ["nonsense"] } })).await;
        let refused = local.until_reply(1).await.pop().unwrap();
        assert!(refused["err"].as_str().unwrap().contains("host:port"), "{refused}");
        assert_eq!(refused["reason"], "bad_address");
        local.send(json!({ "id": 2, "cmd": "remote_advertise", "args": { "addrs": ["MyHome.ddns.net:41641", "[2001:db8::1]:41641"] } })).await;
        let addrs = json!(["myhome.ddns.net:41641", "[2001:db8::1]:41641"]);
        assert_eq!(local.until_reply(2).await.pop().unwrap(), json!({ "id": 2, "ok": { "advertise": addrs } }));
        local.send(json!({ "id": 3, "cmd": "remote_info" })).await;
        assert_eq!(local.until_reply(3).await.pop().unwrap()["ok"], json!({ "enabled": false, "endpoint_id": null, "port": null, "advertise": addrs }));

        let restarted = Arc::new(Daemon {
            host: Host::new(HostPaths { data: data.0.clone(), downloads: None }, tokio::runtime::Handle::current()),
            host_id: "host-1".into(), boot_id: "boot-2".into(), token: None, devices: Arc::new(Devices::open(&data.0)), data: data.0.clone(),
            #[cfg(feature = "remote")]
            invites: Default::default(),
            #[cfg(feature = "remote")]
            endpoint: Default::default(),
        });
        let mut local = connect_to(&restarted, Trust::Local);
        local.hello().await;
        local.send(json!({ "id": 1, "cmd": "remote_info" })).await;
        assert_eq!(local.until_reply(1).await.pop().unwrap()["ok"]["advertise"], addrs);
        local.send(json!({ "id": 2, "cmd": "remote_advertise", "args": { "addrs": [] } })).await;
        assert_eq!(local.until_reply(2).await.pop().unwrap()["ok"], json!({ "advertise": [] }));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn pair_start_without_remote_access_says_so() {
        let mut local = connect(Trust::Local);
        local.hello().await;
        local.send(json!({ "id": 1, "cmd": "pair_start", "args": { "tier": "chat", "threads": "all" } })).await;
        let refused = local.until_reply(1).await.pop().unwrap();
        assert_eq!(refused["reason"], "not_remote", "{refused}");
        assert!(refused["err"].as_str().unwrap().contains("remote"), "{refused}");
    }

    #[cfg(feature = "remote")]
    #[tokio::test(flavor = "multi_thread")]
    async fn pairing_answers_name_their_reason() {
        let mut local = connect(Trust::Local);
        local.hello().await;
        local.send(json!({ "id": 1, "cmd": "pair_wait", "args": { "invitation": "AAAAAAAAAAAAAAAAAAAAAA" } })).await;
        let unknown = local.until_reply(1).await.pop().unwrap();
        assert_eq!((unknown["reason"].clone(), unknown["err"].clone()), (json!("unknown"), json!("There's no such pairing code. Start again.")));
        local.send(json!({ "id": 2, "cmd": "pair_cancel", "args": { "invitation": "not base64!" } })).await;
        assert_eq!(local.until_reply(2).await.pop().unwrap()["reason"], "bad_request");
        local.send(json!({ "id": 3, "cmd": "pair_start", "args": { "tier": "admin" } })).await;
        assert_eq!(local.until_reply(3).await.pop().unwrap()["reason"], "bad_request");
    }
}
