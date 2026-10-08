//! `serve --remote`: an iroh endpoint beside the local listeners, so paired
//! phones reach this machine from anywhere. iroh tries a direct path first
//! and falls back to our relay; it never asks the router to open a port.
//!
//! A connection is identified by the endpoint ID iroh authenticated. Unknown
//! or revoked IDs are closed with a reason code before any frame is read; a
//! paired device gets one stream that speaks the usual protocol as
//! `Trust::Device`.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use futures::{SinkExt, StreamExt};
use iroh::endpoint::{presets, Connection, PortmapperConfig, RecvStream, SendStream};
use iroh::{Endpoint, RelayMap, RelayMode, RelayUrl, SecretKey};
use serde_json::{json, Value};
use tokio_util::codec::{FramedRead, FramedWrite, LinesCodec};

use crate::pairing::invites::{ClaimConn, InviteId, PairError};
use crate::pairing::{self, Transcript};
use crate::protocol::{self, Daemon, Ended, Trust, DEVICE_MAX_FRAME, HELLO_WAIT};
use crate::{devices, files};

/// The ALPN a paired phone dials.
pub const ALPN: &[u8] = b"apex-deck/1";

/// The ALPN a phone dials to pair with a code from this machine.
pub const PAIR_ALPN: &[u8] = b"apex-deck/pair/1";

/// The TLS exporter label both sides bind a pairing proof to (empty
/// context, 32 bytes).
pub const PAIR_EKM_LABEL: &[u8] = b"EXPORTER-apex-deck-pair-v1";

/// The only relay remote access uses.
pub const RELAY: &str = "https://relay.apex-terminal.xyz/";

/// The endpoint's secret key, owner-only. On a Mac this moves to the
/// Keychain before release.
pub const KEY_FILE: &str = "iroh-key";

/// The UDP port chosen at first start, kept so a forwarded port stays right,
/// and the advertised addresses (see `remote_config`).
pub const PORT_FILE: &str = crate::remote_config::FILE;

/// Why a connection was closed, as its QUIC close code.
pub mod close {
    pub const BYE: u32 = 0;
    pub const NOT_PAIRED: u32 = 1;
    pub const REVOKED: u32 = 2;
    pub use crate::pairing::close::*;
}

/// Load the endpoint's key from `<data>/iroh-key`, making one the first time.
pub fn key(data: &Path) -> Result<SecretKey, String> {
    let path = data.join(KEY_FILE);
    match std::fs::read_to_string(&path) {
        Ok(text) => {
            let text = text.trim();
            let mut bytes = [0u8; 32];
            if text.len() != 64 {
                return Err(format!("{} must hold 64 hex characters", path.display()));
            }
            for (i, byte) in bytes.iter_mut().enumerate() {
                *byte = u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).map_err(|_| format!("{} must hold 64 hex characters", path.display()))?;
            }
            Ok(SecretKey::from_bytes(&bytes))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let key = SecretKey::generate();
            let hex: String = key.to_bytes().iter().map(|b| format!("{b:02x}")).collect();
            files::write_private(&path, &format!("{hex}\n"))?;
            Ok(key)
        }
        Err(e) => Err(format!("could not read {}: {e}", path.display())),
    }
}

/// The port to bind: `--remote-port`, else the one saved at first start, else
/// 0 (the system picks; it's saved once bound).
pub fn port(data: &Path, flag: Option<u16>) -> u16 {
    flag.or_else(|| crate::remote_config::port(data)).unwrap_or(0)
}

/// Bind the endpoint. `relay: None` is for tests on one machine.
pub async fn bind(key: SecretKey, relay: Option<&str>, port: u16) -> Result<Endpoint, String> {
    let relay_mode = match relay {
        None => RelayMode::Disabled,
        Some(url) => RelayMode::Custom(RelayMap::from(url.parse::<RelayUrl>().map_err(|e| format!("relay {url}: {e}"))?)),
    };
    let builder = Endpoint::builder(presets::Minimal)
        .secret_key(key)
        .relay_mode(relay_mode)
        // No router changes the user didn't make.
        .portmapper_config(PortmapperConfig::Disabled)
        .alpns(vec![ALPN.to_vec(), PAIR_ALPN.to_vec()])
        .clear_ip_transports()
        .bind_addr(format!("0.0.0.0:{port}").as_str())
        .map_err(|e| e.to_string())?
        .bind_addr(format!("[::]:{port}").as_str())
        .map_err(|e| e.to_string())?;
    builder.bind().await.map_err(|e| format!("could not start remote access on UDP port {port}: {e}"))
}

