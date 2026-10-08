//! The iPhone's remote-access bridge (`ApexRemote`): iroh connections and
//! pairing, driven by handles.
//!
//! Every connection or pairing attempt gets a `u64` handle at once, before
//! any dialing; what happens next arrives as events through one registered
//! callback. A handle ends with exactly one `closed` event and nothing after.
//! Nothing here holds a lock across an await.
//!
//! The C functions are at the bottom (`apex_remote_*`). The phone's key comes
//! in as 32 raw bytes, is zeroized once the endpoint is built, and is never
//! returned.
use apex_pairing::{Invite, Transcript};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use futures::{SinkExt, StreamExt};
use iroh::{
    endpoint::{presets, Connection, ConnectionError, PortmapperConfig},
    Endpoint, EndpointAddr, PublicKey, RelayMap, RelayMode, RelayUrl, SecretKey,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex, OnceLock, RwLock,
    },
    time::Duration,
};
use tokio::sync::mpsc;
use tokio_util::{
    codec::{FramedRead, FramedWrite, LinesCodec, LinesCodecError},
    sync::CancellationToken,
    task::TaskTracker,
};
use zeroize::{Zeroize, Zeroizing};

/// Our relay; no other is ever used.
pub const RELAY: &str = apex_pairing::RELAY;
/// A paired phone's session with the daemon.
pub const ALPN: &[u8] = b"apex-deck/1";
/// Pairing with a code from the daemon.
pub const PAIR_ALPN: &[u8] = b"apex-deck/pair/1";
/// The TLS exporter label the pairing transcript binds to.
pub const PAIR_EKM_LABEL: &[u8] = b"EXPORTER-apex-deck-pair-v1";

/// A daemon session line may be this long: the daemon's `DEVICE_MAX_FRAME`
/// (a test checks they match), so a large snapshot isn't a disconnect.
pub const MAX_LINE: usize = 8 * 1024 * 1024;
const PAIR_MAX_LINE: usize = 4 * 1024;
/// Dial plus the pairing exchange up to `claimed`.
const DIAL: Duration = Duration::from_secs(20);
const PAIR_EXCHANGE: Duration = Duration::from_secs(30);
const ROUTE_POLL: Duration = Duration::from_millis(500);

/// Outbound queue per handle: room for one line of the largest size and more.
const OUT_LINES: usize = 256;
const OUT_BYTES: usize = 2 * MAX_LINE;
/// Inbound event queue per handle. A line's event is its JSON text escaped
/// inside another string, which can nearly double it, so the byte budget
/// holds two of the largest.
const IN_EVENTS: usize = 1024;
const IN_BYTES: usize = 4 * MAX_LINE;

/// Handle numbers come from one counter for the whole process, so a handle
/// from before a shutdown never names a connection made after it.
static NEXT_HANDLE: AtomicU64 = AtomicU64::new(1);

/// Close codes this bridge reports for its own reasons. Codes below 1000
/// come from the host (`BYE` 0, `NOT_PAIRED` 1, `REVOKED` 2, `PAIR_*` 10–14).
pub mod close {
    /// `close` or `pairCancel` from the app.
    pub const CLOSED: u32 = 1000;
    /// The app didn't take events fast enough; reconnect and replay.
    pub const OVERFLOW: u32 = 1001;
    /// The dial failed or timed out.
    pub const UNREACHABLE: u32 = 1002;
    /// The machine that answered isn't the one asked for.
    pub const WRONG_HOST: u32 = 1003;
    /// The host said something that isn't the protocol.
    pub const PROTOCOL: u32 = 1004;
    /// The connection dropped without the host closing it.
    pub const LOST: u32 = 1005;
    /// The mode changed, or the bridge shut down.
    pub const STOPPED: u32 = 1006;
    /// Pairing didn't reach `claimed` in time.
    pub const TIMEOUT: u32 = 1007;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Direct first, our relay when that's blocked.
    Automatic,
    /// No relay at all; only addresses the phone was given.
    DirectOnly,
}

