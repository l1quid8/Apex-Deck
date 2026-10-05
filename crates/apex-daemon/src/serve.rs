//! `apex-daemon serve`: run the host and listen for clients, on a
//! token-protected localhost WebSocket and on a socket in the data folder
//! that only this user can reach.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use apex_host::lock::DataLock;
use apex_host::{Host, HostPaths};
use serde_json::json;
use tokio::net::{TcpListener, UnixListener, UnixStream};

use crate::cli::ServeOptions;
use crate::protocol::{self, Daemon, Trust, PROTOCOL};
use crate::{files, identity, paths, signals, websocket};

/// The local socket, inside the data folder.
pub const SOCKET: &str = "daemon.sock";

/// `sun_path` is 104 bytes on macOS and 108 on Linux; stay under both.
const SOCKET_PATH_MAX: usize = 100;

pub fn run(data_dir: Option<PathBuf>, options: ServeOptions) -> Result<(), String> {
    if !options.bind.is_loopback() && !options.insecure_bind {
        return Err(format!(
            "--bind {} would let other machines reach the daemon, which waits for device pairing; pass --insecure-bind to do it anyway (the token still applies)",
            options.bind
        ));
    }
    let paths = paths::host_paths(data_dir)?;
    let socket = socket_path(&paths.data)?;
    private_folder(&paths.data)?;
    let lock = DataLock::acquire(&paths.data, &format!("apex-daemon serve (pid {})", std::process::id()))
        .map_err(|e| format!("{}: {e}", paths.data.display()))?;
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().map_err(|e| e.to_string())?;
    let result = runtime.block_on(serve(paths, socket, options, lock));
    // Sessions of clients still connected end with the runtime.
    runtime.shutdown_background();
    result
}

/// Where the socket goes, if its path is short enough to bind.
pub fn socket_path(data: &Path) -> Result<PathBuf, String> {
    let socket = data.join(SOCKET);
    if socket.as_os_str().len() > SOCKET_PATH_MAX {
        return Err(format!("the socket path {} is longer than {SOCKET_PATH_MAX} bytes; pass a shorter --data-dir", socket.display()));
    }
    Ok(socket)
}

/// Make `data` if needed and let only this user into it.
fn private_folder(data: &Path) -> Result<(), String> {
    std::fs::create_dir_all(data).map_err(|e| format!("could not create {}: {e}", data.display()))?;
    std::fs::set_permissions(data, std::fs::Permissions::from_mode(0o700)).map_err(|e| format!("could not make {} private: {e}", data.display()))
}

async fn serve(paths: HostPaths, socket: PathBuf, options: ServeOptions, _lock: DataLock) -> Result<(), String> {
    let stop = signals::stop_requested()?;
    tokio::pin!(stop);
    let host = Host::new(paths.clone(), tokio::runtime::Handle::current());
    let token = identity::random_hex(32);
    files::write_private(&paths.data.join("daemon-token"), &format!("{token}\n"))?;
    let daemon = Arc::new(Daemon { host, host_id: identity::host_id(&paths.data)?, boot_id: identity::boot_id(), token: Some(token) });

    let listener = TcpListener::bind((options.bind, options.port)).await.map_err(|e| format!("could not listen on {}:{}: {e}", options.bind, options.port))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    // Holding the lock means no live daemon is using a socket left here.
    let _ = std::fs::remove_file(&socket);
    let local = UnixListener::bind(&socket).map_err(|e| format!("could not listen on {}: {e}", socket.display()))?;
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600)).map_err(|e| format!("could not make {} private: {e}", socket.display()))?;
    // Written last: once it exists, the daemon is ready.
    let info = json!({
        "pid": std::process::id(), "port": port, "bind": options.bind.to_string(), "socket": socket.to_string_lossy(),
        "protocol": PROTOCOL, "host_id": daemon.host_id, "boot_id": daemon.boot_id,
    });
    let info_path = paths.data.join("daemon.json");
    files::write_private(&info_path, &info.to_string())?;
    eprintln!("apex-daemon: listening on ws://{}:{port} and {}", options.bind, socket.display());

    loop {
        tokio::select! {
            _ = &mut stop => break,
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => { tokio::spawn(websocket::serve(Arc::clone(&daemon), stream)); }
                Err(e) => eprintln!("apex-daemon: could not accept a WebSocket connection: {e}"),
            },
            accepted = local.accept() => match accepted {
                Ok((stream, _)) => { tokio::spawn(serve_local(Arc::clone(&daemon), stream)); }
                Err(e) => eprintln!("apex-daemon: could not accept a socket connection: {e}"),
            },
        }
    }
    eprintln!("apex-daemon: stopping");
    drop((listener, local));
    let _ = std::fs::remove_file(&socket);
    let _ = std::fs::remove_file(&info_path);
    daemon.host.wind_down(signals::WIND_DOWN).await;
    Ok(())
}

/// A connection on the local socket: the same trust as stdio, for this user only.
async fn serve_local(daemon: Arc<Daemon>, stream: UnixStream) {
    // SAFETY: geteuid has no preconditions.
    let me = unsafe { libc::geteuid() };
    match stream.peer_cred() {
        Ok(peer) if peer.uid() == me => {}
        Ok(peer) => return eprintln!("apex-daemon: refused a socket connection from user {}", peer.uid()),
        Err(e) => return eprintln!("apex-daemon: refused a socket connection whose user is unknown: {e}"),
    }
    let (read, write) = stream.into_split();
    let (input, output) = protocol::lines(read, write);
    protocol::serve(daemon, Trust::Local, input, output).await;
}