/// Start remote access: bind, save the port, and say how to reach us.
pub async fn start(data: &Path, flag: Option<u16>) -> Result<(Endpoint, Value), String> {
    let endpoint = bind(key(data)?, Some(RELAY), port(data, flag)).await?;
    let bound = endpoint.bound_sockets().iter().map(|a| a.port()).find(|p| *p != 0).unwrap_or(0);
    // Keeps the advertised addresses saved beside it.
    crate::remote_config::save_port(data, bound)?;
    let info = json!({ "endpoint_id": endpoint.id().to_string(), "port": bound, "relay": RELAY, "advertise": crate::remote_config::advertised(data) });
    Ok((endpoint, info))
}

/// Accept connections until the endpoint closes.
pub async fn accept(daemon: Arc<Daemon>, endpoint: Endpoint) {
    let host = endpoint.id();
    while let Some(incoming) = endpoint.accept().await {
        let daemon = Arc::clone(&daemon);
        tokio::spawn(async move {
            match tokio::time::timeout(HELLO_WAIT, incoming).await {
                Ok(Ok(connection)) if connection.alpn() == PAIR_ALPN => pair_serve(daemon, connection, host).await,
                Ok(Ok(connection)) => serve(daemon, connection).await,
                Ok(Err(e)) => eprintln!("apex-daemon: a remote connection failed to set up: {e}"),
                Err(_) => eprintln!("apex-daemon: a remote connection took too long to set up"),
            }
        });
    }
}

/// Serve one authenticated connection.
pub async fn serve(daemon: Arc<Daemon>, connection: Connection) {
    let id = connection.remote_id().to_string();
    // Hear of revokes before the check, so one in between isn't missed.
    let mut revokes = daemon.devices.subscribe();
    if daemon.devices.get(&id).is_none() {
        connection.close(close::NOT_PAIRED.into(), b"this device isn't paired with this machine");
        return;
    }
    let stream = tokio::select! {
        stream = tokio::time::timeout(HELLO_WAIT, connection.accept_bi()) => stream,
        _ = async {
            loop {
                match revokes.recv().await {
                    Ok(revoked) if revoked == id => return,
                    Ok(_) => {}
                    Err(_) if daemon.devices.get(&id).is_none() => return,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => std::future::pending::<()>().await,
                    Err(_) => {}
                }
            }
        } => {
            connection.close(close::REVOKED.into(), b"revoked");
            return;
        }
    };
    let Ok(Ok((send, recv))) = stream else {
        connection.close(close::BYE.into(), b"no stream");
        return;
    };
    let (input, output) = protocol::lines_up_to(recv, send, DEVICE_MAX_FRAME);
    let ended = protocol::serve(daemon, Trust::Device(id), input, output).await;
    let (code, reason): (u32, &[u8]) = match ended {
        Ended::Closed => (close::BYE, b"bye"),
        Ended::Refused => (close::NOT_PAIRED, b"refused"),
        Ended::Revoked => (close::REVOKED, b"revoked"),
    };
    connection.close(code.into(), reason);
}

/// A pairing line is at most this long.
pub const PAIR_MAX_LINE: usize = 4 * 1024;

/// From connect until the host replies `claimed`. After that the phone may
/// wait for the user's answer until the invitation expires.
pub const PAIR_EXCHANGE: Duration = Duration::from_secs(30);

/// How long a last line (`ok` or `err`) gets to arrive before the close.
pub const PAIR_LAST_LINE: Duration = Duration::from_secs(1);

/// The longest label a phone may give itself, in characters.
pub const PAIR_MAX_LABEL: usize = 64;

/// What the phone sends in step 2.
struct Ask {
    invitation: InviteId,
    label: String,
    proof: [u8; 32],
}

impl Ask {
    fn parse(line: &str) -> Option<Ask> {
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Wire {
            invitation: String,
            label: String,
            proof: String,
        }
        let wire: Wire = serde_json::from_str(line).ok()?;
        let label: String = wire.label.chars().filter(|c| !c.is_control()).take(PAIR_MAX_LABEL).collect();
        let label = label.trim();
        Some(Ask {
            invitation: B64.decode(wire.invitation).ok()?.try_into().ok()?,
            label: if label.is_empty() { "Phone".to_string() } else { label.to_string() },
            proof: B64.decode(wire.proof).ok()?.try_into().ok()?,
        })
    }
}

/// The claimed connection, as invitations see it. A close from there
/// (expiry, cancel, a failed approval) marks it closed at once, so it is
/// never approved after; `pair_serve` hears the same outcome from
/// `settled` and sends its `err` line before closing with the code. If that
/// hasn't happened within twice `PAIR_LAST_LINE`, the connection is closed
/// here anyway.
struct PairConn {
    connection: Connection,
    closing: std::sync::atomic::AtomicBool,
    runtime: tokio::runtime::Handle,
}

impl ClaimConn for PairConn {
    fn is_open(&self) -> bool {
        !self.closing.load(std::sync::atomic::Ordering::SeqCst) && self.connection.close_reason().is_none()
    }