impl Mode {
    pub fn parse(s: &str) -> Result<Mode, String> {
        match s {
            "automatic" => Ok(Mode::Automatic),
            "direct" => Ok(Mode::DirectOnly),
            _ => Err(format!("unknown mode {s:?}")),
        }
    }
}

/// Where events go. Called from the bridge's runtime threads (and from the
/// thread calling `close`); it must not call back into the bridge.
pub type Sink = Arc<dyn Fn(&str) + Send + Sync>;

/// One event on its way to the app, with what it counts against the queue.
enum Event {
    Out(Value),
    Closed(u32, String),
}

/// A handle's state. `dead` is the handle's own small lock: every event is
/// sent while holding it and only if the handle isn't dead yet.
struct Slot {
    handle: u64,
    dead: Mutex<bool>,
    cancel: CancellationToken,
    conn: OnceLock<Connection>,
    /// Lines for the host (session connections only).
    out: Option<mpsc::Sender<String>>,
    out_bytes: AtomicUsize,
    inbound: mpsc::Sender<Event>,
    in_bytes: AtomicUsize,
}

struct Inner {
    sink: RwLock<Option<Sink>>,
    relay: Option<RelayUrl>,
    /// Live handles and whether new ones may be made.
    handles: Mutex<(HashMap<u64, Arc<Slot>>, bool)>,
    endpoint: Mutex<Option<(Mode, Endpoint)>>,
    tasks: TaskTracker,
    runtime: tokio::runtime::Handle,
}

impl Slot {
    /// The one final event. The first caller wins; later ones do nothing.
    fn finish(&self, inner: &Inner, code: u32, reason: &str) {
        let mut dead = self.dead.lock().unwrap_or_else(|e| e.into_inner());
        if *dead {
            return;
        }
        *dead = true;
        self.cancel.cancel();
        if let Some(c) = self.conn.get() {
            c.close(code.into(), reason.as_bytes());
        }
        inner.emit(&json!({ "type": "closed", "handle": self.handle, "code": code, "reason": reason }));
        drop(dead);
        inner.forget(self.handle);
    }

    /// Send `event` unless the handle is dead.
    fn deliver(&self, inner: &Inner, event: &Value) {
        let dead = self.dead.lock().unwrap_or_else(|e| e.into_inner());
        if !*dead {
            inner.emit(event);
        }
    }

    /// Queue an event. A full queue closes the handle with `OVERFLOW`
    /// rather than drop it.
    fn push(&self, inner: &Inner, event: Value) {
        let size = event.to_string().len();
        if self.in_bytes.fetch_add(size, Ordering::SeqCst) + size > IN_BYTES || self.inbound.try_send(Event::Out(event)).is_err() {
            self.finish(inner, close::OVERFLOW, "the app fell behind");
        }
    }

    /// The handle's end, after the events queued before it.
    fn end(&self, inner: &Inner, code: u32, reason: String) {
        if let Err(e) = self.inbound.try_send(Event::Closed(code, reason)) {
            let (code, reason) = match e.into_inner() {
                Event::Closed(c, r) => (c, r),
                Event::Out(_) => unreachable!(),
            };
            self.finish(inner, code, &reason);
        }
    }
}

impl Inner {
    fn emit(&self, event: &Value) {
        if let Some(sink) = self.sink.read().unwrap_or_else(|e| e.into_inner()).as_ref() {
            sink(&event.to_string());
        }
    }

    fn forget(&self, handle: u64) {
        self.handles.lock().unwrap_or_else(|e| e.into_inner()).0.remove(&handle);
    }

    fn slot(&self, handle: u64) -> Option<Arc<Slot>> {
        self.handles.lock().unwrap_or_else(|e| e.into_inner()).0.get(&handle).cloned()
    }
}

/// The bridge: one endpoint for the current mode, and its handles.
#[derive(Clone)]
pub struct Bridge(Arc<Inner>);

impl Bridge {
    /// `relay: None` is for tests on one machine; the app always passes ours.
    pub fn new(runtime: tokio::runtime::Handle, relay: Option<RelayUrl>, sink: Sink) -> Bridge {
        Bridge(Arc::new(Inner {
            sink: RwLock::new(Some(sink)),
            relay,
            handles: Mutex::new((HashMap::new(), true)),
            endpoint: Mutex::new(None),
            tasks: TaskTracker::new(),
            runtime,
        }))
    }

