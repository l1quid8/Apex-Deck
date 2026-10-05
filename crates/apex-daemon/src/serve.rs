//! `apex-daemon serve`: run the host and listen for clients.

use std::path::PathBuf;
use std::sync::Arc;

use apex_host::{Host, HostPaths};
use serde_json::json;
use tokio::net::TcpListener;

use crate::cli::ServeOptions;
use crate::protocol::{Daemon, PROTOCOL};
use crate::{files, identity, paths, websocket};

pub fn run(data_dir: Option<PathBuf>, options: ServeOptions) -> Result<(), String> {
    if !options.bind.is_loopback() && !options.insecure_bind {
        return Err(format!(
            "--bind {} would let other machines reach the daemon, which waits for device pairing; pass --insecure-bind to do it anyway (the token still applies)",
            options.bind
        ));
    }
    let paths = paths::host_paths(data_dir)?;
    std::fs::create_dir_all(&paths.data).map_err(|e| format!("could not create {}: {e}", paths.data.display()))?;
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().map_err(|e| e.to_string())?;
    runtime.block_on(serve(paths, options))
}

async fn serve(paths: HostPaths, options: ServeOptions) -> Result<(), String> {
    let host = Host::new(paths.clone(), tokio::runtime::Handle::current());
    let token = identity::random_hex(32);
    files::write_private(&paths.data.join("daemon-token"), &format!("{token}\n"))?;
    let daemon = Arc::new(Daemon { host, host_id: identity::host_id(&paths.data)?, boot_id: identity::boot_id(), token: Some(token) });

    let listener = TcpListener::bind((options.bind, options.port)).await.map_err(|e| format!("could not listen on {}:{}: {e}", options.bind, options.port))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    // Written last: once it exists, the daemon is ready.
    let info = json!({
        "pid": std::process::id(), "port": port, "bind": options.bind.to_string(), "protocol": PROTOCOL,
        "host_id": daemon.host_id, "boot_id": daemon.boot_id,
    });
    files::write_private(&paths.data.join("daemon.json"), &info.to_string())?;
    eprintln!("apex-daemon: listening on ws://{}:{port}", options.bind);

    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                tokio::spawn(websocket::serve(Arc::clone(&daemon), stream));
            }
            Err(e) => eprintln!("apex-daemon: could not accept a connection: {e}"),
        }
    }
}