    fn close(&self, code: u32) {
        self.closing.store(true, std::sync::atomic::Ordering::SeqCst);
        let connection = self.connection.clone();
        self.runtime.spawn(async move {
            tokio::time::sleep(PAIR_LAST_LINE * 2).await;
            connection.close(code.into(), b"pairing over");
        });
    }
}

type Lines = (FramedRead<RecvStream, LinesCodec>, FramedWrite<SendStream, LinesCodec>);

/// Send a last line, give it `PAIR_LAST_LINE` to arrive, then close.
async fn pair_end(output: &mut FramedWrite<SendStream, LinesCodec>, connection: &Connection, line: Value, code: u32, reason: &[u8]) {
    let _ = tokio::time::timeout(PAIR_LAST_LINE, async {
        output.send(line.to_string()).await.ok()?;
        output.get_mut().finish().ok()?;
        output.get_ref().stopped().await.ok()
    })
    .await;
    connection.close(code.into(), reason);
}

/// Pair a phone (`apex-deck/pair/1`). `host` is this endpoint's own ID,
/// which goes into the transcript. Only the pairing exchange is spoken
/// here; no daemon command is ever run on this connection.
pub async fn pair_serve(daemon: Arc<Daemon>, connection: Connection, host: iroh::EndpointId) {
    let Some(host_name) = daemon.invites.live_name(devices::now_ms()) else {
        connection.close(close::PAIR_UNKNOWN.into(), b"no pairing code is open on this machine");
        return;
    };
    let Some(_slot) = daemon.invites.conn_slot() else {
        connection.close(close::BYE.into(), b"too many pairing connections");
        return;
    };
    let deadline = tokio::time::Instant::now() + PAIR_EXCHANGE;

    // Steps 1–2, within the deadline.
    let exchange = async {
        let (send, recv) = connection.open_bi().await.ok()?;
        let (mut input, mut output): Lines = protocol::lines_up_to(recv, send, PAIR_MAX_LINE);
        let mut challenge = [0u8; 32];
        getrandom::fill(&mut challenge).expect("the system's random source failed");
        output.send(json!({ "v": 1, "challenge": B64.encode(challenge), "host_name": host_name }).to_string()).await.ok()?;
        let line = input.next().await?.ok()?;
        Some((output, challenge, line))
    };
    let (mut output, challenge, line) = match tokio::time::timeout_at(deadline, exchange).await {
        Ok(Some(got)) => got,
        Ok(None) => return connection.close(close::BYE.into(), b"no pairing request"),
        Err(_) => return connection.close(close::BYE.into(), b"pairing took too long"),
    };
    #[cfg(test)]
    daemon.invites.frames_read.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let Some(ask) = Ask::parse(&line) else {
        return pair_end(&mut output, &connection, json!({ "err": "That's not a pairing request." }), close::BYE, b"not a pairing request").await;
    };

    // Step 3: the invitation, then the proof.
    let now = devices::now_ms();
    let refuse = |e: PairError| (json!({ "err": e.to_string() }), e.close_code());
    let secret = match daemon.invites.secret(&ask.invitation, now) {
        Ok(secret) => secret,
        Err(e) => {
            let (line, code) = refuse(e);
            return pair_end(&mut output, &connection, line, code, b"refused").await;
        }
    };
    let mut ekm = [0u8; 32];
    if connection.export_keying_material(&mut ekm, PAIR_EKM_LABEL, b"").is_err() {
        return connection.close(close::BYE.into(), b"no keying material");
    }
    let phone = connection.remote_id();
    let transcript = Transcript { invitation: &ask.invitation, challenge: &challenge, host: host.as_bytes(), phone: phone.as_bytes(), ekm: &ekm };
    let proof_ok = pairing::verify(&secret, &transcript, &ask.proof);
    let code = pairing::code(&secret, &transcript);
    let conn = Arc::new(PairConn { connection: connection.clone(), closing: Default::default(), runtime: tokio::runtime::Handle::current() });
    let claim = match daemon.invites.claim(&daemon.devices, &ask.invitation, &phone.to_string(), &ask.label, code, proof_ok, conn, now) {
        Ok(claim) => claim,
        Err(e) => {
            let (line, code) = refuse(e);
            return pair_end(&mut output, &connection, line, code, b"refused").await;
        }
    };

    // Step 4, still within the deadline; a phone gone by now burns it.
    let claimed = tokio::time::timeout_at(deadline, output.send(json!({ "claimed": true }).to_string())).await;
    if !matches!(claimed, Ok(Ok(()))) {
        daemon.invites.phone_left(&ask.invitation, &claim.claim_id);
        return connection.close(close::BYE.into(), b"pairing took too long");
    }

    // Steps 5–6: the user's answer, expiry, cancel or the phone leaving.
    // Waiting here is also what expires a claimed invitation on time.
    let outcome = tokio::select! {
        outcome = daemon.invites.settled(&ask.invitation, &claim.claim_id) => outcome,
        _ = connection.closed() => {
            daemon.invites.phone_left(&ask.invitation, &claim.claim_id);
            return;
        }
    };
    match outcome {
        Ok(device) => {
            let ok = json!({ "ok": { "host_id": daemon.host_id, "host_name": host_name, "tier": device.tier, "threads": device.threads } });
            pair_end(&mut output, &connection, ok, close::BYE, b"paired").await;
        }
        Err(e) => {
            let (line, code) = refuse(e);
            pair_end(&mut output, &connection, line, code, b"not paired").await;
        }
    }
}