    /// Close every handle, wait for their tasks, and bind a new endpoint for
    /// `mode` with this key. The key is zeroized here.
    pub async fn set_mode(&self, key: Zeroizing<[u8; 32]>, mode: Mode) -> Result<String, String> {
        self.stop_all().await;
        let secret = SecretKey::from_bytes(&key);
        drop(key);
        let relay_mode = match (mode, &self.0.relay) {
            (Mode::Automatic, Some(url)) => RelayMode::Custom(RelayMap::from(url.clone())),
            _ => RelayMode::Disabled,
        };
        let endpoint = Endpoint::builder(presets::Minimal)
            .secret_key(secret)
            .relay_mode(relay_mode)
            // No router changes the user didn't make.
            .portmapper_config(PortmapperConfig::Disabled)
            .bind()
            .await
            .map_err(|e| format!("could not start remote access: {e}"))?;
        let id = endpoint.id().to_string();
        *self.0.endpoint.lock().unwrap_or_else(|e| e.into_inner()) = Some((mode, endpoint));
        self.0.handles.lock().unwrap_or_else(|e| e.into_inner()).1 = true;
        Ok(id)
    }

    /// End every handle (`STOPPED`), wait for all tasks, close the endpoint.
    /// New handles are refused until the next `set_mode`.
    async fn stop_all(&self) {
        let slots: Vec<Arc<Slot>> = {
            let mut handles = self.0.handles.lock().unwrap_or_else(|e| e.into_inner());
            handles.1 = false;
            handles.0.values().cloned().collect()
        };
        for slot in slots {
            slot.finish(&self.0, close::STOPPED, "remote access stopped");
        }
        self.0.tasks.close();
        self.0.tasks.wait().await;
        self.0.tasks.reopen();
        let endpoint = self.0.endpoint.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some((_, endpoint)) = endpoint {
            endpoint.close().await;
        }
    }

