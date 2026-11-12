//! One iroh endpoint for phone connections, switched on and off while the
//! daemon keeps running. Every on, off, info and pair start takes the same
//! lock, so they run one at a time in the order they were asked.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use iroh::{Endpoint, Watcher};
use serde_json::{json, Value};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::remote_config;
use crate::remote_settings;
use crate::protocol::Daemon;

struct Running {
    endpoint: Endpoint,
    accept: JoinHandle<()>,
    port: u16,
    started_at: Instant,
}

const RELAY_CONNECT_GRACE_PERIOD: Duration = Duration::from_secs(20);

/// The phone endpoint. `relay` is `None` in tests, so they never use the public relay.
pub struct RemoteController {
    inner: tokio::sync::Mutex<Option<Running>>,
    relay: Option<&'static str>,
}

impl Default for RemoteController {
    fn default() -> Self {
        Self::new(None)
    }
}

impl RemoteController {
    pub fn new(relay: Option<&'static str>) -> Self {
        Self { inner: tokio::sync::Mutex::new(None), relay }
    }

    /// The endpoint a packaged or dev daemon serves with: the public relay.
    pub fn serving() -> Self {
        Self::new(Some(crate::remote::RELAY))
    }

    /// `remote_set`. An import is applied only when no settings file exists.
    /// The whole request runs under the lock, so requests settle in order.
    pub async fn set(&self, daemon: &Arc<Daemon>, enabled: bool, import: bool) -> Result<Value, String> {
        let mut guard = self.inner.lock().await;
        if import && remote_settings::present(&daemon.data) {
            return Ok(state_value(guard.as_ref(), &daemon.data, self.relay));
        }
        // An explicit choice is always saved, even when the endpoint already
        // matches: a saved "on" that failed to bind at boot, or `--remote`
        // over a saved "off", must not come back on the next start.
        if enabled {
            self.enable(&mut guard, daemon, true, None).await
        } else {
            disable(&mut guard, daemon).await
        }
    }

    /// Boot. `--remote` and a saved "on" both come here. Nothing is written:
    /// the flag must not change the file, and a saved "on" is already on disk.
    pub async fn boot(&self, daemon: &Arc<Daemon>, port: Option<u16>) -> Result<Value, String> {
        let mut guard = self.inner.lock().await;
        self.enable(&mut guard, daemon, false, port).await
    }

    /// A test, or a caller that already bound, stores that endpoint and accepts on it.
    pub async fn attach(&self, daemon: Arc<Daemon>, endpoint: Endpoint) {
        let port = bound_port(&endpoint);
        let accept = spawn_accept(Arc::clone(&daemon), endpoint.clone());
        *self.inner.lock().await = Some(Running { endpoint, accept, port, started_at: Instant::now() });
    }

    /// Run `body` while the endpoint is on, under the controller lock.
    /// `None` when phone connections are off.
    pub async fn with_running<T>(&self, body: impl FnOnce(&Endpoint) -> T) -> Option<T> {
        let guard = self.inner.lock().await;
        guard.as_ref().map(|running| body(&running.endpoint))
    }

    /// `remote_info`: the controller's state now, never a cached value.
    pub async fn snapshot(&self, data: &Path) -> Value {
        let guard = self.inner.lock().await;
        state_value(guard.as_ref(), data, self.relay)
    }

