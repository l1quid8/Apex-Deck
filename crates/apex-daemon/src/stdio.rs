//! `--stdio`: one protocol session on stdin and stdout, for SSH. When a
//! daemon is running on the data folder this attaches to it through its
//! socket, so work goes on after the connection drops; otherwise it runs the
//! host here until the connection closes.

use std::fs::File;
use std::os::fd::{FromRawFd, RawFd};
use std::path::PathBuf;
use std::sync::Arc;

use apex_host::lock::{DataLock, LockError};
use apex_host::{Host, HostPaths};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::protocol::{self, Daemon, Trust};
use crate::{identity, paths, serve};

pub fn run(data_dir: Option<PathBuf>, attach: bool) -> Result<(), String> {
    let paths = paths::host_paths(data_dir)?;
    let (stdin, stdout) = take_stdio().map_err(|e| format!("could not set up stdin/stdout: {e}"))?;
    let socket = paths.data.join(serve::SOCKET);
    if let Ok(daemon) = std::os::unix::net::UnixStream::connect(&socket) {
        return relay(daemon, stdin, stdout);
    }
    if attach {
        return Err(format!(
            "no apex-daemon is running for {}; start one with `apex-daemon serve` (on a server: sudo systemctl enable --now apex-daemon@$USER)",
            paths.data.display()
        ));
    }
    let lock = match DataLock::acquire(&paths.data, &format!("apex-daemon --stdio (pid {})", std::process::id())) {
        Ok(lock) => lock,
        Err(LockError::Held { owner }) => {
            return Err(format!("{} is in use by {owner}, which takes no connections; quit it first", paths.data.display()));
        }
        Err(e) => return Err(e.to_string()),
    };
    run_in_process(paths, lock, stdin, stdout)
}

/// Copy bytes between stdin/stdout and the daemon's socket until either
/// side closes. The daemon does all the protocol work.
fn relay(daemon: std::os::unix::net::UnixStream, stdin: File, stdout: File) -> Result<(), String> {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
    runtime.block_on(async {
        daemon.set_nonblocking(true).map_err(|e| e.to_string())?;
        let (mut from_daemon, mut to_daemon) = tokio::net::UnixStream::from_std(daemon).map_err(|e| e.to_string())?.into_split();
        let (mut stdin, mut stdout) = (tokio::fs::File::from_std(stdin), tokio::fs::File::from_std(stdout));
        let up = async {
            let mut buffer = vec![0u8; 64 * 1024];
            while let Ok(n @ 1..) = stdin.read(&mut buffer).await {
                if to_daemon.write_all(&buffer[..n]).await.is_err() {
                    break;
                }
            }
            // The client is done sending; the daemon answers what's under way, then closes.
            let _ = to_daemon.shutdown().await;
            std::future::pending::<()>().await
        };
        let down = async {
            let mut buffer = vec![0u8; 64 * 1024];
            while let Ok(n @ 1..) = from_daemon.read(&mut buffer).await {
                if stdout.write_all(&buffer[..n]).await.is_err() || stdout.flush().await.is_err() {
                    break;
                }
            }
        };
        tokio::select! {
            _ = up => {}
            _ = down => {}
        }
        Ok::<(), String>(())
    })?;
    // A read of stdin may still be parked on a blocking thread; don't wait for it.
    runtime.shutdown_background();
    Ok(())
}

/// Run the host in this process and serve stdin/stdout until the client
/// leaves. Logs go to stderr only.
fn run_in_process(paths: HostPaths, _lock: DataLock, stdin: File, stdout: File) -> Result<(), String> {
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().map_err(|e| e.to_string())?;
    runtime.block_on(async {
        let host = Host::new(paths.clone(), tokio::runtime::Handle::current());
        let daemon = Arc::new(Daemon { host: Arc::clone(&host), host_id: identity::host_id(&paths.data)?, boot_id: identity::boot_id(), token: None });
        eprintln!("apex-daemon: running the host in this process; its work stops when this connection closes");
        let (input, output) = protocol::lines(tokio::fs::File::from_std(stdin), tokio::fs::File::from_std(stdout));
        protocol::serve(daemon, Trust::Local, input, output).await;
        host.shutdown();
        Ok::<(), String>(())
    })?;
    runtime.shutdown_background();
    Ok(())
}

/// Keep the real stdin and stdout for the protocol, and point fd 0 at
/// /dev/null and fd 1 at stderr for everything else. Programs the host
/// starts with inherited stdio (the opener behind `open_target`, say) and
/// any stray print then can't write into the protocol or read from it.
pub fn take_stdio() -> std::io::Result<(File, File)> {
    fn check(result: RawFd) -> std::io::Result<RawFd> {
        if result < 0 { Err(std::io::Error::last_os_error()) } else { Ok(result) }
    }
    // SAFETY: plain fd calls; each new fd is owned by exactly one File.
    unsafe {
        let input = File::from_raw_fd(check(libc::fcntl(0, libc::F_DUPFD_CLOEXEC, 3))?);
        let output = File::from_raw_fd(check(libc::fcntl(1, libc::F_DUPFD_CLOEXEC, 3))?);
        let null = File::open("/dev/null")?;
        check(libc::dup2(std::os::fd::AsRawFd::as_raw_fd(&null), 0))?;
        check(libc::dup2(2, 1))?;
        Ok((input, output))
    }
}