    /// Stop everything and unregister the callback. Returns only after every
    /// task has ended; no event is sent after it.
    pub async fn shutdown(&self) {
        self.stop_all().await;
        *self.0.sink.write().unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// Live handles and running tasks, for tests and diagnostics.
    pub fn counts(&self) -> (usize, usize) {
        (self.0.handles.lock().unwrap_or_else(|e| e.into_inner()).0.len(), self.0.tasks.len())
    }

    fn endpoint(&self) -> Result<(Mode, Endpoint), String> {
        self.0.endpoint.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or_else(|| "remote access isn't started".to_string())
    }

    /// Make a handle and its event pump. Fails while stopped.
    fn allocate(&self, session: bool) -> Result<(Arc<Slot>, Option<mpsc::Receiver<String>>), String> {
        let (in_tx, mut in_rx) = mpsc::channel(IN_EVENTS);
        let (out_tx, out_rx) = if session {
            let (tx, rx) = mpsc::channel(OUT_LINES);
            (Some(tx), Some(rx))
        } else {
            (None, None)
        };
        let mut handles = self.0.handles.lock().unwrap_or_else(|e| e.into_inner());
        if !handles.1 {
            return Err("remote access isn't started".into());
        }
        let handle = NEXT_HANDLE.fetch_add(1, Ordering::SeqCst);
        let slot = Arc::new(Slot {
            handle,
            dead: Mutex::new(false),
            cancel: CancellationToken::new(),
            conn: OnceLock::new(),
            out: out_tx,
            out_bytes: AtomicUsize::new(0),
            inbound: in_tx,
            in_bytes: AtomicUsize::new(0),
        });
        handles.0.insert(handle, Arc::clone(&slot));
        drop(handles);

        // The pump: events in order, each only while the handle lives.
        let (inner, pump) = (Arc::clone(&self.0), Arc::clone(&slot));
        self.0.tasks.spawn_on(
            async move {
                loop {
                    let event = tokio::select! {
                        biased;
                        _ = pump.cancel.cancelled() => break,
                        event = in_rx.recv() => event,
                    };
                    match event {
                        Some(Event::Out(v)) => {
                            pump.in_bytes.fetch_sub(v.to_string().len(), Ordering::SeqCst);
                            pump.deliver(&inner, &v);
                        }
                        Some(Event::Closed(code, reason)) => {
                            pump.finish(&inner, code, &reason);
                            break;
                        }
                        None => break,
                    }
                }
            },
            &self.0.runtime,
        );
        Ok((slot, out_rx))
    }

    /// Run `work` for `slot` until it ends or the handle is closed.
    fn run<F>(&self, slot: Arc<Slot>, work: F)
    where
        F: std::future::Future<Output = (u32, String)> + Send + 'static,
    {
        let inner = Arc::clone(&self.0);
        self.0.tasks.spawn_on(
            async move {
                tokio::select! {
                    biased;
                    _ = slot.cancel.cancelled() => {}
                    (code, reason) = work => slot.end(&inner, code, reason),
                }
            },
            &self.0.runtime,
        );
    }

    /// Connect to a paired host. Returns the handle before dialing.
    pub fn connect(&self, host: &str, addrs: &[String]) -> Result<u64, String> {
        let (mode, endpoint) = self.endpoint()?;
        let host: PublicKey = host.parse().map_err(|_| "hostEndpointId isn't an endpoint ID".to_string())?;
        let addr = target(host, addrs, mode, self.0.relay.as_ref())?;
        let (slot, out_rx) = self.allocate(true)?;
        let handle = slot.handle;
        let inner = Arc::clone(&self.0);
        let work_slot = Arc::clone(&slot);
        self.run(slot, async move { session(inner, work_slot, endpoint, addr, out_rx.expect("session queue")).await });
        Ok(handle)
    }

    /// Queue a line for the host. Rejects when the queue is full.
    pub fn send(&self, handle: u64, line: String) -> Result<(), String> {
        let slot = self.0.slot(handle).ok_or("no such connection")?;
        let out = slot.out.as_ref().ok_or("that's a pairing attempt, not a connection")?;
        if line.contains('\n') || line.len() > MAX_LINE {
            return Err("a line can't hold a newline or be over 8 MiB".into());
        }
        let size = line.len();
        if slot.out_bytes.fetch_add(size, Ordering::SeqCst) + size > OUT_BYTES {
            slot.out_bytes.fetch_sub(size, Ordering::SeqCst);
            return Err("busy".into());
        }
        out.try_send(line).map_err(|_| {
            slot.out_bytes.fetch_sub(size, Ordering::SeqCst);
            "busy".to_string()
        })
    }

    /// End a connection or pairing attempt now. Its `closed` is sent before
    /// this returns; nothing is sent for it after.
    pub fn close(&self, handle: u64) {
        if let Some(slot) = self.0.slot(handle) {
            slot.finish(&self.0, close::CLOSED, "closed");
        }
    }

    /// Pair with the machine in `link`. Returns the handle before dialing.
    pub fn pair(&self, link: &str, label: &str, now_s: u64) -> Result<u64, String> {
        let (mode, endpoint) = self.endpoint()?;
        let invite = Secret(Invite::parse_link(link, now_s)?);
        let host = PublicKey::from_bytes(&invite.0.host).map_err(|_| "the code names a malformed machine ID".to_string())?;
        let addr = target(host, &invite.0.addrs, mode, self.0.relay.as_ref())?;
        let (slot, _) = self.allocate(false)?;
        let handle = slot.handle;
        let inner = Arc::clone(&self.0);
        let work_slot = Arc::clone(&slot);
        let label = label.chars().filter(|c| !c.is_control()).take(64).collect::<String>();
        self.run(slot, async move { pair(inner, work_slot, endpoint, addr, invite, label).await });
        Ok(handle)
    }
}

/// An invite whose secret is wiped on drop.
struct Secret(Invite);

impl Drop for Secret {
    fn drop(&mut self) {
        self.0.secret.zeroize();
    }
}

/// The address to dial: the given IPs, plus our relay in Automatic. A relay
/// hint is only accepted if it is ours, and dropped in Direct only.
fn target(host: PublicKey, addrs: &[String], mode: Mode, relay: Option<&RelayUrl>) -> Result<EndpointAddr, String> {
    let mut addr = EndpointAddr::new(host);
    for a in addrs {
        if let Ok(ip) = a.parse::<SocketAddr>() {
            addr = addr.with_ip_addr(ip);
        } else if let Ok(url) = a.parse::<RelayUrl>() {
            if Some(&url) != relay && url != RELAY.parse::<RelayUrl>().expect("our relay URL parses") {
                return Err("the address names a relay that isn't ours".into());
            }
        } else {
            return Err(format!("{a:?} isn't an address"));
        }
    }
    if let (Mode::Automatic, Some(url)) = (mode, relay) {
        addr = addr.with_relay_url(url.clone());
    }
    if addr.addrs.is_empty() {
        return Err("no address to try; Direct only needs the machine's IP and UDP port".into());
    }
    Ok(addr)
}

fn route(c: &Connection) -> &'static str {
    match c.paths().iter().find(|p| p.is_selected()) {
        Some(p) if p.is_relay() => "relayed",
        Some(_) => "direct",
        None => "connecting",
    }
}