    async fn enable(&self, guard: &mut Option<Running>, daemon: &Arc<Daemon>, save: bool, port_flag: Option<u16>) -> Result<Value, String> {
        if let Some(running) = guard.as_ref() {
            if save {
                remote_settings::save(&daemon.data, true)?;
            }
            return Ok(state_value(Some(running), &daemon.data, self.relay));
        }
        let endpoint = self.bind(&daemon.data, port_flag).await?;
        let port = bound_port(&endpoint);
        if save {
            if let Err(error) = remote_settings::save(&daemon.data, true) {
                endpoint.close().await;
                drop(endpoint);
                return Err(error);
            }
        }
        // Advertised addresses are saved beside the port, so keep it once on.
        if let Err(error) = remote_config::save_port(&daemon.data, port) {
            eprintln!("apex-daemon: could not remember UDP port {port}: {error}");
        }
        let accept = spawn_accept(Arc::clone(daemon), endpoint.clone());
        let running = Running { endpoint, accept, port, started_at: Instant::now() };
        let value = state_value(Some(&running), &daemon.data, self.relay);
        *guard = Some(running);
        Ok(value)
    }

    async fn bind(&self, data: &Path, port_flag: Option<u16>) -> Result<Endpoint, String> {
        let port = crate::remote::port(data, port_flag);
        let first = crate::remote::bind(crate::remote::key(data)?, self.relay, port).await;
        match first {
            Ok(endpoint) => Ok(endpoint),
            Err(error) if port != 0 && address_in_use(&error) => {
                tokio::time::sleep(Duration::from_millis(50)).await;
                crate::remote::bind(crate::remote::key(data)?, self.relay, port)
                    .await
                    .map_err(|_| format!("UDP port {port} is in use"))
            }
            Err(error) => Err(error),
        }
    }
}

/// Off. The file is saved first, even when the endpoint is already off.
/// `Err` means the file is unchanged, so the endpoint and invitations stay.
async fn disable(guard: &mut Option<Running>, daemon: &Arc<Daemon>) -> Result<Value, String> {
    remote_settings::save(&daemon.data, false)?;
    if guard.is_none() {
        return Ok(state_value(None, &daemon.data, None));
    }
    let Some(Running { endpoint, accept, .. }) = guard.take() else { unreachable!() };
    daemon.invites.cancel_open();
    accept.abort();
    let _ = accept.await;
    endpoint.close().await;
    drop(endpoint);
    Ok(state_value(None, &daemon.data, None))
}

/// Binding a UDP socket does not prove the relay is reachable. Read iroh's
/// current status without waiting for WAN access: LAN pairing must keep working
/// while the relay is offline. Errors describe this machine's relay connection,
/// not whether a particular phone is online or authorized.
fn relay_status(running: &Running, relay: Option<&str>) -> Value {
    if relay.is_none() {
        return json!({ "state": "disabled", "error": null });
    }
    let statuses = running.endpoint.home_relay_status().get();
    if statuses.iter().any(|status| status.is_connected()) {
        return json!({ "state": "connected", "error": null });
    }
    if let Some(reason) = statuses.iter().find_map(|status| status.auth_denied_reason()) {
        return json!({ "state": "denied", "error": reason });
    }
    if let Some(error) = statuses.iter().find_map(|status| status.last_error()) {
        return json!({ "state": "unavailable", "error": format!("{error:#}") });
    }
    // A failed /ping or DNS lookup can prevent home relay selection entirely.
    // In that case iroh exposes neither a status entry nor a connection error.
    // Bound the startup grace period without guessing the network failure or
    // stopping retries; a later connected status above always takes priority.
    if running.started_at.elapsed() >= RELAY_CONNECT_GRACE_PERIOD {
        return json!({ "state": "unavailable", "error": "No relay connection is available yet. Retrying in the background." });
    }
    json!({ "state": "connecting", "error": null })
}

fn state_value(running: Option<&Running>, data: &Path, relay: Option<&str>) -> Value {
    let advertise = remote_config::advertised(data);
    match running {
        Some(running) => json!({
            "enabled": true,
            "endpoint_id": running.endpoint.id().to_string(),
            "port": running.port,
            "relay": crate::remote::RELAY,
            "relay_status": relay_status(running, relay),
            "advertise": advertise,
        }),
        None => json!({
            "enabled": false,
            "endpoint_id": null,
            "port": remote_config::port(data),
            "advertise": advertise,
        }),
    }
}

