//! Owner-only gateway listener controls. Dispatch is restricted to Trust::Local.
use crate::{files, gateway_http, protocol::Daemon};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    net::{IpAddr, SocketAddr},
    sync::Arc,
};
use tokio::{net::TcpListener, task::JoinHandle};

const FILE: &str = "gateway-settings.json";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub enabled: bool,
    pub bind: IpAddr,
    pub port: u16,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: false,
            bind: "127.0.0.1".parse().unwrap(),
            port: 8787,
        }
    }
}
#[derive(Default)]
pub struct Runtime {
    config: Config,
    address: Option<SocketAddr>,
    task: Option<JoinHandle<()>>,
    error: Option<String>,
}
impl Drop for Runtime {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}
#[derive(Deserialize)]
#[serde(tag = "cmd", content = "args", rename_all = "snake_case")]
pub enum Request {
    GatewayStatus {},
    GatewayProviders {},
    GatewayConfigure(Config),
}

fn snapshot(runtime: &Runtime) -> Value {
    let enabled = runtime.task.as_ref().is_some_and(|t| !t.is_finished());
    json!({ "enabled": enabled, "bind": runtime.config.bind,
        "port": runtime.address.map(|a| a.port()).unwrap_or(runtime.config.port), "error": runtime.error,
        "baseUrl": runtime.address.filter(|_| enabled).map(|a| format!("http://{a}/v1")) })
}

pub async fn run(daemon: &Arc<Daemon>, request: Request) -> Result<Value, String> {
    match request {
        Request::GatewayStatus {} => Ok(snapshot(&*daemon.gateway.lock().await)),
        Request::GatewayConfigure(config) => configure(daemon, config, true).await,
        Request::GatewayProviders {} => {
            let data = daemon.data.clone();
            tokio::task::spawn_blocking(move || gateway_http::provider_readiness(&data))
                .await
                .map_err(|e| e.to_string())
        }
    }
}