/// How a connection ended, as `closed` reports it.
fn ended(e: ConnectionError) -> (u32, String) {
    match e {
        ConnectionError::ApplicationClosed(c) => (u32::try_from(c.error_code.into_inner()).unwrap_or(close::PROTOCOL), String::from_utf8_lossy(&c.reason).into_owned()),
        ConnectionError::LocallyClosed => (close::CLOSED, "closed".into()),
        ConnectionError::TimedOut => (close::LOST, "the connection timed out".into()),
        other => (close::LOST, other.to_string()),
    }
}

/// Dial and check the machine that answered is `addr.id` before anything is
/// sent. iroh's TLS already refuses a different key; this is the second check.
async fn dial(endpoint: &Endpoint, addr: EndpointAddr, alpn: &[u8], slot: &Slot) -> Result<Connection, (u32, String)> {
    let expected = addr.id;
    let conn = match tokio::time::timeout(DIAL, endpoint.connect(addr, alpn)).await {
        Ok(Ok(c)) => c,
        Ok(Err(e)) => return Err((close::UNREACHABLE, format!("couldn't reach the machine: {e}"))),
        Err(_) => return Err((close::UNREACHABLE, "the machine didn't answer in time".into())),
    };
    check_host(&conn.remote_id(), &expected).map_err(|reason| {
        conn.close(close::WRONG_HOST.into(), b"not the machine asked for");
        (close::WRONG_HOST, reason)
    })?;
    let _ = slot.conn.set(conn.clone());
    Ok(conn)
}

fn check_host(remote: &PublicKey, expected: &PublicKey) -> Result<(), String> {
    if remote == expected {
        Ok(())
    } else {
        Err("a different machine answered".into())
    }
}

/// A session: open the stream, then move lines both ways and report the route.
async fn session(inner: Arc<Inner>, slot: Arc<Slot>, endpoint: Endpoint, addr: EndpointAddr, mut out_rx: mpsc::Receiver<String>) -> (u32, String) {
    let conn = match dial(&endpoint, addr, ALPN, &slot).await {
        Ok(c) => c,
        Err(e) => return e,
    };
    let (send, recv) = match conn.open_bi().await {
        Ok(s) => s,
        Err(e) => return ended(e),
    };
    let mut input = FramedRead::new(recv, LinesCodec::new_with_max_length(MAX_LINE));
    let mut output = FramedWrite::new(send, LinesCodec::new());
    let mut last = route(&conn);
    slot.push(&inner, json!({ "type": "opened", "handle": slot.handle }));
    slot.push(&inner, json!({ "type": "route", "handle": slot.handle, "route": last }));
    let mut tick = tokio::time::interval(ROUTE_POLL);
    loop {
        tokio::select! {
            line = input.next() => match line {
                Some(Ok(line)) => slot.push(&inner, json!({ "type": "line", "handle": slot.handle, "line": line })),
                Some(Err(LinesCodecError::MaxLineLengthExceeded)) => return (close::PROTOCOL, "the machine sent a line that's too long".into()),
                // A read error means the connection ended; report how.
                Some(Err(LinesCodecError::Io(_))) | None => return ended(conn.closed().await),
            },
            line = out_rx.recv() => {
                let Some(line) = line else { return (close::CLOSED, "closed".into()) };
                slot.out_bytes.fetch_sub(line.len(), Ordering::SeqCst);
                if output.send(line).await.is_err() {
                    return ended(conn.closed().await);
                }
            }
            e = conn.closed() => return ended(e),
            _ = tick.tick() => {
                let now = route(&conn);
                if now != last {
                    last = now;
                    slot.push(&inner, json!({ "type": "route", "handle": slot.handle, "route": now }));
                }
            }
        }
    }
}