/// The phone's side of pairing, for tests: what the iPhone bridge does,
/// using the same `apex_pairing` functions.
#[cfg(test)]
pub mod pair_phone {
    use super::*;
    use crate::pairing::Invite;
    use iroh::endpoint::ConnectionError;
    use iroh::{EndpointAddr, PublicKey};
    use std::net::SocketAddr;

    /// How the host closed the connection: its close code and reason (or
    /// the `{"err"}` text it sent first). `u32::MAX` when it wasn't an
    /// application close, e.g. the dial itself failed.
    pub type Refused = (u32, String);

    pub async fn closed_with(connection: &Connection) -> Refused {
        match tokio::time::timeout(Duration::from_secs(5), connection.closed()).await {
            Ok(ConnectionError::ApplicationClosed(c)) => (u32::try_from(c.error_code.into_inner()).unwrap_or(u32::MAX), String::from_utf8_lossy(&c.reason).into_owned()),
            Ok(other) => (u32::MAX, other.to_string()),
            Err(_) => (u32::MAX, "still open".into()),
        }
    }

    pub struct PairPhone {
        /// Kept: dropping it would stop the phone's side of the connection.
        pub endpoint: Endpoint,
        pub connection: Connection,
        input: FramedRead<RecvStream, LinesCodec>,
        output: FramedWrite<SendStream, LinesCodec>,
        pub challenge: [u8; 32],
        pub host_name: String,
        phone: [u8; 32],
        host: [u8; 32],
        ekm: [u8; 32],
    }

    impl PairPhone {
        /// Dial the invite's host at `at` and read the challenge. Checks the
        /// host iroh authenticated is the invite's before reading anything.
        pub async fn connect(key: SecretKey, at: SocketAddr, invite: &Invite) -> Result<PairPhone, Refused> {
            let phone = *key.public().as_bytes();
            let endpoint = bind(key, None, 0).await.unwrap();
            let host = PublicKey::from_bytes(&invite.host).map_err(|e| (u32::MAX, e.to_string()))?;
            let addr: EndpointAddr = serde_json::from_value(json!({ "id": host.to_string(), "addrs": [{ "Ip": at.to_string() }] })).unwrap();
            let connection = match tokio::time::timeout(Duration::from_secs(10), endpoint.connect(addr, PAIR_ALPN)).await {
                Ok(Ok(connection)) => connection,
                Ok(Err(e)) => return Err((u32::MAX, e.to_string())),
                Err(_) => return Err((u32::MAX, "dial timed out".into())),
            };
            if connection.remote_id().as_bytes() != &invite.host {
                connection.close(close::BYE.into(), b"not the host in the code");
                return Err((u32::MAX, "wrong host".into()));
            }
            let (send, recv) = match tokio::time::timeout(Duration::from_secs(10), connection.accept_bi()).await {
                Ok(Ok(streams)) => streams,
                _ => return Err(closed_with(&connection).await),
            };
            let (mut input, output) = protocol::lines_up_to(recv, send, 4096);
            let first = match tokio::time::timeout(Duration::from_secs(10), input.next()).await {
                Ok(Some(Ok(line))) => serde_json::from_str::<Value>(&line).unwrap(),
                _ => return Err(closed_with(&connection).await),
            };
            assert_eq!(first["v"], 1, "{first}");
            let challenge: [u8; 32] = B64.decode(first["challenge"].as_str().unwrap()).unwrap().try_into().unwrap();
            let mut ekm = [0u8; 32];
            connection.export_keying_material(&mut ekm, PAIR_EKM_LABEL, b"").unwrap();
            let host = *connection.remote_id().as_bytes();
            Ok(PairPhone { endpoint, connection, input, output, challenge, host_name: first["host_name"].as_str().unwrap().to_string(), phone, host, ekm })
        }