/// The accept loop serves phones, whose commands can reach `remote_set`, which
/// spawns this loop. A boxed future breaks that type cycle.
fn spawn_accept(daemon: Arc<Daemon>, endpoint: Endpoint) -> JoinHandle<()> {
    let accept: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> = Box::pin(crate::remote::accept(daemon, endpoint));
    tokio::spawn(accept)
}

fn bound_port(endpoint: &Endpoint) -> u16 {
    endpoint.bound_sockets().iter().map(|addr| addr.port()).find(|port| *port != 0).unwrap_or(0)
}

fn address_in_use(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    // iroh folds the OS error into "Failed to bind sockets".
    lower.contains("address already in use") || lower.contains("address in use") || lower.contains("eaddrinuse") || lower.contains("failed to bind sockets")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devices::{now_ms, Devices, Threads, Tier};
    use crate::pairing::invites::{HostInfo, PairError};
    use crate::remote::{self, ALPN};
    use apex_host::HostPaths;
    use iroh::SecretKey;
    use std::net::UdpSocket;

    fn daemon(data: &Path) -> Arc<Daemon> {
        let host = apex_host::test_support::isolated_host_assuming_verified_ui(HostPaths { data: data.to_path_buf(), downloads: None }, tokio::runtime::Handle::current());
        Arc::new(Daemon {
            voice: crate::voice::VoiceServer::new(data),
            host,
            host_id: "host-1".into(),
            boot_id: "boot-1".into(),
            token: None,
            devices: Arc::new(Devices::open(data)),
            gateway_keys: Arc::new(crate::gateway_keys::GatewayKeys::load(data).unwrap()),
            gateway: Default::default(),
            data: data.to_path_buf(), linux_device_policy: Some(false), confinement: Default::default(),
            invites: Default::default(),
            remote: RemoteController::default(),
        })
    }

    async fn switched(daemon: &Arc<Daemon>, enabled: bool, import: bool) -> Result<Value, String> {
        daemon.remote.set(daemon, enabled, import).await
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn bound_endpoint_reports_relay_failure_separately_from_enabled() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        // Allow relay selection (/ping), but refuse the actual WebSocket
        // upgrade. A completely unreachable URL may never be selected as a
        // home relay, so iroh has no relay connection error to publish for it.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let relay = Box::leak(format!("http://{}/", listener.local_addr().unwrap()).into_boxed_str());
        let server = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    let mut chunk = [0u8; 1024];
                    while request.len() < 4096 && !request.windows(4).any(|w| w == b"\r\n\r\n") {
                        match socket.read(&mut chunk).await {
                            Ok(0) | Err(_) => return,
                            Ok(len) => request.extend_from_slice(&chunk[..len]),
                        }
                    }
                    let status = if request.starts_with(b"GET /ping ") { "200 OK" } else { "503 Service Unavailable" };
                    let _ = socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await;
                });
            }
        });
        let data = crate::devices::tests::folder();
        let mut daemon = daemon(&data.0);
        // A locally bound endpoint remains useful for LAN pairing when its
        // relay cannot be reached. It must not claim relay connectivity.
        Arc::get_mut(&mut daemon).unwrap().remote = RemoteController::new(Some(relay));
        let initial = switched(&daemon, true, false).await.unwrap();
        assert_eq!(initial["enabled"], true);
        assert!(matches!(initial["relay_status"]["state"].as_str(), Some("connecting" | "unavailable")));
        let failed = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let state = daemon.remote.snapshot(&data.0).await;
                if state["relay_status"]["state"] == "unavailable" {
                    break state;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }).await.expect("the failed local relay dial must become visible");
        assert_eq!(failed["enabled"], true, "direct pairing remains enabled");
        assert!(!failed["relay_status"]["error"].as_str().unwrap().is_empty());
        let off = switched(&daemon, false, false).await.unwrap();
        assert!(off["relay_status"].is_null());
        server.abort();
        let _ = server.await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn relay_disabled_endpoint_does_not_claim_remote_reachability() {
        let data = crate::devices::tests::folder();
        let daemon = daemon(&data.0);
        let on = switched(&daemon, true, false).await.unwrap();
        assert_eq!(on["relay_status"], json!({ "state": "disabled", "error": null }));
        switched(&daemon, false, false).await.unwrap();
    }

    #[tokio::test]
    async fn relay_selection_timeout_is_visible_and_turning_on_resets_the_grace_period() {
        // The TCP listener deliberately never responds to /ping. No home
        // relay is selected, so iroh cannot publish a connection error.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let relay = Box::leak(format!("http://{}/", listener.local_addr().unwrap()).into_boxed_str());
        let data = crate::devices::tests::folder();
        let mut daemon = daemon(&data.0);
        Arc::get_mut(&mut daemon).unwrap().remote = RemoteController::new(Some(relay));
        let initial = switched(&daemon, true, false).await.unwrap();
        assert_eq!(initial["relay_status"]["state"], "connecting");

        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(19)).await;
        assert_eq!(daemon.remote.snapshot(&data.0).await["relay_status"]["state"], "connecting");
        tokio::time::advance(Duration::from_secs(1)).await;
        let failed = daemon.remote.snapshot(&data.0).await;
        assert_eq!(failed["enabled"], true, "LAN pairing remains available");
        assert_eq!(failed["relay_status"]["state"], "unavailable", "relay selection cannot stay connecting forever");
        assert!(!failed["relay_status"]["error"].as_str().unwrap().is_empty());
        assert_eq!(switched(&daemon, true, false).await.unwrap()["relay_status"]["state"], "unavailable", "enabling an already-running endpoint cannot restart the grace period");
        tokio::time::resume();

        switched(&daemon, false, false).await.unwrap();
        let restarted = switched(&daemon, true, false).await.unwrap();
        assert_eq!(restarted["relay_status"]["state"], "connecting", "a new endpoint gets a new grace period");
        switched(&daemon, false, false).await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn on_while_on_keeps_the_endpoint_and_a_connected_phone() {
        let data = crate::devices::tests::folder();
        let daemon = daemon(&data.0);
        let first = switched(&daemon, true, false).await.unwrap();
        let phone_key = SecretKey::generate();
        daemon.devices.add(&phone_key.public().to_string(), "Phone", Tier::Chat, Threads::ALL, false).unwrap();
        let server = daemon.remote.with_running(|endpoint| endpoint.clone()).await.unwrap();
        let client = remote::bind(phone_key.clone(), None, 0).await.unwrap();
        let port = server.bound_sockets().iter().map(|addr| addr.port()).find(|port| *port != 0).unwrap();
        let addr: iroh::EndpointAddr = serde_json::from_value(json!({ "id": server.id().to_string(), "addrs": [{ "Ip": format!("127.0.0.1:{port}") }] })).unwrap();
        let connection = client.connect(addr, ALPN).await.unwrap();
        let (send, recv) = connection.open_bi().await.unwrap();
        let (mut input, mut output) = crate::protocol::lines(recv, send);
        use futures::{SinkExt, StreamExt};
        output.send(json!({ "id": 0, "cmd": "hello", "args": { "protocol": 1 } }).to_string()).await.unwrap();
        let hello = tokio::time::timeout(Duration::from_secs(10), input.next()).await.unwrap().unwrap().unwrap();
        assert!(hello.contains("host-1"), "{hello}");

        let second = switched(&daemon, true, false).await.unwrap();
        assert_eq!(second["endpoint_id"], first["endpoint_id"]);
        assert_eq!(second["port"], first["port"]);
        output.send(json!({ "id": 2, "cmd": "room_state", "args": { "id": "nope" } }).to_string()).await.unwrap();
        let state = tokio::time::timeout(Duration::from_secs(10), input.next()).await.unwrap().unwrap().unwrap();
        assert!(state.contains("\"id\":2"), "the phone stayed connected: {state}");
        connection.close(0u32.into(), b"bye");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn off_then_on_rebinds_the_same_port_and_cancels_an_open_invitation() {
        let data = crate::devices::tests::folder();
        let daemon = daemon(&data.0);
        let first = switched(&daemon, true, false).await.unwrap();
        let port = first["port"].as_u64().unwrap();
        let invite = daemon.invites.start(HostInfo { host: [7; 32], name: "Mac".into(), relay: remote::RELAY.into(), addrs: vec![] }, Tier::Chat, Threads::ALL, now_ms());
        let waiting = tokio::spawn({
            let invites = Arc::clone(&daemon.invites);
            let id = invite.inv;
            async move { invites.wait(&id).await }
        });
        let off = switched(&daemon, false, false).await.unwrap();
        assert_eq!(off["enabled"], false);
        assert_eq!(waiting.await.unwrap(), Err(PairError::Cancelled));
        assert_eq!(remote_settings::enabled(&data.0), Some(false));
        let on = switched(&daemon, true, false).await.unwrap();
        assert_eq!(on["enabled"], true);
        assert_eq!(on["port"].as_u64().unwrap(), port, "the same UDP port is bound again");
        assert_eq!(on["endpoint_id"], first["endpoint_id"], "the saved key keeps the same ID, so paired phones still find it");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_bind_failure_and_a_save_failure_leave_the_state_and_the_file() {
        let data = crate::devices::tests::folder();
        let daemon = daemon(&data.0);
        let socket = UdpSocket::bind("0.0.0.0:0").unwrap();
        let port = socket.local_addr().unwrap().port();
        // Linux's dual-stack socket already holds the IPv4 bind, so there the
        // IPv6 bind fails and the IPv4 one is enough to block the port.
        let v6 = UdpSocket::bind(format!("[::]:{port}")).ok();
        remote_config::save_port(&data.0, port).unwrap();
        let error = switched(&daemon, true, false).await.unwrap_err();
        assert!(error.contains(&format!("UDP port {port} is in use")), "{error}");
        assert_eq!(remote_settings::enabled(&data.0), None, "the file was not written");
        assert_eq!(daemon.remote.snapshot(&data.0).await["enabled"], false);
        drop((socket, v6));

        remote_settings::fail_next_save(&data.0);
        let error = switched(&daemon, true, false).await.unwrap_err();
        assert!(error.contains("injected"), "{error}");
        assert_eq!(remote_settings::enabled(&data.0), None);
        assert_eq!(daemon.remote.snapshot(&data.0).await["enabled"], false);

        switched(&daemon, true, false).await.unwrap();
        let invite = daemon.invites.start(HostInfo { host: [7; 32], name: "Mac".into(), relay: remote::RELAY.into(), addrs: vec![] }, Tier::Chat, Threads::ALL, now_ms());
        remote_settings::fail_next_save(&data.0);
        let error = switched(&daemon, false, false).await.unwrap_err();
        assert!(error.contains("injected"), "{error}");
        assert_eq!(remote_settings::enabled(&data.0), Some(true), "a failed off save leaves the file");
        assert_eq!(daemon.remote.snapshot(&data.0).await["enabled"], true);
        assert!(daemon.invites.secret(&invite.inv, now_ms()).is_ok(), "the open invitation is untouched");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn off_is_saved_when_a_saved_on_never_bound() {
        let data = crate::devices::tests::folder();
        let daemon = daemon(&data.0);
        // A saved "on" whose bind failed at boot: the file says on, the endpoint is off.
        remote_settings::save(&data.0, true).unwrap();
        assert_eq!(daemon.remote.snapshot(&data.0).await["enabled"], false);
        let off = switched(&daemon, false, false).await.unwrap();
        assert_eq!(off["enabled"], false);
        assert_eq!(remote_settings::enabled(&data.0), Some(false), "the next start stays off");

        remote_settings::fail_next_save(&data.0);
        assert!(switched(&daemon, false, false).await.unwrap_err().contains("injected"));
        assert_eq!(remote_settings::enabled(&data.0), Some(false));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn on_is_saved_over_remote_flag_without_replacing_the_endpoint() {
        let data = crate::devices::tests::folder();
        let daemon = daemon(&data.0);
        // `--remote` over a saved "off": running, file still off.
        remote_settings::save(&data.0, false).unwrap();
        let booted = daemon.remote.boot(&daemon, None).await.unwrap();
        assert_eq!(remote_settings::enabled(&data.0), Some(false), "boot writes nothing");
        let endpoint = daemon.remote.with_running(|endpoint| endpoint.clone()).await.unwrap();

        let on = switched(&daemon, true, false).await.unwrap();
        assert_eq!(remote_settings::enabled(&data.0), Some(true), "the explicit on is saved");
        assert_eq!(on["endpoint_id"], booted["endpoint_id"]);
        assert!(!endpoint.is_closed(), "the running endpoint was kept, not replaced");
        let still = daemon.remote.with_running(|current| current.clone()).await.unwrap();
        assert_eq!(bound_port(&still), bound_port(&endpoint));

        remote_settings::fail_next_save(&data.0);
        assert!(switched(&daemon, true, false).await.unwrap_err().contains("injected"));
        assert!(!endpoint.is_closed(), "a failed save while on leaves the endpoint");
        assert_eq!(daemon.remote.snapshot(&data.0).await["enabled"], true);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn concurrent_on_off_on_settles_in_request_order() {
        let data = crate::devices::tests::folder();
        let daemon = daemon(&data.0);
        let on = switched(&daemon, true, false);
        let off = switched(&daemon, false, false);
        let again = switched(&daemon, true, false);
        let (first, second, third) = tokio::join!(on, off, again);
        first.unwrap();
        second.unwrap();
        let last = third.unwrap();
        assert_eq!(last["enabled"], true);
        assert_eq!(daemon.remote.snapshot(&data.0).await["enabled"], true);
        assert_eq!(remote_settings::enabled(&data.0), Some(true));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_import_cannot_overwrite_a_saved_setting() {
        let data = crate::devices::tests::folder();
        let daemon = daemon(&data.0);
        let on = switched(&daemon, true, true).await.unwrap();
        assert_eq!(on["enabled"], true);
        assert_eq!(remote_settings::enabled(&data.0), Some(true));
        let ignored = switched(&daemon, false, true).await.unwrap();
        assert_eq!(ignored["enabled"], true, "import is ignored once the file exists");
        assert_eq!(remote_settings::enabled(&data.0), Some(true));
        assert_eq!(daemon.remote.snapshot(&data.0).await["endpoint_id"], on["endpoint_id"]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_later_off_survives_a_resent_import() {
        let data = crate::devices::tests::folder();
        let daemon = daemon(&data.0);
        switched(&daemon, true, true).await.unwrap();
        let off = switched(&daemon, false, false).await.unwrap();
        assert_eq!(off["enabled"], false);
        let again = switched(&daemon, true, true).await.unwrap();
        assert_eq!(again["enabled"], false, "the re-sent import does not turn it back on");
        assert_eq!(remote_settings::enabled(&data.0), Some(false));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn importing_off_writes_the_file_without_binding() {
        let data = crate::devices::tests::folder();
        let daemon = daemon(&data.0);
        let off = switched(&daemon, false, true).await.unwrap();
        assert_eq!(off["enabled"], false);
        assert_eq!(remote_settings::enabled(&data.0), Some(false));
        let ignored = switched(&daemon, true, true).await.unwrap();
        assert_eq!(ignored["enabled"], false);
    }
}