/// The phone's proof and six-digit code for one pairing connection.
fn pair_material(secret: &[u8; 32], invitation: &[u8; 16], challenge: &[u8; 32], host: &[u8; 32], phone: &[u8; 32], ekm: &[u8; 32]) -> ([u8; 32], String) {
    let t = Transcript { invitation, challenge, host, phone, ekm };
    (apex_pairing::proof(secret, &t), apex_pairing::code(secret, &t))
}

/// Pairing (`apex-deck/pair/1`), the phone's side: dial, read the challenge,
/// prove, show our own code, wait for the user's answer on the host.
async fn pair(inner: Arc<Inner>, slot: Arc<Slot>, endpoint: Endpoint, addr: EndpointAddr, invite: Secret, label: String) -> (u32, String) {
    let deadline = tokio::time::Instant::now() + PAIR_EXCHANGE;
    let exchange = async {
        let conn = dial(&endpoint, addr, PAIR_ALPN, &slot).await?;
        let (send, recv) = match conn.accept_bi().await {
            Ok(s) => s,
            Err(e) => return Err(ended(e)),
        };
        let mut input = FramedRead::new(recv, LinesCodec::new_with_max_length(PAIR_MAX_LINE));
        let mut output = FramedWrite::new(send, LinesCodec::new());
        let first = next(&conn, &mut input).await?;
        let challenge: [u8; 32] = match (first.get("v").and_then(Value::as_u64), first.get("challenge").and_then(Value::as_str)) {
            (Some(1), Some(c)) => B64.decode(c).ok().and_then(|c| c.try_into().ok()).ok_or((close::PROTOCOL, "the machine sent a bad challenge".to_string()))?,
            _ => return Err((close::PROTOCOL, "the machine doesn't speak this pairing version".into())),
        };
        let host_name = first.get("host_name").and_then(Value::as_str).unwrap_or(&invite.0.name).to_string();
        let mut ekm = Zeroizing::new([0u8; 32]);
        conn.export_keying_material(&mut ekm[..], PAIR_EKM_LABEL, b"").map_err(|_| (close::PROTOCOL, "no keying material".to_string()))?;
        let phone = *endpoint.id().as_bytes();
        let (proof, code) = pair_material(&invite.0.secret, &invite.0.inv, &challenge, conn.remote_id().as_bytes(), &phone, &ekm);
        let ask = json!({ "invitation": B64.encode(invite.0.inv), "label": if label.trim().is_empty() { "iPhone" } else { label.trim() }, "proof": B64.encode(proof) });
        if output.send(ask.to_string()).await.is_err() {
            return Err(ended(conn.closed().await));
        }
        let reply = next(&conn, &mut input).await?;
        if let Some(err) = reply.get("err") {
            return Err(refused(&conn, err).await);
        }
        if reply.get("claimed") != Some(&Value::Bool(true)) {
            return Err((close::PROTOCOL, "the machine sent something unexpected".into()));
        }
        Ok((conn, input, code, host_name))
    };
    let (conn, mut input, code, host_name) = match tokio::time::timeout_at(deadline, exchange).await {
        Ok(Ok(got)) => got,
        Ok(Err(e)) => return e,
        Err(_) => return (close::TIMEOUT, "pairing took too long".into()),
    };
    slot.push(&inner, json!({ "type": "pairCode", "handle": slot.handle, "code": code, "hostName": host_name }));

    // The user's answer on the host, until the invitation ends.
    let answer = match next(&conn, &mut input).await {
        Ok(v) => v,
        Err(e) => return e,
    };
    if let Some(err) = answer.get("err") {
        return refused(&conn, err).await;
    }
    let Some(ok) = answer.get("ok") else {
        return (close::PROTOCOL, "the machine sent something unexpected".into());
    };
    let host_hex: String = invite.0.host.iter().map(|b| format!("{b:02x}")).collect();
    slot.push(
        &inner,
        json!({
            "type": "pairDone", "handle": slot.handle,
            "hostEndpointId": host_hex, "addrs": invite.0.addrs, "name": invite.0.name,
            "hostId": ok.get("host_id"), "hostName": ok.get("host_name"),
            "tier": ok.get("tier"), "threads": ok.get("threads"),
        }),
    );
    ended(conn.closed().await)
}