pub async fn start(daemon: &Arc<Daemon>, port: Option<u16>, bind: IpAddr) -> Result<Value, String> {
    let config = if let Some(port) = port {
        Config {
            enabled: true,
            bind,
            port,
        }
    } else {
        let restored = match std::fs::read_to_string(daemon.data.join(FILE)) {
            Ok(raw) => {
                serde_json::from_str(&raw).map_err(|e| format!("Invalid gateway settings: {e}"))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
            Err(e) => Err(format!("Could not read gateway settings: {e}")),
        };
        match restored {
            Ok(config) => config,
            Err(error) => {
                eprintln!("apex-daemon: {error}");
                let mut runtime = daemon.gateway.lock().await;
                runtime.error = Some(error);
                return Ok(snapshot(&runtime));
            }
        }
    };
    match configure(daemon, config.clone(), false).await {
        Ok(value) => Ok(value),
        Err(error) if port.is_none() => {
            // A moved LAN address or port conflict must not disable the local
            // owner socket used to repair these saved settings.
            eprintln!("apex-daemon: saved model gateway could not start: {error}");
            let mut runtime = daemon.gateway.lock().await;
            runtime.config = config;
            runtime.error = Some(error);
            Ok(snapshot(&runtime))
        }
        Err(error) => Err(error),
    }
}

async fn configure(daemon: &Arc<Daemon>, config: Config, persist: bool) -> Result<Value, String> {
    if persist && config.port == 0 {
        return Err("Gateway port must be between 1 and 65535.".into());
    }
    let mut runtime = daemon.gateway.lock().await;
    if runtime.task.as_ref().is_some_and(|t| !t.is_finished())
        && config.enabled
        && (runtime.config.bind != config.bind || runtime.config.port != config.port)
    {
        return Err("Disable gateway before changing its listen address or port.".into());
    }
    let reuse = config.enabled
        && runtime.config.bind == config.bind
        && runtime.config.port == config.port
        && runtime.task.as_ref().is_some_and(|t| !t.is_finished());
    // Bind and persist before replacing the old listener: either failure leaves it running.
    let listener = if config.enabled && !reuse {
        Some(
            TcpListener::bind((config.bind, config.port))
                .await
                .map_err(|e| format!("Could not start model gateway: {e}"))?,
        )
    } else {
        None
    };
    let address = listener
        .as_ref()
        .map(|l| l.local_addr())
        .transpose()
        .map_err(|e| e.to_string())?;
    if persist {
        files::write_private(
            &daemon.data.join(FILE),
            &serde_json::to_string(&config).map_err(|e| e.to_string())?,
        )?;
    }
    if !reuse {
        if let Some(task) = runtime.task.take() {
            task.abort();
            let _ = task.await;
            tokio::task::yield_now().await;
        }
        runtime.address = address;
        if let Some(listener) = listener {
            runtime.task = Some(tokio::spawn(gateway_http::serve(
                listener,
                gateway_http::GatewayHttpState::new(
                    daemon.data.clone(),
                    Arc::clone(&daemon.gateway_keys),
                ),
            )));
        }
    }
    runtime.config = config;
    runtime.error = None;
    Ok(snapshot(&runtime))
}

pub async fn stop(daemon: &Daemon) {
    let mut runtime = daemon.gateway.lock().await;
    if let Some(task) = runtime.task.take() {
        task.abort();
        let _ = task.await;
        tokio::task::yield_now().await;
    }
    runtime.address = None;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn listener_controls_persist_and_failed_rebind_keeps_the_old_listener() {
        let dir = std::env::temp_dir().join(format!("apex-gateway-admin-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let paths = crate::paths::host_paths(Some(dir.clone())).unwrap();
        let daemon = Daemon::start(&paths, None).unwrap();
        let reserved = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = reserved.local_addr().unwrap().port();
        drop(reserved);
        let config = Config {
            enabled: true,
            bind: "127.0.0.1".parse().unwrap(),
            port,
        };
        let status = configure(&daemon, config.clone(), true).await.unwrap();
        assert_eq!(status["enabled"], true);
        assert!(tokio::net::TcpStream::connect((config.bind, port))
            .await
            .is_ok());
        let blocked = TcpListener::bind("127.0.0.1:0").await.unwrap();
        assert!(configure(
            &daemon,
            Config {
                port: blocked.local_addr().unwrap().port(),
                ..config.clone()
            },
            true
        )
        .await
        .is_err());
        assert_eq!(
            run(&daemon, Request::GatewayStatus {}).await.unwrap()["port"],
            port
        );
        assert_eq!(
            serde_json::from_str::<Config>(&std::fs::read_to_string(dir.join(FILE)).unwrap())
                .unwrap()
                .port,
            port
        );
        stop(&daemon).await;
        // Concurrent test threads spawning subprocesses via `fork` + `pre_exec`
        // can briefly hold an inherited `FD_CLOEXEC` socket until `execve`.
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
        let conflict = loop {
            match TcpListener::bind((config.bind, port)).await {
                Ok(listener) => break listener,
                Err(e)
                    if e.kind() == std::io::ErrorKind::AddrInUse
                        && std::time::Instant::now() < deadline =>
                {
                    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
                }
                Err(e) => panic!("failed to rebind {port} after stop: {e}"),
            }
        };
        let failed = start(&daemon, None, config.bind)
            .await
            .expect("saved gateway bind failure must not prevent daemon recovery");
        assert_eq!(failed["enabled"], false);
        assert!(failed["error"]
            .as_str()
            .unwrap()
            .contains("Could not start"));
        assert!(failed["baseUrl"].is_null());
        drop(conflict);
        // The conflicting listener can also be inherited by another test's
        // fork before exec. Wait for that handle to close, as after stop above.
        let restart_deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
        let restarted = loop {
            let status = start(&daemon, None, config.bind).await.unwrap();
            if status["enabled"] == true
                || !status["error"]
                    .as_str()
                    .is_some_and(|error| error.starts_with("Could not start model gateway:"))
                || std::time::Instant::now() >= restart_deadline
            {
                break status;
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        };
        assert_eq!(
            restarted["enabled"], true,
            "gateway restart failed: {restarted}"
        );
        assert!(tokio::net::TcpStream::connect((config.bind, port))
            .await
            .is_ok());
        configure(
            &daemon,
            Config {
                enabled: false,
                ..config.clone()
            },
            true,
        )
        .await
        .unwrap();
        // A concurrent fork can briefly retain the listener. Windows can also
        // delay reporting refusal after the listener has already closed.
        let refusal_deadline = if cfg!(windows) {
            std::time::Duration::from_secs(5)
        } else {
            std::time::Duration::from_millis(500)
        };
        let mut accepted = 0;
        let mut reset = 0;
        let refusal = tokio::time::timeout(refusal_deadline, async {
            loop {
                match tokio::net::TcpStream::connect((config.bind, port)).await {
                    Ok(_) => {
                        accepted += 1;
                        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {
                        // Closing the old listener can reset a queued connection.
                        // Keep waiting until the port actually refuses connections.
                        reset += 1;
                        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
                    }
                    Err(error) => break error,
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!(
            "TCP connection did not report refusal after gateway disable within {refusal_deadline:?}; {accepted} successful connections completed; {reset} connections reset"
        ));
        assert_eq!(refusal.kind(), std::io::ErrorKind::ConnectionRefused);
        assert_eq!(
            start(&daemon, None, config.bind).await.unwrap()["enabled"],
            false
        );
        std::fs::write(dir.join(FILE), "{").unwrap();
        let corrupt = start(&daemon, None, config.bind)
            .await
            .expect("corrupt saved gateway settings must not block owner recovery");
        assert_eq!(corrupt["enabled"], false);
        assert!(corrupt["error"]
            .as_str()
            .unwrap()
            .contains("Invalid gateway settings"));
        drop(daemon);
        let _ = std::fs::remove_dir_all(dir);
    }
}
