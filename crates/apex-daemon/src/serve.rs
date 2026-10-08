//! `apex-daemon serve`: run the host and listen for clients, on a
//! token-protected localhost WebSocket and on a socket in the data folder
//! that only this user can reach.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use apex_host::lock::DataLock;
use apex_host::HostPaths;
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
    let signalled = signals::stop_requested()?;
    let exit_on_stdin_close = options.exit_on_stdin_close;
    let stdin_closed = async move {
        if exit_on_stdin_close {
            stdin_closes().await
        } else {
            std::future::pending().await
        }
    };
    let stop = async move {
        tokio::select! {
            _ = signalled => {}
            _ = stdin_closed => {}
        }
    };
    tokio::pin!(stop);
    let token = identity::random_hex(32);
    files::write_private(&paths.data.join("daemon-token"), &format!("{token}\n"))?;
    let daemon = Daemon::start(&paths, Some(token))?;

    let listener = TcpListener::bind((options.bind, options.port)).await.map_err(|e| format!("could not listen on {}:{}: {e}", options.bind, options.port))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let remote = start_remote(&daemon, &paths.data, &options).await?;
    // Holding the lock means no live daemon is using a socket left here.
    let _ = std::fs::remove_file(&socket);
    let local = UnixListener::bind(&socket).map_err(|e| format!("could not listen on {}: {e}", socket.display()))?;
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600)).map_err(|e| format!("could not make {} private: {e}", socket.display()))?;
    // Written last: once it exists, the daemon is ready.
    let info = json!({
        "pid": std::process::id(), "port": port, "bind": options.bind.to_string(), "socket": socket.to_string_lossy(),
        "protocol": PROTOCOL, "host_id": daemon.host_id, "boot_id": daemon.boot_id, "remote": remote,
    });
    let info_path = paths.data.join("daemon.json");
    files::write_private(&info_path, &info.to_string())?;
    eprintln!("apex-daemon: listening on ws://{}:{port} and {}", options.bind, socket.display());
    if !remote.is_null() {
        eprintln!("apex-daemon: remote access on as endpoint {} (UDP port {})", remote["endpoint_id"].as_str().unwrap_or_default(), remote["port"]);
    }

    loop {
        tokio::select! {
            _ = &mut stop => break,
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => { tokio::spawn(websocket::serve(Arc::clone(&daemon), stream)); }
                Err(e) => accept_failed("a WebSocket connection", e).await,
            },
            accepted = local.accept() => match accepted {
                Ok((stream, _)) => { tokio::spawn(serve_local(Arc::clone(&daemon), stream)); }
                Err(e) => accept_failed("a socket connection", e).await,
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

/// With `--remote`, start the iroh endpoint and accept paired devices on it.
/// What `daemon.json` says about it, or null when off.
#[cfg(feature = "remote")]
async fn start_remote(daemon: &Arc<Daemon>, data: &Path, options: &ServeOptions) -> Result<serde_json::Value, String> {
    if !options.remote {
        return Ok(serde_json::Value::Null);
    }
    let (endpoint, info) = crate::remote::start(data, options.remote_port).await?;
    // `pair_start` and `remote_info` read it from here.
    let _ = daemon.endpoint.set(endpoint.clone());
    tokio::spawn(crate::remote::accept(Arc::clone(daemon), endpoint));
    Ok(info)
}

#[cfg(not(feature = "remote"))]
async fn start_remote(_daemon: &Arc<Daemon>, _data: &Path, options: &ServeOptions) -> Result<serde_json::Value, String> {
    if options.remote {
        return Err("this apex-daemon was built without remote access (cargo feature `remote`)".into());
    }
    Ok(serde_json::Value::Null)
}

/// Resolves when stdin reaches its end or fails: the app holding the other
/// end quit or died. What it sends is ignored.
async fn stdin_closes() {
    use tokio::io::AsyncReadExt;
    let mut stdin = tokio::io::stdin();
    let mut buffer = [0u8; 1024];
    while matches!(stdin.read(&mut buffer).await, Ok(n) if n > 0) {}
    // The app read our stderr too, and may be gone with it. Writing to a pipe
    // nobody reads fails, and a failed eprintln! panics, which would end the
    // daemon before it stops its agents. What's left to say goes nowhere.
    quiet_stderr();
}

/// Point stderr at /dev/null.
fn quiet_stderr() {
    if let Ok(null) = std::fs::OpenOptions::new().write(true).open("/dev/null") {
        use std::os::fd::AsRawFd;
        // SAFETY: dup2 onto fd 2 only replaces what stderr refers to.
        unsafe { libc::dup2(null.as_raw_fd(), libc::STDERR_FILENO) };
    }
}

/// Log a failed accept and pause, so an error that repeats (out of file
/// descriptors, say) doesn't spin.
async fn accept_failed(what: &str, e: std::io::Error) {
    eprintln!("apex-daemon: could not accept {what}: {e}");
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
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