/// The next JSON line, or how the connection ended.
async fn next(conn: &Connection, input: &mut FramedRead<iroh::endpoint::RecvStream, LinesCodec>) -> Result<Value, (u32, String)> {
    match input.next().await {
        Some(Ok(line)) => serde_json::from_str(&line).map_err(|_| (close::PROTOCOL, "the machine sent a line that isn't JSON".into())),
        Some(Err(LinesCodecError::MaxLineLengthExceeded)) => Err((close::PROTOCOL, "the machine sent a line that's too long".into())),
        Some(Err(LinesCodecError::Io(_))) | None => Err(ended(conn.closed().await)),
    }
}

/// An `{"err"}` line: the host's close code with its text.
async fn refused(conn: &Connection, err: &Value) -> (u32, String) {
    let text = err.as_str().unwrap_or("refused").to_string();
    match tokio::time::timeout(Duration::from_secs(3), conn.closed()).await {
        Ok(e) => (ended(e).0, text),
        Err(_) => (close::PROTOCOL, text),
    }
}

// ---- C ABI ---------------------------------------------------------------

/// Called with each event as NUL-terminated JSON, valid only for the call.
pub type EventCallback = extern "C" fn(ctx: *mut std::ffi::c_void, event: *const std::ffi::c_char);

struct Ctx(*mut std::ffi::c_void);
// The context is only handed back to the callback, which the app makes thread-safe.
unsafe impl Send for Ctx {}
unsafe impl Sync for Ctx {}
impl Ctx {
    // A method, so closures capture the whole `Ctx` rather than its raw pointer.
    fn ptr(&self) -> *mut std::ffi::c_void {
        self.0
    }
}

static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
static BRIDGE: Mutex<Option<Bridge>> = Mutex::new(None);

fn runtime() -> &'static tokio::runtime::Runtime {
    RUNTIME.get_or_init(|| tokio::runtime::Builder::new_multi_thread().worker_threads(2).thread_name("apex-remote").enable_all().build().expect("tokio runtime"))
}

fn bridge() -> Result<Bridge, String> {
    BRIDGE.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or_else(|| "remote access isn't started".into())
}

fn out(result: Result<Value, String>) -> *mut std::ffi::c_char {
    let v = match result {
        Ok(v) => json!({ "ok": v }),
        Err(e) => json!({ "error": e }),
    };
    std::ffi::CString::new(v.to_string()).expect("JSON has no NUL").into_raw()
}

fn guarded(f: impl FnOnce() -> Result<Value, String>) -> *mut std::ffi::c_char {
    out(std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).unwrap_or_else(|_| Err("the remote bridge failed".into())))
}

/// Register the event callback. Returns false if one is already registered
/// (call `apex_remote_shutdown` first).
#[no_mangle]
pub extern "C" fn apex_remote_init(callback: EventCallback, ctx: *mut std::ffi::c_void) -> bool {
    let mut slot = BRIDGE.lock().unwrap_or_else(|e| e.into_inner());
    if slot.is_some() {
        return false;
    }
    let ctx = Ctx(ctx);
    let sink: Sink = Arc::new(move |event: &str| {
        if let Ok(c) = std::ffi::CString::new(event) {
            callback(ctx.ptr(), c.as_ptr());
        }
    });
    *slot = Some(Bridge::new(runtime().handle().clone(), Some(RELAY.parse().expect("our relay URL parses")), sink));
    true
}

