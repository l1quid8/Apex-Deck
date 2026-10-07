//! Milestone 1 only: bounded echo probes, no daemon commands or authorization.
//! C calls are synchronous and must run off the UI thread. Returned strings are
//! owned by Rust and must be freed with apex_iroh_string_free.
use anyhow::{bail, Context, Result};
use iroh::{
    endpoint::{presets, Connection, PortmapperConfig},
    Endpoint, EndpointAddr, RelayMap, RelayMode, SecretKey,
};
use serde_json::{json, Value};
use std::{
    ffi::{c_char, CStr, CString},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

const RELAY: &str = "https://relay.apex-terminal.xyz";
const ALPN: &[u8] = b"apex-deck/spike/0";
struct Session {
    endpoint: Endpoint,
    connection: Option<Connection>,
    direct: bool,
}
static SESSION: Mutex<Option<Session>> = Mutex::new(None);
static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
fn runtime() -> &'static tokio::runtime::Runtime {
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("runtime")
    })
}
fn key(s: &str) -> Result<SecretKey> {
    if s.len() != 64 || !s.is_ascii() {
        bail!("invalid key length");
    }
    let mut bytes = [0; 32];
    for (i, b) in bytes.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).context("invalid key")?;
    }
    Ok(SecretKey::from_bytes(&bytes))
}
fn target(v: &Value, direct: bool) -> Result<EndpointAddr> {
    let mut addr: EndpointAddr =
        serde_json::from_value(v.clone()).context("invalid endpoint address")?;
    // Strip relay hints even if the supplied address carries them. Never let
    // Direct only resurrect a relay through remote addressing information.
    if direct {
        addr.addrs.retain(|a| a.is_ip());
    } else if addr
        .addrs
        .iter()
        .filter(|a| a.is_relay())
        .any(|a| a.to_string() != format!("relay:{RELAY}/"))
    {
        bail!("untrusted relay address");
    }
    if addr.addrs.is_empty() {
        bail!("no usable address; Direct only requires an explicit IP and UDP port");
    }
    Ok(addr)
}
fn route(c: &Connection) -> &'static str {
    match c.paths().iter().find(|p| p.is_selected()) {
        Some(p) if p.is_relay() => "Relayed",
        Some(_) => "Direct",
        None => "Connecting",
    }
}
async fn command(v: Value, state: &mut Option<Session>) -> Result<Value> {
    match v["op"].as_str().unwrap_or("") {
        "generateKey" => {
            let k = SecretKey::generate();
            Ok(
                json!({"key": k.to_bytes().iter().map(|b| format!("{b:02x}")).collect::<String>(), "id": k.public().to_string()}),
            )
        }
        "start" => {
            let k = key(v["key"].as_str().context("key required")?)?;
            let direct = match v["mode"].as_str() {
                Some("direct") => true,
                Some("automatic") => false,
                _ => bail!("invalid mode"),
            };
            if let Some(old) = state.take() {
                old.endpoint.close().await;
            }
            let mode = if direct {
                RelayMode::Disabled
            } else {
                RelayMode::Custom(RelayMap::from(RELAY.parse::<iroh::RelayUrl>()?))
            };
            let endpoint = Endpoint::builder(presets::Minimal)
                .secret_key(k)
                .relay_mode(mode)
                .portmapper_config(PortmapperConfig::Disabled)
                .bind()
                .await?;
            let out = json!({"id": endpoint.id().to_string(), "address": endpoint.addr(), "mode": if direct {"direct"} else {"automatic"}});
            *state = Some(Session {
                endpoint,
                connection: None,
                direct,
            });
            Ok(out)
        }
        "connect" => {
            let session = state.as_mut().context("start first")?;
            let direct = session.direct;
            let addr = target(&v["address"], direct)?;
            if let Some(old) = session.connection.take() {
                old.close(0u32.into(), b"reconnect");
            }
            let conn = tokio::time::timeout(
                Duration::from_secs(20),
                session.endpoint.connect(addr, ALPN),
            )
            .await
            .context("connection timed out")??;
            let out = json!({"remoteId": conn.remote_id().to_string(), "route": route(&conn)});
            session.connection = Some(conn);
            Ok(out)
        }
        "ping" => {
            let conn = state
                .as_ref()
                .and_then(|s| s.connection.as_ref())
                .context("not connected")?;
            let now = Instant::now();
            tokio::time::timeout(Duration::from_secs(5), async {
                let (mut send, mut recv) = conn.open_bi().await?;
                send.write_all(b"apex-spike-ping").await?;
                send.finish()?;
                if recv.read_to_end(64).await? != b"apex-spike-ping" {
                    bail!("unexpected echo");
                }
                Ok::<_, anyhow::Error>(())
            })
            .await
            .context("ping timed out")??;
            Ok(json!({"route": route(conn), "rttMs": now.elapsed().as_secs_f64()*1000.0}))
        }
        "stop" => {
            if let Some(old) = state.take() {
                old.endpoint.close().await;
            }
            Ok(json!({"stopped": true}))
        }
        _ => bail!("unknown spike operation"),
    }
}
/// Input is valid NUL-terminated UTF-8 JSON for this call's lifetime.
#[no_mangle]
pub unsafe extern "C" fn apex_iroh_call(input: *const c_char) -> *mut c_char {
    let result = std::panic::catch_unwind(|| -> Result<Value> {
        if input.is_null() {
            bail!("missing input");
        }
        let v = serde_json::from_str(CStr::from_ptr(input).to_str()?)?;
        let mut state = SESSION
            .lock()
            .map_err(|_| anyhow::anyhow!("spike state unavailable"))?;
        runtime().block_on(command(v, &mut state))
    });
    let out = match result {
        Ok(Ok(v)) => json!({"ok": v}),
        Ok(Err(e)) => json!({"error": format!("{e:#}")}),
        Err(_) => json!({"error": "native spike failed"}),
    };
    CString::new(out.to_string())
        .expect("JSON contains no NUL")
        .into_raw()
}
/// Frees exactly once a pointer returned by apex_iroh_call, or accepts NULL.
#[no_mangle]
pub unsafe extern "C" fn apex_iroh_string_free(s: *mut c_char) {
    if !s.is_null() {
        drop(CString::from_raw(s));
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn direct_probe_authenticates_host_and_echoes() {
        let host = Endpoint::builder(presets::Minimal)
            .relay_mode(RelayMode::Disabled)
            .portmapper_config(PortmapperConfig::Disabled)
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await
            .unwrap();
        let socket = host.bound_sockets()[0];
        let socket = std::net::SocketAddr::new(
            if socket.is_ipv4() {
                "127.0.0.1".parse().unwrap()
            } else {
                "::1".parse().unwrap()
            },
            socket.port(),
        );
        let address = EndpointAddr::new(host.id()).with_ip_addr(socket);
        let server = host.clone();
        let echo = tokio::spawn(async move {
            let conn = server.accept().await.unwrap().await.unwrap();
            let (mut tx, mut rx) = conn.accept_bi().await.unwrap();
            let bytes = rx.read_to_end(64).await.unwrap();
            tx.write_all(&bytes).await.unwrap();
            tx.finish().unwrap();
            conn.closed().await;
        });
        let mut state = None;
        let secret = SecretKey::generate()
            .to_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let start = command(
            json!({"op":"start", "key":secret, "mode":"direct"}),
            &mut state,
        )
        .await
        .unwrap();
        let connected = command(json!({"op":"connect", "address":address}), &mut state)
            .await
            .unwrap();
        assert_eq!(connected["remoteId"], host.id().to_string());
        let ping = command(json!({"op":"ping"}), &mut state).await.unwrap();
        assert_eq!(ping["route"], "Direct");
        command(json!({"op":"stop"}), &mut state).await.unwrap();
        let restart = command(
            json!({"op":"start", "key":secret, "mode":"automatic"}),
            &mut state,
        )
        .await
        .unwrap();
        assert_eq!(start["id"], restart["id"]);
        command(json!({"op":"stop"}), &mut state).await.unwrap();
        echo.await.unwrap();
        host.close().await;
    }
    #[test]
    fn malformed_keys_are_rejected() {
        assert!(key(&"é".repeat(32)).is_err());
        assert!(key(&"z".repeat(64)).is_err());
    }
    #[test]
    fn direct_strips_relay_hints() {
        let k = SecretKey::generate();
        let a = EndpointAddr::new(k.public())
            .with_relay_url(RELAY.parse().unwrap())
            .with_ip_addr("127.0.0.1:1234".parse().unwrap());
        let a = target(&serde_json::to_value(a).unwrap(), true).unwrap();
        assert!(a.addrs.iter().all(|a| a.is_ip()));
    }
    #[test]
    fn automatic_rejects_other_relays() {
        let a = EndpointAddr::new(SecretKey::generate().public())
            .with_relay_url("https://untrusted.example".parse().unwrap());
        assert!(target(&serde_json::to_value(a).unwrap(), false).is_err());
        let a = EndpointAddr::new(SecretKey::generate().public())
            .with_relay_url(RELAY.parse().unwrap());
        assert!(target(&serde_json::to_value(a).unwrap(), false).is_ok());
    }
    #[test]
    fn direct_requires_ip() {
        let a = EndpointAddr::new(SecretKey::generate().public())
            .with_relay_url(RELAY.parse().unwrap());
        assert!(target(&serde_json::to_value(a).unwrap(), true).is_err());
    }
}