        fn transcript<'a>(&'a self, invite: &'a Invite, phone: &'a [u8; 32]) -> Transcript<'a> {
            Transcript { invitation: &invite.inv, challenge: &self.challenge, host: &self.host, phone, ekm: &self.ekm }
        }

        /// The proof as if this phone's ID were `phone`.
        pub fn proof_as(&self, invite: &Invite, phone: &[u8; 32]) -> [u8; 32] {
            pairing::proof(&invite.secret, &self.transcript(invite, phone))
        }

        pub fn proof(&self, invite: &Invite) -> [u8; 32] {
            self.proof_as(invite, &self.phone)
        }

        /// The code this phone shows, from its own transcript.
        pub fn code(&self, invite: &Invite) -> String {
            pairing::code(&invite.secret, &self.transcript(invite, &self.phone))
        }

        pub async fn send(&mut self, frame: Value) {
            self.output.send(frame.to_string()).await.unwrap();
        }

        /// The next line, or how the connection was closed.
        pub async fn next(&mut self) -> Result<Value, Refused> {
            match tokio::time::timeout(Duration::from_secs(10), self.input.next()).await {
                Ok(Some(Ok(line))) => Ok(serde_json::from_str(&line).unwrap()),
                _ => Err(closed_with(&self.connection).await),
            }
        }

        /// Ask for the invitation with `proof`: `claimed`, or why not.
        pub async fn claim_with(&mut self, invite: &Invite, proof: &[u8; 32]) -> Result<Value, Refused> {
            self.send(json!({ "invitation": B64.encode(invite.inv), "label": "Tyler's iPhone", "proof": B64.encode(proof) })).await;
            self.reply().await
        }

        /// A reply line; an `{"err"}` line is followed by the close code.
        pub async fn reply(&mut self) -> Result<Value, Refused> {
            let line = self.next().await?;
            match line.get("err") {
                Some(err) => Err((closed_with(&self.connection).await.0, err.as_str().unwrap_or_default().to_string())),
                None => Ok(line),
            }
        }
    }

    /// Play the phone: dial, prove, wait for the user's answer. `Ok` holds
    /// the host's `ok` object.
    pub async fn pair_dial(key: SecretKey, at: SocketAddr, invite: &Invite) -> Result<Value, Refused> {
        let mut phone = PairPhone::connect(key, at, invite).await?;
        let proof = phone.proof(invite);
        let claimed = phone.claim_with(invite, &proof).await?;
        assert_eq!(claimed, json!({ "claimed": true }));
        let answer = phone.reply().await?;
        Ok(answer["ok"].clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devices::{Devices, Threads, Tier};
    use apex_host::{Host, HostPaths};
    use futures::{SinkExt, StreamExt};
    use iroh::endpoint::{ConnectionError, VarInt};
    use iroh::EndpointAddr;
    use std::time::Duration;

    async fn daemon(data: &Path) -> (Arc<Daemon>, Endpoint) {
        let host = Host::new(HostPaths { data: data.to_path_buf(), downloads: None }, tokio::runtime::Handle::current());
        let daemon = Arc::new(Daemon { host, host_id: "host-1".into(), boot_id: "boot-1".into(), token: None, devices: Arc::new(Devices::open(data)), data: data.to_path_buf(), invites: Default::default(), endpoint: Default::default() });
        let endpoint = bind(key(data).unwrap(), None, 0).await.unwrap();
        tokio::spawn(accept(Arc::clone(&daemon), endpoint.clone()));
        (daemon, endpoint)
    }

    /// Where `server` listens on this machine, with no relay.
    fn local_addr(server: &Endpoint) -> EndpointAddr {
        let port = server.bound_sockets().iter().map(|a| a.port()).find(|p| *p != 0).unwrap();
        serde_json::from_value(json!({ "id": server.id().to_string(), "addrs": [{ "Ip": format!("127.0.0.1:{port}") }] })).unwrap()
    }

    struct Phone {
        /// Kept: dropping it would stop the phone's side of the connection.
        _endpoint: Endpoint,
        connection: Connection,
        input: tokio_util::codec::FramedRead<iroh::endpoint::RecvStream, tokio_util::codec::LinesCodec>,
        output: tokio_util::codec::FramedWrite<iroh::endpoint::SendStream, tokio_util::codec::LinesCodec>,
    }

    impl Phone {
        async fn dial(key: SecretKey, server: &Endpoint) -> Phone {
            let client = bind(key, None, 0).await.unwrap();
            let connection = client.connect(local_addr(server), ALPN).await.unwrap();
            let (send, recv) = connection.open_bi().await.unwrap();
            let (input, output) = protocol::lines(recv, send);
            Phone { _endpoint: client, connection, input, output }
        }

        async fn call(&mut self, frame: Value) -> Option<Value> {
            self.output.send(frame.to_string()).await.ok()?;
            let line = tokio::time::timeout(Duration::from_secs(10), self.input.next()).await.ok()??.ok()?;
            Some(serde_json::from_str(&line).unwrap())
        }

        async fn closed_with(&self) -> Option<VarInt> {
            match tokio::time::timeout(Duration::from_secs(2), self.connection.closed()).await.expect("closed in time") {
                ConnectionError::ApplicationClosed(close) => Some(close.error_code),
                _ => None,
            }
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_paired_phone_is_served_within_its_tier() {
        let data = crate::devices::tests::folder();
        let (daemon, server) = daemon(&data.0).await;
        let phone_key = SecretKey::generate();
        daemon.devices.add(&phone_key.public().to_string(), "Phone", Tier::Chat, Threads::ALL, false).unwrap();

        let mut phone = Phone::dial(phone_key, &server).await;
        let hello = phone.call(json!({ "id": 0, "cmd": "hello", "args": { "protocol": 1 } })).await.unwrap();
        assert_eq!(hello["ok"]["host_id"], "host-1");
        let refused = phone.call(json!({ "id": 1, "cmd": "pty_spawn", "args": { "id": "p", "cols": 80, "rows": 24 } })).await.unwrap();
        assert!(refused["err"].as_str().unwrap().contains("chat access"), "{refused}");
        let state = phone.call(json!({ "id": 2, "cmd": "room_state", "args": { "id": "nope" } })).await.unwrap();
        assert_eq!(state["id"], 2);
        assert!(daemon.devices.get(&phone.connection.remote_id().to_string()).is_none(), "the phone sees the server's ID");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_revoked_phone_is_closed_with_the_revoked_code() {
        let data = crate::devices::tests::folder();
        let (daemon, server) = daemon(&data.0).await;
        let phone_key = SecretKey::generate();
        let phone_id = phone_key.public().to_string();
        daemon.devices.add(&phone_id, "Phone", Tier::Full, Threads::ALL, false).unwrap();
        let mut phone = Phone::dial(phone_key, &server).await;
        phone.call(json!({ "id": 0, "cmd": "hello", "args": { "protocol": 1 } })).await.unwrap();
        daemon.devices.revoke(&phone_id).unwrap();
        assert_eq!(phone.closed_with().await, Some(VarInt::from(close::REVOKED)));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_unknown_phone_is_closed_before_any_frame() {
        let data = crate::devices::tests::folder();
        let (_daemon, server) = daemon(&data.0).await;
        // Not `Phone::dial`: the close can beat its `open_bi`.
        let client = bind(SecretKey::generate(), None, 0).await.unwrap();
        let connection = client.connect(local_addr(&server), ALPN).await.unwrap();
        assert_eq!(super::pair_phone::closed_with(&connection).await, (close::NOT_PAIRED, "this device isn't paired with this machine".into()));
    }

    #[test]
    fn the_key_and_port_are_kept_in_the_data_folder() {
        let data = crate::devices::tests::folder();
        let first = key(&data.0).unwrap();
        assert_eq!(key(&data.0).unwrap().public(), first.public());
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(data.0.join(KEY_FILE)).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(port(&data.0, None), 0);
        std::fs::write(data.0.join(PORT_FILE), r#"{"port":41641}"#).unwrap();
        assert_eq!(port(&data.0, None), 41641);
        assert_eq!(port(&data.0, Some(7000)), 7000);
    }

    // ---- Pairing (`apex-deck/pair/1`) ----

    use super::pair_phone::{closed_with, pair_dial, PairPhone};
    use crate::devices::now_ms;
    use crate::pairing::invites::HostInfo;
    use crate::pairing::Invite;
    use std::net::SocketAddr;
    use std::sync::atomic::Ordering;

    fn socket(server: &Endpoint) -> SocketAddr {
        let port = server.bound_sockets().iter().map(|a| a.port()).find(|p| *p != 0).unwrap();
        SocketAddr::from(([127, 0, 0, 1], port))
    }

    /// An invitation naming `host` (normally the server's own ID).
    fn invite_for(daemon: &Daemon, host: iroh::EndpointId) -> Invite {
        let info = HostInfo { host: *host.as_bytes(), name: "Test Mac".into(), relay: crate::pairing::RELAY.into(), addrs: vec![] };
        daemon.invites.start(info, Tier::Chat, Threads::ALL, now_ms())
    }

    /// Approve the claim now, off the async workers (the registry write
    /// blocks).
    async fn approve(daemon: &Arc<Daemon>, invite: &Invite) -> Result<crate::devices::Device, PairError> {
        let claim = tokio::time::timeout(Duration::from_secs(10), daemon.invites.wait(&invite.inv)).await.expect("a claim in time")?;
        let daemon = Arc::clone(daemon);
        let inv = invite.inv;
        tokio::task::spawn_blocking(move || daemon.invites.approve(&inv, &claim.claim_id, &daemon.devices, now_ms())).await.unwrap()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_phone_pairs_then_is_served_with_the_same_key() {
        let data = crate::devices::tests::folder();
        let (daemon, server) = daemon(&data.0).await;
        let invite = invite_for(&daemon, server.id());
        let key = SecretKey::generate();
        let approver = {
            let (daemon, invite) = (Arc::clone(&daemon), invite.clone());
            tokio::spawn(async move { approve(&daemon, &invite).await })
        };
        let ok = pair_dial(key.clone(), socket(&server), &invite).await.unwrap();
        assert_eq!(ok, json!({ "host_id": "host-1", "host_name": "Test Mac", "tier": "chat", "threads": "all" }));
        let device = approver.await.unwrap().unwrap();
        assert_eq!(device.endpoint_id, key.public().to_string());
        assert_eq!(device.label, "Tyler's iPhone");

        let mut phone = Phone::dial(key, &server).await;
        let hello = phone.call(json!({ "id": 0, "cmd": "hello", "args": { "protocol": 1 } })).await.unwrap();
        assert_eq!(hello["ok"]["host_id"], "host-1");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn no_live_invitation_is_closed_before_any_frame() {
        let data = crate::devices::tests::folder();
        let (daemon, server) = daemon(&data.0).await;
        let invite = invite_for(&daemon, server.id());
        daemon.invites.cancel(&invite.inv).unwrap();
        let refused = PairPhone::connect(SecretKey::generate(), socket(&server), &invite).await.err().unwrap();
        assert_eq!(refused.0, close::PAIR_UNKNOWN, "{refused:?}");
        assert_eq!(daemon.invites.frames_read.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_wrong_secret_is_a_bad_proof() {
        let data = crate::devices::tests::folder();
        let (daemon, server) = daemon(&data.0).await;
        let mut invite = invite_for(&daemon, server.id());
        let real = invite.secret;
        invite.secret = [7; 32];
        assert_eq!(pair_dial(SecretKey::generate(), socket(&server), &invite).await.err().unwrap().0, close::PAIR_BAD_PROOF);
        assert_eq!(daemon.invites.secret(&invite.inv, now_ms()), Ok(real), "still open for the right phone");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_proof_replayed_on_another_connection_is_bad() {
        let data = crate::devices::tests::folder();
        let (daemon, server) = daemon(&data.0).await;
        let invite = invite_for(&daemon, server.id());
        let key = SecretKey::generate();
        let mut first = PairPhone::connect(key.clone(), socket(&server), &invite).await.unwrap();
        let captured = first.proof(&invite);
        let mut second = PairPhone::connect(key, socket(&server), &invite).await.unwrap();
        assert_eq!(second.claim_with(&invite, &captured).await.err().unwrap().0, close::PAIR_BAD_PROOF);
        // The captured proof was good on its own connection.
        assert_eq!(first.claim_with(&invite, &captured).await.unwrap(), json!({ "claimed": true }));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_proof_for_another_phone_id_is_bad() {
        let data = crate::devices::tests::folder();
        let (daemon, server) = daemon(&data.0).await;
        let invite = invite_for(&daemon, server.id());
        let other = *SecretKey::generate().public().as_bytes();
        let mut phone = PairPhone::connect(SecretKey::generate(), socket(&server), &invite).await.unwrap();
        let proof = phone.proof_as(&invite, &other);
        assert_eq!(phone.claim_with(&invite, &proof).await.err().unwrap().0, close::PAIR_BAD_PROOF);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn wrong_host_key_is_rejected() {
        let data = crate::devices::tests::folder();
        let (daemon_b, server_b) = daemon(&data.0).await;
        let key_a = SecretKey::generate();
        // The code names host A, but B listens at the address.
        let invite = invite_for(&daemon_b, key_a.public());
        let refused = pair_dial(SecretKey::generate(), socket(&server_b), &invite).await.err().unwrap();
        assert_eq!(refused.0, u32::MAX, "the dial fails: {refused:?}");
        assert_eq!(daemon_b.invites.frames_read.load(Ordering::SeqCst), 0, "no proof reached the daemon");
        assert!(daemon_b.invites.secret(&invite.inv, now_ms()).is_ok(), "nothing claimed");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn approve_after_phone_left_adds_nothing() {
        let data = crate::devices::tests::folder();
        let (daemon, server) = daemon(&data.0).await;
        let invite = invite_for(&daemon, server.id());
        let key = SecretKey::generate();
        let mut phone = PairPhone::connect(key.clone(), socket(&server), &invite).await.unwrap();
        let proof = phone.proof(&invite);
        phone.claim_with(&invite, &proof).await.unwrap();
        let claim = daemon.invites.wait(&invite.inv).await.unwrap();
        phone.connection.close(0u32.into(), b"gone");
        // The daemon hears of it without anyone asking.
        let left = tokio::time::timeout(Duration::from_secs(5), daemon.invites.settled(&invite.inv, &claim.claim_id)).await.unwrap();
        assert_eq!(left, Err(PairError::PhoneLeft));
        assert_eq!(daemon.invites.approve(&invite.inv, &claim.claim_id, &daemon.devices, now_ms()), Err(PairError::PhoneLeft));
        assert!(daemon.devices.get(&key.public().to_string()).is_none());
    }

    /// Nobody calls approve, wait or expire_due: the pairing connection's
    /// own wait expires the invitation and closes the phone.
    #[tokio::test(flavor = "multi_thread")]
    async fn expiry_while_claimed_closes_the_phone_at_once() {
        let data = crate::devices::tests::folder();
        let (daemon, server) = daemon(&data.0).await;
        let invite = invite_for(&daemon, server.id());
        let key = SecretKey::generate();
        let mut phone = PairPhone::connect(key.clone(), socket(&server), &invite).await.unwrap();
        let proof = phone.proof(&invite);
        phone.claim_with(&invite, &proof).await.unwrap();
        daemon.invites.expire_in(&invite.inv, Duration::from_millis(300));
        let started = std::time::Instant::now();
        let refused = phone.reply().await.err().unwrap();
        assert_eq!(refused.0, close::PAIR_EXPIRED, "{refused:?}");
        assert!(started.elapsed() < Duration::from_secs(2), "closed at expiry, took {:?}", started.elapsed());
        let claim_id = [0u8; 16];
        assert!(daemon.invites.approve(&invite.inv, &claim_id, &daemon.devices, now_ms()).is_err());
        assert!(daemon.devices.get(&key.public().to_string()).is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_phones_code_matches_the_claim() {
        let data = crate::devices::tests::folder();
        let (daemon, server) = daemon(&data.0).await;
        let invite = invite_for(&daemon, server.id());
        let key = SecretKey::generate();
        let mut phone = PairPhone::connect(key.clone(), socket(&server), &invite).await.unwrap();
        assert_eq!(phone.host_name, "Test Mac");
        let proof = phone.proof(&invite);
        phone.claim_with(&invite, &proof).await.unwrap();
        let claim = daemon.invites.wait(&invite.inv).await.unwrap();
        assert_eq!(claim.code, phone.code(&invite));
        assert_eq!(claim.phone_id, key.public().to_string());
        assert_eq!(claim.label, "Tyler's iPhone");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_session_command_on_the_pairing_stream_is_not_run() {
        let data = crate::devices::tests::folder();
        let (daemon, server) = daemon(&data.0).await;
        let invite = invite_for(&daemon, server.id());
        let mut phone = PairPhone::connect(SecretKey::generate(), socket(&server), &invite).await.unwrap();
        phone.send(json!({ "id": 0, "cmd": "hello", "args": { "protocol": 1 } })).await;
        let refused = phone.reply().await.err().unwrap();
        assert_eq!(refused.0, close::BYE, "{refused:?}");
        assert!(!refused.1.contains("host-1"));
        assert!(daemon.invites.secret(&invite.inv, now_ms()).is_ok(), "nothing claimed");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn deny_tells_the_phone_and_adds_nothing() {
        let data = crate::devices::tests::folder();
        let (daemon, server) = daemon(&data.0).await;
        let invite = invite_for(&daemon, server.id());
        let key = SecretKey::generate();
        let denier = {
            let (daemon, inv) = (Arc::clone(&daemon), invite.inv);
            tokio::spawn(async move {
                tokio::time::timeout(Duration::from_secs(10), daemon.invites.wait(&inv)).await.unwrap().unwrap();
                daemon.invites.deny(&inv).unwrap();
            })
        };
        let refused = pair_dial(key.clone(), socket(&server), &invite).await.err().unwrap();
        denier.await.unwrap();
        assert_eq!(refused.0, close::PAIR_DENIED, "{refused:?}");
        assert_eq!(refused.1, PairError::Cancelled.to_string(), "the err line came first");
        assert!(daemon.devices.get(&key.public().to_string()).is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_fifth_pairing_connection_is_closed() {
        let data = crate::devices::tests::folder();
        let (daemon, server) = daemon(&data.0).await;
        let invite = invite_for(&daemon, server.id());
        let mut open = Vec::new();
        for _ in 0..4 {
            open.push(PairPhone::connect(SecretKey::generate(), socket(&server), &invite).await.unwrap());
        }
        let fifth = PairPhone::connect(SecretKey::generate(), socket(&server), &invite).await.err().unwrap();
        assert_eq!(fifth, (close::BYE, "too many pairing connections".to_string()));
        // A place frees up when one goes.
        let gone = open.pop().unwrap();
        gone.connection.close(0u32.into(), b"gone");
        let _ = closed_with(&gone.connection).await;
        let mut again = None;
        for _ in 0..50 {
            if let Ok(phone) = PairPhone::connect(SecretKey::generate(), socket(&server), &invite).await {
                again = Some(phone);
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(again.is_some());
    }
}