/// The endpoint ID for a 32-byte key, as `{"ok":"<hex>"}`.
///
/// # Safety
/// `key` points to 32 readable bytes.
#[no_mangle]
pub unsafe extern "C" fn apex_remote_endpoint_id(key: *const u8) -> *mut std::ffi::c_char {
    guarded(|| {
        if key.is_null() {
            return Err("missing key".into());
        }
        let mut bytes = Zeroizing::new([0u8; 32]);
        bytes.copy_from_slice(std::slice::from_raw_parts(key, 32));
        Ok(json!(SecretKey::from_bytes(&bytes).public().to_string()))
    })
}

/// Close everything and bind for `mode` ("automatic" or "direct") with this
/// key. Blocks until done; call off the main thread. Returns the endpoint ID.
///
/// # Safety
/// `key` points to 32 readable bytes; `mode` is NUL-terminated UTF-8.
#[no_mangle]
pub unsafe extern "C" fn apex_remote_set_mode(key: *const u8, mode: *const std::ffi::c_char) -> *mut std::ffi::c_char {
    guarded(|| {
        if key.is_null() || mode.is_null() {
            return Err("missing argument".into());
        }
        let mut bytes = Zeroizing::new([0u8; 32]);
        bytes.copy_from_slice(std::slice::from_raw_parts(key, 32));
        let mode = Mode::parse(std::ffi::CStr::from_ptr(mode).to_str().map_err(|_| "mode isn't UTF-8")?)?;
        let bridge = bridge()?;
        runtime().block_on(bridge.set_mode(bytes, mode)).map(Value::String)
    })
}

/// `{"op":"connect"|"send"|"close"|"pair"|"pairCancel", …}`. Never waits on
/// the network.
///
/// # Safety
/// `input` is NUL-terminated UTF-8 JSON.
#[no_mangle]
pub unsafe extern "C" fn apex_remote_call(input: *const std::ffi::c_char) -> *mut std::ffi::c_char {
    guarded(|| {
        if input.is_null() {
            return Err("missing input".into());
        }
        let v: Value = serde_json::from_str(std::ffi::CStr::from_ptr(input).to_str().map_err(|_| "input isn't UTF-8")?).map_err(|_| "input isn't JSON")?;
        let bridge = bridge()?;
        let s = |k: &str| v.get(k).and_then(Value::as_str).ok_or_else(|| format!("{k} is required"));
        let h = || v.get("handle").and_then(Value::as_u64).ok_or_else(|| "handle is required".to_string());
        // Entered so iroh can spawn from this (non-runtime) thread.
        let _rt = runtime().enter();
        match v.get("op").and_then(Value::as_str).unwrap_or("") {
            "connect" => {
                let addrs: Vec<String> = v.get("addrs").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
                bridge.connect(s("hostEndpointId")?, &addrs).map(|h| json!({ "handle": h }))
            }
            "send" => bridge.send(h()?, s("line")?.to_string()).map(|_| json!({})),
            "close" | "pairCancel" => {
                bridge.close(h()?);
                Ok(json!({}))
            }
            "pair" => {
                let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                bridge.pair(s("link")?, v.get("label").and_then(Value::as_str).unwrap_or("iPhone"), now).map(|h| json!({ "handle": h }))
            }
            other => Err(format!("unknown operation {other:?}")),
        }
    })
}

/// Close everything, wait for every task, unregister the callback. No event
/// arrives after this returns. Blocks; call off the main thread.
#[no_mangle]
pub extern "C" fn apex_remote_shutdown() {
    let taken = BRIDGE.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(bridge) = taken {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| runtime().block_on(bridge.shutdown())));
    }
}

/// Free a string returned by this library, once. NULL is fine.
///
/// # Safety
/// `s` came from an `apex_remote_*` call and hasn't been freed.
#[no_mangle]
pub unsafe extern "C" fn apex_remote_string_free(s: *mut std::ffi::c_char) {
    if !s.is_null() {
        drop(std::ffi::CString::from_raw(s));
    }
}

#[cfg(test)]
mod tests;
