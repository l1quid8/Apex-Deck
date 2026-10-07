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

use iroh::endpoint::{presets, Connection, PortmapperConfig};
use iroh::{Endpoint, RelayMap, RelayMode, RelayUrl, SecretKey};
use serde_json::{json, Value};

use crate::files;
use crate::protocol::{self, Daemon, Ended, Trust, DEVICE_MAX_FRAME, HELLO_WAIT};

/// The ALPN a paired phone dials.
pub const ALPN: &[u8] = b"apex-deck/1";

/// The only relay remote access uses.
pub const RELAY: &str = "https://relay.apex-terminal.xyz/";

/// The endpoint's secret key, owner-only. On a Mac this moves to the
/// Keychain before release.
pub const KEY_FILE: &str = "iroh-key";

/// The UDP port chosen at first start, kept so a forwarded port stays right.
pub const PORT_FILE: &str = "remote.json";

/// Why a connection was closed, as its QUIC close code.
pub mod close {
    pub const BYE: u32 = 0;
    pub const NOT_PAIRED: u32 = 1;
    pub const REVOKED: u32 = 2;
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
    flag.or_else(|| {
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(data.join(PORT_FILE)).ok()?).ok()?;
        saved["port"].as_u64().and_then(|p| u16::try_from(p).ok())
    })
    .unwrap_or(0)
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
        .alpns(vec![ALPN.to_vec()])
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
    files::write_private(&data.join(PORT_FILE), &format!("{}\n", json!({ "port": bound })))?;
    let info = json!({ "endpoint_id": endpoint.id().to_string(), "port": bound, "relay": RELAY });
    Ok((endpoint, info))
}

/// Accept connections until the endpoint closes.
pub async fn accept(daemon: Arc<Daemon>, endpoint: Endpoint) {
    while let Some(incoming) = endpoint.accept().await {
        let daemon = Arc::clone(&daemon);
        tokio::spawn(async move {
            match tokio::time::timeout(HELLO_WAIT, incoming).await {
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
        let daemon = Arc::new(Daemon { host, host_id: "host-1".into(), boot_id: "boot-1".into(), token: None, devices: Arc::new(Devices::open(data)), invites: Default::default() });
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
        let stranger = Phone::dial(SecretKey::generate(), &server).await;
        assert_eq!(stranger.closed_with().await, Some(VarInt::from(close::NOT_PAIRED)));
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
}
